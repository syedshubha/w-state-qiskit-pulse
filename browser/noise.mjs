/** Three independent driven qutrits with compiled timing, plus ideal logical CX. */
import {compile, sampleEnvelope} from './engine.mjs';

const QUTRITS = 3;
const LEVELS = 3;
const DIMENSION = LEVELS ** QUTRITS;
const STRIDES = [9, 3, 1];
const LABELS = ['0', '1', 'L'];
const BITS = Array.from({length: DIMENSION}, (_, basis) => STRIDES.map(stride => Math.floor(basis / stride) % LEVELS));
const CHOOSE = [[1], [1, 1], [1, 2, 1]];
const DRIVE_STEPS = 1536;
const density = () => new Float64Array(2 * DIMENSION ** 2);
const index = (row, column) => 2 * (row * DIMENSION + column);

export const DEFAULT_NOISE = Object.freeze({
  t1Us: null,
  t2Us: null,
  anharmonicityMhz: -220,
  leakageEnabled: true,
});

function timeOrInfinity(value, label) {
  if (value === null || value === Infinity) return Infinity;
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(1 / value)) {
    throw new RangeError(`${label} must be positive or infinite.`);
  }
  return value;
}

function noiseRates(settings) {
  const {t1Us, t2Us, anharmonicityMhz, leakageEnabled} = {...DEFAULT_NOISE, ...settings};
  const t1 = timeOrInfinity(t1Us, 'T₁');
  const t2 = timeOrInfinity(t2Us, 'T₂');
  if (Number.isFinite(t2) && t2 > 2 * t1) {
    throw new RangeError('T₂ must be at most twice T₁ for independent relaxation and pure dephasing.');
  }
  if (!Number.isFinite(anharmonicityMhz) || anharmonicityMhz > -40 || anharmonicityMhz < -400) {
    throw new RangeError('Anharmonicity must lie between −400 and −40 MHz.');
  }
  if (typeof leakageEnabled !== 'boolean') throw new TypeError('Leakage must be enabled or disabled.');
  const relaxation = 1 / t1;
  const pureDephasing = Number.isFinite(t2) ? Math.max(0, 1 / t2 - relaxation / 2) : 0;
  return {relaxation, pureDephasing, alpha: 2 * Math.PI * anharmonicityMhz / 1000, leakageEnabled};
}

function multiplyLocal(left, right, output) {
  for (let row = 0; row < LEVELS; row++) {
    for (let column = 0; column < LEVELS; column++) {
      let real = 0;
      let imaginary = 0;
      for (let k = 0; k < LEVELS; k++) {
        const a = 2 * (LEVELS * row + k);
        const b = 2 * (LEVELS * k + column);
        real += left[a] * right[b] - left[a + 1] * right[b + 1];
        imaginary += left[a] * right[b + 1] + left[a + 1] * right[b];
      }
      const offset = 2 * (LEVELS * row + column);
      output[offset] = real;
      output[offset + 1] = imaginary;
    }
  }
}

function idealDrive(angle, phase) {
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  return [c, 0, -s * Math.sin(phase), -s * Math.cos(phase), 0, 0,
    s * Math.sin(phase), -s * Math.cos(phase), c, 0, 0, 0,
    0, 0, 0, 0, 1, 0];
}

const xyShape = Array.from({length: DRIVE_STEPS}, (_, step) => sampleEnvelope({kind:'drive'}, (step + 0.5) / DRIVE_STEPS)[0]);
const xyArea = xyShape.reduce((sum, value) => sum + value, 0);
const B = [0, 1/Math.sqrt(3), 0, 1/Math.sqrt(3), 0, Math.sqrt(2/3), 0, Math.sqrt(2/3), 0];
const BSquared = [1/3, 0, Math.sqrt(2)/3, 0, 1, 0, Math.sqrt(2)/3, 0, 2/3];

/**
 * H/ℏ = α|2⟩⟨2| + Ω(t)(a+a†)/2 at phase zero, on resonance.
 * Strang steps use exact exponentials of drift and drive. The signed area is
 * normalized to the gate angle using the same baseband shape as the timeline.
 */
function driveAtZeroPhase(angle, duration, alpha) {
  let unitary = Float64Array.of(1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0);
  let product = new Float64Array(unitary.length);
  const stepUnitary = new Float64Array(unitary.length);
  const halfDrift = -alpha * duration / (2 * DRIVE_STEPS);
  const driftCos = [1, Math.cos(halfDrift), Math.cos(2 * halfDrift)];
  const driftSin = [0, Math.sin(halfDrift), Math.sin(2 * halfDrift)];
  const angleScale = Math.sqrt(3) * angle / (2 * xyArea);
  for (const shape of xyShape) {
    const stepAngle = angleScale * shape;
    const c = Math.cos(stepAngle) - 1;
    const s = Math.sin(stepAngle);
    for (let row = 0; row < LEVELS; row++) {
      for (let column = 0; column < LEVELS; column++) {
        const cell = LEVELS * row + column;
        const driftCount = Number(row === 2) + Number(column === 2);
        const real = Number(row === column) + c * BSquared[cell];
        const imaginary = -s * B[cell];
        stepUnitary[2 * cell] = real * driftCos[driftCount] - imaginary * driftSin[driftCount];
        stepUnitary[2 * cell + 1] = real * driftSin[driftCount] + imaginary * driftCos[driftCount];
      }
    }
    multiplyLocal(stepUnitary, unitary, product);
    [unitary, product] = [product, unitary];
  }
  return unitary;
}

function phasedDrive(unitary, phase) {
  const result = new Float64Array(unitary.length);
  for (let row = 0; row < LEVELS; row++) {
    for (let column = 0; column < LEVELS; column++) {
      const cell = 2 * (LEVELS * row + column);
      const angle = phase * (row - column);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      result[cell] = c * unitary[cell] - s * unitary[cell + 1];
      result[cell + 1] = s * unitary[cell] + c * unitary[cell + 1];
    }
  }
  return result;
}

function transformLocal(state, qubit, unitary) {
  const stride = STRIDES[qubit];
  const result = density();
  // (U⊗I)ρ(U†⊗I) in the fixed q0 q1 q2 basis.
  for (let row = 0; row < DIMENSION; row++) {
    const inputRow = BITS[row][qubit];
    for (let column = 0; column < DIMENSION; column++) {
      const source = index(row, column);
      const real = state[source];
      const imaginary = state[source + 1];
      if (real === 0 && imaginary === 0) continue;
      const inputColumn = BITS[column][qubit];
      for (let r = 0; r < LEVELS; r++) {
        const left = 2 * (LEVELS * r + inputRow);
        if (unitary[left] === 0 && unitary[left + 1] === 0) continue;
        const leftReal = unitary[left] * real - unitary[left + 1] * imaginary;
        const leftImaginary = unitary[left] * imaginary + unitary[left + 1] * real;
        for (let c = 0; c < LEVELS; c++) {
          const right = 2 * (LEVELS * c + inputColumn);
          const target = index(row + (r - inputRow) * stride, column + (c - inputColumn) * stride);
          result[target] += leftReal * unitary[right] + leftImaginary * unitary[right + 1];
          result[target + 1] += leftImaginary * unitary[right] - leftReal * unitary[right + 1];
        }
      }
    }
  }
  return result;
}

function phaseLocal(state, qubit, phase1, phase2) {
  const result = density();
  const phase = [0, phase1, phase2];
  const factors = phase.map(m => phase.map(n => [Math.cos(m - n), Math.sin(m - n)]));
  for (let row = 0; row < DIMENSION; row++) {
    const m = BITS[row][qubit];
    for (let column = 0; column < DIMENSION; column++) {
      const [c, s] = factors[m][BITS[column][qubit]];
      const cell = index(row, column);
      result[cell] = c * state[cell] - s * state[cell + 1];
      result[cell + 1] = s * state[cell] + c * state[cell + 1];
    }
  }
  return result;
}

function cxPermutation(control, target) {
  return BITS.map((digits, basis) => {
    // A block diagonal extension: CX on {|0>, |1>}² and identity otherwise.
    if (digits[control] !== 1 || digits[target] === 2) return basis;
    return basis + (1 - 2 * digits[target]) * STRIDES[target];
  });
}

function permute(state, permutation) {
  const result = density();
  for (let row = 0; row < DIMENSION; row++) {
    for (let column = 0; column < DIMENSION; column++) {
      const source = index(row, column);
      const target = index(permutation[row], permutation[column]);
      result[target] = state[source];
      result[target + 1] = state[source + 1];
    }
  }
  return result;
}

function dampingCoefficients(durationNs, relaxation, pureDephasing) {
  const durationUs = durationNs / 1000;
  const eta = Math.exp(-durationUs * relaxation);
  const lost = -Math.expm1(-durationUs * relaxation);
  // Exact pure loss generated by a at rate 1/T1 and phase decay generated
  // by n at rate 2(1/T2 - 1/(2T1)). Both channels preserve trace.
  return CHOOSE.map((mChoose, m) => CHOOSE.map((nChoose, n) => {
    const dephasing = Math.exp(-durationUs * pureDephasing * (m - n) ** 2);
    return Array.from({length: Math.min(m, n) + 1}, (_, jump) =>
      dephasing * Math.sqrt(mChoose[jump] * nChoose[jump]) * lost ** jump * eta ** ((m + n) / 2 - jump));
  }));
}

function dampLocal(state, qubit, coefficients) {
  const result = density();
  const stride = STRIDES[qubit];
  for (let row = 0; row < DIMENSION; row++) {
    const m = BITS[row][qubit];
    for (let column = 0; column < DIMENSION; column++) {
      const source = index(row, column);
      const real = state[source];
      const imaginary = state[source + 1];
      if (real === 0 && imaginary === 0) continue;
      const weights = coefficients[m][BITS[column][qubit]];
      for (let jump = 0; jump < weights.length; jump++) {
        const cell = index(row - jump * stride, column - jump * stride);
        result[cell] += real * weights[jump];
        result[cell + 1] += imaginary * weights[jump];
      }
    }
  }
  return result;
}

function transformBranches(branches, transform) {
  for (const [record, state] of branches) branches.set(record, transform(state));
}

function measure(branches, qubit) {
  const result = new Map();
  const stride = STRIDES[qubit];
  for (const [record, state] of branches) {
    for (let row = 0; row < DIMENSION; row++) {
      const outcome = BITS[row][qubit];
      const nextRecord = record + (outcome - BITS[record][qubit]) * stride;
      for (let column = 0; column < DIMENSION; column++) {
        if (BITS[column][qubit] !== outcome) continue;
        const cell = index(row, column);
        if (state[cell] === 0 && state[cell + 1] === 0) continue;
        if (!result.has(nextRecord)) result.set(nextRecord, density());
        const branch = result.get(nextRecord);
        branch[cell] += state[cell];
        branch[cell + 1] += state[cell + 1];
      }
    }
  }
  return result;
}

function summarize(branches, measured, duration) {
  const probabilities = Array(2 ** QUTRITS).fill(0);
  const perQubitLeakage = Array(QUTRITS).fill(0);
  const records = new Map();
  let leakage = 0;
  if (measured.length) {
    for (let bits = 0; bits < 2 ** measured.length; bits++) {
      records.set(bits.toString(2).padStart(measured.length, '0'), 0);
    }
  }
  for (const [record, state] of branches) {
    let branchProbability = 0;
    for (let basis = 0; basis < DIMENSION; basis++) {
      const population = state[index(basis, basis)];
      branchProbability += population;
      const digits = BITS[basis];
      if (digits.includes(2)) {
        leakage += population;
        digits.forEach((digit, qubit) => { if (digit === 2) perQubitLeakage[qubit] += population; });
      } else {
        probabilities[4 * digits[0] + 2 * digits[1] + digits[2]] += population;
      }
    }
    if (measured.length && branchProbability > 0) {
      const bits = measured.map(qubit => LABELS[BITS[record][qubit]]).join('');
      records.set(bits, (records.get(bits) ?? 0) + branchProbability);
    }
  }
  const outcomes = [...records].map(([bits, probability]) => ({bits, probability})).sort((a, b) => a.bits.localeCompare(b.bits));
  const readoutLeakage = outcomes.reduce((sum, outcome) => sum + (outcome.bits.includes('L') ? outcome.probability : 0), 0);
  return {probabilities, leakage, perQubitLeakage, measured, outcomes, readoutLeakage, duration};
}

/**
 * The single-wire gates run in the current logical frame. Virtual Z enters as
 * exp(iθn), which equals the qubit Rz up to global phase. CX uses its logical
 * permutation and full compiled duration. Its local echo pulses do not run a
 * second time here. Idle |2⟩ phases accumulate through the end of every column.
 * Each column's full elapsed time applies independent Markov loss/dephasing
 * exactly once to all three wires, after coherent gates and before readout.
 */
export function simulateNoisy(operations, settings = {}) {
  const {events, columns, duration} = compile(operations);
  const {relaxation, pureDephasing, alpha, leakageEnabled} = noiseRates(settings);
  const measured = new Set();
  const initial = density();
  initial[0] = 1;
  let branches = new Map([[0, initial]]);
  const driveCache = new Map();
  const steps = new Map(columns.map(column => [column.column, {operations:[], events:[]}]));
  for (const operation of operations) steps.get(operation.column).operations.push(operation);
  for (const event of events) steps.get(event.column).events.push(event);

  for (const column of columns) {
    const step = steps.get(column.column);
    const drivenDuration = [0, 0, 0];
    for (const {gate, control, target} of step.operations) {
      if (gate !== 'CX') continue;
      const permutation = cxPermutation(control, target);
      transformBranches(branches, state => permute(state, permutation));
    }
    for (const event of step.events) {
      if (event.gate === 'CX') continue;
      const qubit = event.qubit;
      if (event.kind === 'frame') {
        transformBranches(branches, state => phaseLocal(state, qubit, event.angle, 2 * event.angle));
      } else if (event.kind === 'drive') {
        drivenDuration[qubit] += event.duration;
        let unitary;
        if (leakageEnabled) {
          const key = `${event.angle},${event.duration}`;
          if (!driveCache.has(key)) driveCache.set(key, driveAtZeroPhase(event.angle, event.duration, alpha));
          unitary = phasedDrive(driveCache.get(key), event.logicalPhase);
        } else {
          unitary = idealDrive(event.angle, event.logicalPhase);
        }
        transformBranches(branches, state => transformLocal(state, qubit, unitary));
      }
    }
    if (column.duration > 0) {
      const damp = relaxation > 0 || pureDephasing > 0;
      const coefficients = damp ? dampingCoefficients(column.duration, relaxation, pureDephasing) : null;
      for (let qubit = 0; qubit < QUTRITS; qubit++) {
        const idle = column.duration - drivenDuration[qubit];
        if (leakageEnabled && idle > 0) transformBranches(branches, state => phaseLocal(state, qubit, 0, -alpha * idle));
        if (damp) transformBranches(branches, state => dampLocal(state, qubit, coefficients));
      }
    }
    for (const {gate, target} of step.operations) {
      if (gate !== 'M') continue;
      measured.add(target);
      branches = measure(branches, target);
    }
  }
  return summarize(branches, [...measured].sort(), duration);
}
