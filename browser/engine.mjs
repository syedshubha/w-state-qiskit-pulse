const PI = Math.PI;
const QUBITS = 3;
const DIMENSION = 2 ** QUBITS;
const XY_NS = 32;
const CR_NS = 96;
const READOUT_NS = 320;
const ACQUIRE_DELAY_NS = 64;

export const GATES = Object.freeze({
  H: {label: 'H', name: 'Hadamard', description: 'Apply a virtual Z rotation, then a quarter-turn about Y.'},
  X: {label: 'X', name: 'Pauli X', description: 'Rotate by π about X with a microwave drive.'},
  Y: {label: 'Y', name: 'Pauli Y', description: 'Rotate by π about Y with a microwave drive in quadrature.'},
  Z: {label: 'Z', name: 'Pauli Z', description: 'Shift the rotating reference frame by π without a microwave pulse.'},
  CX: {label: 'CX', name: 'Controlled X', description: 'Use two echoed ZX segments and local rotations on neighboring transmons.'},
  M: {label: 'M', name: 'Measure', description: 'Apply a readout tone and acquire the resonator response.'},
  RY: {label: 'Ry', name: 'Y rotation', description: 'Rotate by a continuously adjustable angle about Y.'},
});

function example(name, gates) {
  return Object.freeze(gates.map(([gate, column, target, extra], index) => Object.freeze({
    id: `${name}-${index + 1}`, gate, column, target, ...extra,
  })));
}

const measureAll = column => [['M', column, 0], ['M', column, 1], ['M', column, 2]];

export const PRESETS = Object.freeze({
  w: example('w', [
    ['RY', 0, 0, {angle: 2 * Math.acos(1 / Math.sqrt(3))}],
    ['RY', 0, 1, {angle: PI / 4}],
    ['CX', 1, 1, {control: 0}],
    ['RY', 2, 1, {angle: -PI / 4}],
    ['CX', 3, 2, {control: 1}],
    ['CX', 4, 1, {control: 0}],
    ['X', 5, 0],
    ...measureAll(6),
  ]),
  bell: example('bell', [
    ['H', 0, 0],
    ['CX', 1, 1, {control: 0}],
    ...measureAll(2),
  ]),
  phase: example('phase', [
    ['H', 0, 0],
    ['Z', 1, 0],
    ['H', 2, 0],
    ['M', 3, 0],
  ]),
  empty: Object.freeze([]),
});

const validQubit = qubit => Number.isInteger(qubit) && qubit >= 0 && qubit < QUBITS;
const ordered = operations => [...operations].sort((a, b) => a.column - b.column || a.target - b.target);

export function validate(operations) {
  if (!Array.isArray(operations)) throw new Error('A circuit must be an array of gates.');
  const ids = new Set();
  const occupied = new Set();
  for (const operation of operations) {
    if (!operation || !Object.hasOwn(GATES, operation.gate)) throw new Error('Choose a supported gate.');
    const {id, gate, column, target, control, angle} = operation;
    if ((typeof id !== 'string' || !id) && !Number.isSafeInteger(id)) throw new Error('Every gate needs an identifier.');
    if (ids.has(String(id))) throw new Error('Every gate needs a unique identifier.');
    ids.add(String(id));
    if (!Number.isSafeInteger(column) || column < 0 || !validQubit(target)) throw new Error('Choose a valid circuit cell.');
    if (gate === 'CX' && (!validQubit(control) || Math.abs(control - target) !== 1)) {
      throw new Error('CX requires two neighboring qubits.');
    }
    if (gate === 'RY' && (!Number.isFinite(angle) || Math.abs(angle) > 2 * PI)) {
      throw new Error('Enter a Y rotation angle between −360° and 360°.');
    }
    for (const qubit of gate === 'CX' ? [control, target] : [target]) {
      const cell = `${column}:${qubit}`;
      if (occupied.has(cell)) throw new Error(`Q${qubit} already has a gate in step ${column + 1}.`);
      occupied.add(cell);
    }
  }
}

function wrappedPhase(phase) {
  const wrapped = Math.atan2(Math.sin(phase), Math.cos(phase));
  return Math.abs(wrapped) < 1e-12 ? 0 : wrapped;
}

function compileGate(operation, start, frames) {
  const {id, gate, column, target, control, angle} = operation;
  const events = [];
  let time = start;

  function emit(channel, kind, duration, label, metadata = {}) {
    events.push({
      id: `${id}:${events.length + 1}`, gateId: id, gate, column, target, control,
      channel, kind, start: time, duration, label, ...metadata,
    });
  }

  function frame(qubit, rotation, label) {
    const previousFrame = frames[qubit];
    frames[qubit] = wrappedPhase(previousFrame + rotation);
    emit(`d${qubit}`, 'frame', 0, label, {qubit, angle: rotation, frame: frames[qubit], previousFrame});
  }

  function drive(qubit, rotation, logicalPhase, label) {
    const intervals = Math.max(1, Math.ceil(Math.abs(rotation) / PI));
    const duration = intervals * XY_NS;
    emit(`d${qubit}`, 'drive', duration, label, {
      qubit,
      angle: rotation,
      logicalPhase,
      phase: wrappedPhase(logicalPhase - frames[qubit]),
      frame: frames[qubit],
      amplitude: rotation / (intervals * PI),
    });
    time += duration;
  }

  function interaction(rotation, label) {
    const edge = [control, target].sort().join('');
    emit(`cr${edge}`, 'interaction', CR_NS, label, {
      qubit: control,
      angle: rotation,
      logicalPhase: 0,
      phase: wrappedPhase(-frames[target]),
      frame: frames[target],
      amplitude: rotation / (PI / 4),
    });
    time += CR_NS;
  }

  switch (gate) {
    case 'H':
      frame(target, PI, 'Virtual Rz(π)');
      drive(target, PI / 2, PI / 2, 'Ry(π/2)');
      break;
    case 'X':
      drive(target, PI, 0, 'Rx(π)');
      break;
    case 'Y':
      drive(target, PI, PI / 2, 'Ry(π)');
      break;
    case 'Z':
      frame(target, PI, 'Virtual Rz(π)');
      break;
    case 'CX':
      interaction(PI / 4, 'CR +π/4');
      drive(control, PI, 0, 'Control Rx(π)');
      interaction(-PI / 4, 'CR −π/4');
      drive(control, PI, 0, 'Control Rx(π)');
      drive(target, -PI / 2, 0, 'Target Rx(−π/2)');
      frame(control, -PI / 2, 'Control virtual Rz(−π/2)');
      break;
    case 'M':
      emit(`r${target}`, 'readout', READOUT_NS, 'Readout tone', {
        qubit: target, phase: 0, amplitude: 0.72,
      });
      time += ACQUIRE_DELAY_NS;
      emit(`a${target}`, 'acquire', READOUT_NS - ACQUIRE_DELAY_NS, 'Acquire', {qubit: target});
      time += READOUT_NS - ACQUIRE_DELAY_NS;
      break;
    case 'RY':
      drive(target, angle, PI / 2, 'Ry(θ)');
      break;
  }
  return {events, duration: time - start};
}

/** Each occupied column starts together, then the next column waits for its slowest gate. */
export function compile(operations) {
  validate(operations);
  const events = [];
  const columns = [];
  const frames = Array(QUBITS).fill(0);
  let start = 0;
  let currentColumn;
  for (const operation of ordered(operations)) {
    if (operation.column !== currentColumn?.column) {
      start += currentColumn?.duration ?? 0;
      currentColumn = {column: operation.column, start, duration: 0};
      columns.push(currentColumn);
    }
    const scheduled = compileGate(operation, start, frames);
    events.push(...scheduled.events);
    currentColumn.duration = Math.max(currentColumn.duration, scheduled.duration);
  }
  return {
    events: events.sort((a, b) => a.start - b.start),
    duration: start + (currentColumn?.duration ?? 0),
    columns,
  };
}

/** Normalized I/Q baseband envelopes. The acquisition lane uses a unit window. */
export function sampleEnvelope(event, fraction) {
  if (fraction < 0 || fraction > 1 || event.kind === 'frame') return [0, 0];
  if (event.kind === 'acquire') return [1, 0];
  let shape;
  if (event.kind === 'readout') {
    const edge = Math.min(fraction, 1 - fraction, 0.12);
    shape = 0.5 * (1 - Math.cos(PI * edge / 0.12));
  } else {
    const edge = Math.exp(-4.5);
    shape = (Math.exp(-18 * (fraction - 0.5) ** 2) - edge) / (1 - edge);
  }
  const amplitude = (event.amplitude ?? 1) * shape;
  const phase = event.phase ?? 0;
  return [amplitude * Math.cos(phase), amplitude * Math.sin(phase)];
}

const mask = qubit => 1 << (QUBITS - 1 - qubit);
const densityIndex = (row, column) => 2 * (row * DIMENSION + column);
const basisEntries = Array.from({length: DIMENSION}, (_, index) => index);
function emptyDensity() {
  return new Float64Array(2 * DIMENSION * DIMENSION);
}

function oneQubitUnitary(gate, angle) {
  // Indexed by input bit, followed by [output bit, real amplitude, imaginary amplitude].
  const s = Math.SQRT1_2;
  switch (gate) {
    case 'H': return [[[0, s, 0], [1, s, 0]], [[0, s, 0], [1, -s, 0]]];
    case 'X': return [[[1, 1, 0]], [[0, 1, 0]]];
    case 'Y': return [[[1, 0, 1]], [[0, 0, -1]]];
    case 'Z': return [[[0, 1, 0]], [[1, -1, 0]]];
    case 'RY': {
      const cosine = Math.cos(angle / 2);
      const sine = Math.sin(angle / 2);
      return [[[0, cosine, 0], [1, sine, 0]], [[0, -sine, 0], [1, cosine, 0]]];
    }
  }
}

function basisAction(operation) {
  const {gate, target, control, angle} = operation;
  const bit = mask(target);
  if (gate === 'CX') {
    const controlBit = mask(control);
    return basisEntries.map(index => [[(index & controlBit) ? index ^ bit : index, 1, 0]]);
  }
  const unitary = oneQubitUnitary(gate, angle);
  return basisEntries.map(index => unitary[Number(Boolean(index & bit))].map(([output, real, imaginary]) => [
    (index & ~bit) | (output ? bit : 0), real, imaginary,
  ]));
}

function evolve(density, action) {
  const result = emptyDensity();
  for (const row of basisEntries) {
    for (const column of basisEntries) {
      const index = densityIndex(row, column);
      const real = density[index];
      const imaginary = density[index + 1];
      if (real === 0 && imaginary === 0) continue;
      for (const [outputRow, leftReal, leftImaginary] of action[row]) {
        const productReal = leftReal * real - leftImaginary * imaginary;
        const productImaginary = leftReal * imaginary + leftImaginary * real;
        for (const [outputColumn, rightReal, rightImaginary] of action[column]) {
          const outputIndex = densityIndex(outputRow, outputColumn);
          result[outputIndex] += productReal * rightReal + productImaginary * rightImaginary;
          result[outputIndex + 1] += productImaginary * rightReal - productReal * rightImaginary;
        }
      }
    }
  }
  return result;
}

function measure(branches, qubit) {
  const bit = mask(qubit);
  const result = new Map();
  for (const [record, density] of branches) {
    for (const row of basisEntries) {
      const outcome = row & bit;
      const nextRecord = (record & ~bit) | outcome;
      if (!result.has(nextRecord)) result.set(nextRecord, emptyDensity());
      const projected = result.get(nextRecord);
      for (const column of basisEntries) {
        if ((column & bit) !== outcome) continue;
        const index = densityIndex(row, column);
        projected[index] += density[index];
        projected[index + 1] += density[index + 1];
      }
    }
  }
  return result;
}

function measuredBits(record, qubits) {
  return qubits.map(qubit => (record & mask(qubit)) ? '1' : '0').join('');
}

/** Ideal gates and projective measurements. Each qubit retains its most recent classical bit. */
export function simulate(operations) {
  validate(operations);
  const initial = emptyDensity();
  initial[0] = 1;
  let branches = new Map([[0, initial]]);
  const measuredQubits = new Set();
  for (const operation of ordered(operations)) {
    if (operation.gate === 'M') {
      measuredQubits.add(operation.target);
      branches = measure(branches, operation.target);
    } else {
      const action = basisAction(operation);
      branches = new Map([...branches].map(([record, state]) => [record, evolve(state, action)]));
    }
  }
  const probabilities = Array(DIMENSION).fill(0);
  const measured = [...measuredQubits].sort();
  const outcomes = [];
  for (const [record, density] of branches) {
    let probability = 0;
    for (const basis of basisEntries) {
      const population = density[densityIndex(basis, basis)];
      probabilities[basis] += population;
      probability += population;
    }
    if (measured.length) outcomes.push({bits: measuredBits(record, measured), probability});
  }
  return {probabilities, measured, outcomes: outcomes.sort((a, b) => a.bits.localeCompare(b.bits))};
}
