import {GATES, PRESETS, compile, simulate, sampleEnvelope, validate} from './engine.mjs';

const byId = id => document.getElementById(id);
const make = (tag, className, content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};
const button = (className, content) => {
  const element = make('button', className, content);
  element.type = 'button';
  return element;
};
const svgNS = 'http://www.w3.org/2000/svg';
const qubits = [0, 1, 2];
const channels = [
  ['d0', 'Drive q₀'], ['d1', 'Drive q₁'], ['d2', 'Drive q₂'],
  ['cr01', 'Coupling 0–1'], ['cr12', 'Coupling 1–2'],
  ['r0', 'Readout q₀'], ['r1', 'Readout q₁'], ['r2', 'Readout q₂'],
  ['a0', 'Acquire q₀'], ['a1', 'Acquire q₁'], ['a2', 'Acquire q₂'],
];
const channelLabel = Object.fromEntries(channels);
const qLabel = qubit => `q${qubit}`;
const degrees = value => `${Number((value * 180 / Math.PI).toFixed(2))}°`;
const percent = fraction => `${(fraction * 100).toFixed(1)}%`;
const basisLabel = index => index.toString(2).padStart(3, '0');
const presetNotes = {
  w: 'The W-state preset has one excitation shared equally across the three wires.',
  bell: 'The first two wires share a Bell pair. The third stays in |0⟩.',
  phase: 'The middle Z is a frame update. The last H turns its relative phase into a bit flip.',
};

const palette = byId('palette');
const grid = byId('circuit-grid');
const timeline = byId('timeline');
const inspector = byId('inspector-body');
const themeToggle = byId('theme-toggle');
const scrub = byId('scrub');
const play = byId('play');
const status = byId('editor-status');
const presetButtons = [...document.querySelectorAll('[data-preset]')];
const viewButtons = [...document.querySelectorAll('[data-view]')];

let operations = PRESETS.w;
let preset = 'w';
let sequence = 0;
let tool = 'inspect';
let selected = operations[0].id;
let pickedEvent = null;
let pendingControl = null;
let focusSlot = {column: 0, qubit: 0};
let result;
let schedule;
let leakage;
let view = 'state';
let history = [];
let time = 0;
let animation = 0;

function announce(message = '', error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function toolPrompt() {
  if (pendingControl) return `Select a neighboring target in step ${pendingControl.column + 1}.`;
  if (tool === 'CX') return 'Choose the control, then a neighboring target in the same step.';
  if (tool === 'inspect') return 'Select a gate to see its pulses below.';
  return `Choose an empty slot for ${GATES[tool].name}.`;
}

function updateControls() {
  for (const item of palette.children) item.setAttribute('aria-pressed', String(item.dataset.tool === tool));
  for (const item of presetButtons) item.setAttribute('aria-pressed', String(item.dataset.preset === preset));
  const selectedOperation = operations.find(operation => operation.id === selected);
  const editsAngle = tool === 'inspect' && selectedOperation?.gate === 'RY';
  const angleInput = byId('angle');
  byId('angle-control').hidden = tool !== 'RY' && !editsAngle;
  byId('angle-apply').hidden = !editsAngle;
  if (editsAngle && document.activeElement !== angleInput) {
    angleInput.value = Number((selectedOperation.angle * 180 / Math.PI).toFixed(5));
  }
  byId('undo').disabled = history.length === 0;
  byId('remove').disabled = selectedOperation === undefined;
}

function selectTool(next) {
  if (next === 'RY' && tool !== 'RY') byId('angle').value = '90';
  tool = next;
  pendingControl = null;
  updateControls();
  renderCircuit();
  announce(toolPrompt());
}

function circuitCell(qubit, column) {
  return operations.find(operation => operation.column === column && (operation.target === qubit || operation.control === qubit));
}

function renderCircuit(restoreFocus = false) {
  const occupied = operations.reduce((last, operation) => Math.max(last, operation.column), -1);
  const count = Math.min(24, Math.max(8, occupied + 2));
  focusSlot.column = Math.min(focusSlot.column, count - 1);
  grid.style.setProperty('--columns', count);
  grid.replaceChildren();
  for (let column = 0; column < count; column += 1) {
    const label = make('span', 'column-number', column + 1);
    label.style.gridArea = `1 / ${column + 2}`;
    label.setAttribute('aria-hidden', 'true');
    grid.append(label);
  }
  for (const qubit of qubits) {
    const wire = make('span', 'wire-name', 'q');
    wire.append(make('sub', '', qubit));
    const line = make('span', 'wire-line');
    wire.style.gridArea = `${qubit + 2} / 1`;
    line.style.gridRow = qubit + 2;
    line.setAttribute('aria-hidden', 'true');
    grid.append(wire, line);
    for (let column = 0; column < count; column += 1) {
      const operation = circuitCell(qubit, column);
      const slot = button('slot');
      const pending = pendingControl?.qubit === qubit && pendingControl.column === column;
      slot.style.gridArea = `${qubit + 2} / ${column + 2}`;
      slot.dataset.qubit = qubit;
      slot.dataset.column = column;
      slot.tabIndex = focusSlot.column === column && focusSlot.qubit === qubit ? 0 : -1;
      if (operation || pending) {
        const gate = operation?.gate ?? 'CX';
        const role = operation?.control === qubit || pending ? 'control' : 'target';
        const label = gate === 'CX' ? `Controlled X ${role}` : GATES[gate].name;
        const content = gate === 'CX' ? (role === 'control' ? '' : '+') : GATES[gate].label;
        const style = pending ? 'control pending' : (gate === 'CX' ? role : (gate === 'M' ? 'measure' : ''));
        slot.append(make('span', `gate-chip ${style}`, content));
        slot.setAttribute('aria-label', `${qLabel(qubit)}, step ${column + 1}, ${pending ? 'pending control' : label}`);
        slot.setAttribute('aria-pressed', String(operation?.id === selected));
        slot.classList.toggle('is-selected', operation?.id === selected);
      } else {
        slot.append(make('span', 'slot-add', '+'));
        slot.setAttribute('aria-label', `${qLabel(qubit)}, step ${column + 1}, empty`);
      }
      slot.firstElementChild.setAttribute('aria-hidden', 'true');
      grid.append(slot);
    }
  }
  for (const operation of operations.filter(item => item.gate === 'CX')) {
    const line = make('span', 'cx-link');
    const start = Math.min(operation.control, operation.target) + 2;
    line.style.gridArea = `${start} / ${operation.column + 2} / ${start + 2}`;
    line.setAttribute('aria-hidden', 'true');
    grid.append(line);
  }
  if (restoreFocus) grid.querySelector('.slot[tabindex="0"]')?.focus({preventScroll: true});
}

function chooseGate(id, eventId = null) {
  selected = id;
  pickedEvent = eventId;
  updateControls();
  renderCircuit(grid.contains(document.activeElement));
  highlightSchedule();
  renderInspector();
}

function changeCircuit(next, nextPreset, nextSelected) {
  validate(next);
  history = [...history.slice(-49), {operations, preset, selected}];
  operations = next;
  preset = nextPreset;
  selected = nextSelected;
  pickedEvent = null;
  pendingControl = null;
  refresh();
}

function addGate(column, qubit, control) {
  const operation = {id: `custom-${++sequence}`, gate: tool, column, target: qubit};
  if (control !== undefined) operation.control = control;
  if (tool === 'RY') operation.angle = byId('angle').valueAsNumber * Math.PI / 180;
  try {
    changeCircuit([...operations, operation], null, operation.id);
    announce(`${GATES[tool].name} added in step ${column + 1}.`);
  } catch (error) {
    announce(error.message, true);
    return;
  }
  grid.querySelector('.slot[tabindex="0"]')?.focus({preventScroll: true});
}

function activateSlot(column, qubit) {
  focusSlot = {column, qubit};
  const operation = circuitCell(qubit, column);
  if (tool === 'CX' && pendingControl) {
    if (column === pendingControl.column && qubit === pendingControl.qubit) {
      pendingControl = null;
      renderCircuit(true);
      announce(toolPrompt());
    } else if (column !== pendingControl.column || Math.abs(qubit - pendingControl.qubit) !== 1 || operation) {
      announce('Choose a free neighboring wire in the same step.', true);
    } else {
      addGate(column, qubit, pendingControl.qubit);
    }
    return;
  }
  if (operation) {
    if (tool !== 'inspect') selectTool('inspect');
    chooseGate(operation.id);
    grid.querySelector('.slot[tabindex="0"]')?.focus({preventScroll: true});
    announce('Gate selected. Its instructions are highlighted in the schedule.');
    return;
  }
  if (tool === 'inspect') {
    renderCircuit(true);
    announce('Choose a gate from the palette to fill this slot.');
  } else if (tool === 'CX') {
    pendingControl = {column, qubit};
    renderCircuit(true);
    announce(toolPrompt());
  } else {
    addGate(column, qubit);
  }
}

function removeSelected() {
  if (!selected) return;
  changeCircuit(operations.filter(operation => operation.id !== selected), null, null);
  announce('Gate removed.');
}

function renderOutcomes() {
  if (result.measured.length === 0) view = 'state';
  for (const item of viewButtons) {
    const reads = item.dataset.view === 'readout';
    item.disabled = reads && result.measured.length === 0;
    item.setAttribute('aria-pressed', String(item.dataset.view === view));
  }
  const readings = view === 'readout';
  const displayed = readings ? result.outcomes : result.probabilities.map((probability, index) => ({bits: basisLabel(index), probability}));
  const bars = byId('outcome-bars');
  bars.replaceChildren();
  for (const {bits, probability} of displayed) {
    const row = make('div', 'outcome-bar');
    const track = make('div', 'bar-track');
    const fill = make('div', 'bar-fill');
    fill.style.width = percent(probability);
    track.append(fill);
    track.setAttribute('aria-hidden', 'true');
    row.append(make('code', '', readings ? bits : `|${bits}⟩`), track, make('span', 'bar-value', percent(probability)));
    bars.append(row);
  }
  byId('outcome-note').textContent = readings ? `Stored bits · ${result.measured.map(qLabel).join(', ')}` : 'Computational basis · q₀q₁q₂';
  byId('outcome-caption').textContent = readings ? 'Each bit comes from the last measurement on its wire.' : (presetNotes[preset] ?? 'Basis probabilities after the final circuit step.');
}

function pulsePaths(event) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 26');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const samples = Array.from({length: 33}, (_, index) => sampleEnvelope(event, index / 32));
  for (const [quadrature, stroke] of ['var(--trace-i)', 'var(--teal)'].entries()) {
    if (samples.every(point => Math.abs(point[quadrature]) < 1e-9)) continue;
    const path = document.createElementNS(svgNS, 'polyline');
    path.setAttribute('points', samples.map((sample, index) => `${(index * 100 / 32).toFixed(2)},${(13 - sample[quadrature] * 11).toFixed(2)}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
  }
  return svg;
}

function xPosition(ns) {
  return `${(100 * ns / (schedule.duration || 1)).toFixed(5)}%`;
}

function renderSchedule() {
  timeline.replaceChildren();
  byId('duration').textContent = `${schedule.duration.toLocaleString('en-US')} ns total`;
  scrub.max = schedule.duration;
  scrub.disabled = play.disabled = schedule.duration === 0;
  const showAll = byId('all-lanes').checked;
  if (!schedule.events.length && !showAll) {
    timeline.append(make('p', 'empty-schedule', 'Place a gate to see its instructions here.'));
    timeline.style.minWidth = '0';
    return;
  }
  timeline.style.minWidth = `${Math.max(550, Math.round(schedule.duration * .53))}px`;
  const axis = make('div', 'axis');
  const axisPlot = make('div', 'axis-plot');
  const guides = make('div', 'plot-guides');
  const divisions = schedule.duration < 100 ? 2 : 4;
  const tickValues = schedule.duration ? Array.from({length: divisions + 1}, (_, index) => Math.round(schedule.duration * index / divisions)) : [0];
  for (const [index, tick] of tickValues.entries()) {
    const label = make('span', 'tick', tick.toLocaleString('en-US'));
    label.style.left = xPosition(tick);
    if (index === 0) label.classList.add('start');
    else if (index === tickValues.length - 1) label.classList.add('end');
    if (index > 0 && index < tickValues.length - 1) {
      const guide = make('div', 'guide');
      guide.style.left = xPosition(tick);
      guides.append(guide);
    }
    axisPlot.append(label);
  }
  for (const tick of tickValues) {
    const mark = make('span', 'tick-line');
    mark.style.left = xPosition(tick);
    mark.setAttribute('aria-hidden', 'true');
    axisPlot.append(mark);
  }
  axis.append(make('span', 'axis-name', 'Time (ns)'), axisPlot);
  timeline.append(axis);
  for (const [key, label] of channels) {
    const events = schedule.events.filter(event => event.channel === key);
    if (events.length === 0 && !showAll) continue;
    const channel = make('div', 'channel');
    const laneLabel = make('div', 'lane-label');
    laneLabel.append(make('b', '', key), make('small', '', label));
    const plot = make('div', 'lane-plot');
    for (const event of events) {
      const eventButton = button(`plot-event ${event.kind}`);
      eventButton.dataset.eventId = event.id;
      eventButton.dataset.gateId = event.gateId;
      eventButton.style.left = xPosition(event.start);
      if (event.duration > 0) eventButton.style.width = xPosition(event.duration);
      eventButton.title = `${event.label} · ${key} · ${event.start} ns`;
      eventButton.setAttribute('aria-label', `${event.label}, ${label}, ${event.start} nanoseconds`);
      if (['drive', 'interaction', 'readout'].includes(event.kind)) eventButton.append(pulsePaths(event));
      plot.append(eventButton);
    }
    channel.append(laneLabel, plot);
    timeline.append(channel);
  }
  guides.setAttribute('aria-hidden', 'true');
  guides.append(make('div', 'playhead'));
  timeline.append(guides);
  highlightSchedule();
}

function highlightSchedule() {
  for (const element of timeline.querySelectorAll('.plot-event')) {
    element.classList.toggle('is-picked', pickedEvent ? element.dataset.eventId === pickedEvent : element.dataset.gateId === selected);
  }
}

function renderInspector(restoreEvent) {
  inspector.replaceChildren();
  const operation = operations.find(item => item.id === selected);
  if (!operation) {
    inspector.append(make('p', 'inspector-copy', 'Select a circuit gate or a schedule instruction.'));
    return;
  }
  const {gate, column, target, control, angle} = operation;
  const wire = gate === 'CX' ? `${qLabel(control)} → ${qLabel(target)}` : qLabel(target);
  const suffix = gate === 'RY' ? ` · ${degrees(angle)}` : '';
  inspector.append(make('p', 'selected-name', `${GATES[gate].label} · ${wire}${suffix}`));
  inspector.append(make('p', 'inspector-copy', `Step ${column + 1}. ${GATES[gate].description}`));
  const list = make('ul', 'instruction-list');
  for (const event of schedule.events.filter(item => item.gateId === selected)) {
    const row = make('li', 'instruction');
    const line = button(pickedEvent === event.id ? 'is-picked' : '');
    line.dataset.eventId = event.id;
    line.append(make('span', '', event.label), make('time', '', `${event.start} ns`));
    line.setAttribute('aria-label', `${event.label} on ${channelLabel[event.channel]} at ${event.start} nanoseconds`);
    row.append(line);
    list.append(row);
  }
  inspector.append(list);
  const selectedEvent = schedule.events.find(event => event.id === pickedEvent);
  if (selectedEvent) {
    const event = selectedEvent;
    const details = [`${event.channel} · ${event.duration} ns`];
    if (event.kind === 'interaction') details.push(`Drive ${qLabel(event.control)} at the ${qLabel(event.target)} frequency`);
    if (event.phase !== undefined && event.kind !== 'readout') details.push(`I/Q phase ${degrees(event.phase)}`);
    if (event.kind === 'frame') details.push(`Frame ${degrees(event.previousFrame)} → ${degrees(event.frame)}`);
    inspector.append(make('p', 'instruction-detail', details.join(' · ')));
  }
  const drive = selectedEvent?.kind === 'drive' ? selectedEvent : !selectedEvent && schedule.events.find(event => event.gateId === selected && event.kind === 'drive');
  if (drive && leakage) {
    const testDrive = make('a', 'text-button test-pulse', 'Test this drive for leakage');
    testDrive.href = '#leakage';
    testDrive.addEventListener('click', () => leakage.selectEvent(drive.id));
    inspector.append(testDrive);
  }
  if (restoreEvent) [...list.querySelectorAll('button')].find(element => element.dataset.eventId === restoreEvent)?.focus({preventScroll: true});
}

function paintTime(value) {
  time = Math.round(value);
  scrub.value = time;
  byId('time').value = `${time.toLocaleString('en-US')} ns`;
  timeline.style.setProperty('--position', xPosition(time));
}

function stop() {
  if (animation) cancelAnimationFrame(animation);
  animation = 0;
  play.classList.remove('is-playing');
  play.setAttribute('aria-label', 'Play schedule');
}

function start() {
  if (!schedule.duration) return;
  const startTime = time >= schedule.duration ? 0 : time;
  const startAt = performance.now();
  const speed = schedule.duration / 5000;
  const frame = now => {
    const next = Math.min(schedule.duration, startTime + (now - startAt) * speed);
    paintTime(next);
    if (next < schedule.duration) animation = requestAnimationFrame(frame);
    else stop();
  };
  play.classList.add('is-playing');
  play.setAttribute('aria-label', 'Pause schedule');
  animation = requestAnimationFrame(frame);
}

function refresh() {
  const restoreFocus = grid.contains(document.activeElement);
  stop();
  schedule = compile(operations);
  result = simulate(operations);
  leakage?.update(schedule.events);
  updateControls();
  renderCircuit(restoreFocus);
  renderOutcomes();
  renderSchedule();
  renderInspector();
  paintTime(0);
}

for (const [key, gate] of Object.entries({inspect: {label: 'Select', name: 'Select a gate'}, ...GATES})) {
  const item = button('gate-tool', gate.label);
  item.dataset.tool = key;
  item.title = gate.name;
  item.setAttribute('aria-label', gate.name);
  item.addEventListener('click', () => selectTool(key));
  palette.append(item);
}
for (const item of presetButtons) item.addEventListener('click', () => {
  const next = item.dataset.preset;
  if (preset === next) return;
  tool = 'inspect';
  focusSlot = {column: 0, qubit: 0};
  changeCircuit(PRESETS[next], next, PRESETS[next][0]?.id ?? null);
  byId('circuit-scroll').scrollLeft = 0;
  byId('timeline-scroll').scrollLeft = 0;
  announce(next === 'empty' ? 'Choose a gate to start building.' : `${item.textContent} preset loaded.`);
});
for (const item of viewButtons) item.addEventListener('click', () => {
  view = item.dataset.view;
  renderOutcomes();
});
grid.addEventListener('click', event => {
  const slot = event.target.closest('.slot');
  if (slot) activateSlot(Number(slot.dataset.column), Number(slot.dataset.qubit));
});
grid.addEventListener('focusin', event => {
  const slot = event.target.closest('.slot');
  if (!slot) return;
  const previous = grid.querySelector('.slot[tabindex="0"]');
  if (previous && previous !== slot) previous.tabIndex = -1;
  slot.tabIndex = 0;
  focusSlot = {column: Number(slot.dataset.column), qubit: Number(slot.dataset.qubit)};
});
grid.addEventListener('keydown', event => {
  const slot = event.target.closest('.slot');
  if (!slot) return;
  if (event.key === 'Escape') {
    selectTool('inspect');
    grid.querySelector('.slot[tabindex="0"]')?.focus({preventScroll: true});
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const operation = circuitCell(focusSlot.qubit, focusSlot.column);
    if (operation) {
      event.preventDefault();
      selected = operation.id;
      removeSelected();
    }
    return;
  }
  const offset = {ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0]}[event.key];
  if (offset) {
    event.preventDefault();
    grid.querySelector(`[data-column="${focusSlot.column + offset[0]}"][data-qubit="${focusSlot.qubit + offset[1]}"]`)?.focus();
  }
});
byId('remove').addEventListener('click', removeSelected);
byId('undo').addEventListener('click', () => {
  const previous = history.pop();
  if (!previous) return;
  ({operations, preset, selected} = previous);
  pendingControl = pickedEvent = null;
  refresh();
  announce('Last edit undone.');
});
function applyAngle() {
  if (tool !== 'inspect') return;
  const angle = byId('angle').valueAsNumber * Math.PI / 180;
  const operation = operations.find(item => item.id === selected && item.gate === 'RY');
  if (!operation) return;
  try {
    changeCircuit(operations.map(item => item === operation ? {...item, angle} : item), null, selected);
    announce('Rotation angle updated.');
  } catch (error) {
    announce(error.message, true);
  }
}
byId('angle-apply').addEventListener('click', applyAngle);
byId('angle').addEventListener('keydown', event => {
  if (event.key === 'Enter') applyAngle();
});
byId('all-lanes').addEventListener('change', renderSchedule);
timeline.addEventListener('click', event => {
  const pulse = event.target.closest('[data-event-id]');
  if (!pulse) return;
  const instruction = schedule.events.find(item => item.id === pulse.dataset.eventId);
  tool = 'inspect';
  pendingControl = null;
  chooseGate(instruction.gateId, instruction.id);
  stop();
  paintTime(instruction.start);
});
inspector.addEventListener('click', event => {
  const instruction = event.target.closest('[data-event-id]');
  if (!instruction) return;
  pickedEvent = instruction.dataset.eventId;
  const pulse = [...timeline.querySelectorAll('.plot-event')].find(item => item.dataset.eventId === pickedEvent);
  pulse?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  highlightSchedule();
  renderInspector(pickedEvent);
  stop();
  paintTime(schedule.events.find(item => item.id === pickedEvent).start);
});
scrub.addEventListener('input', () => {
  stop();
  paintTime(scrub.valueAsNumber);
});
play.addEventListener('click', () => animation ? stop() : start());

function describeTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeToggle.textContent = dark ? 'Light mode' : 'Dark mode';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0d0818' : '#f9f8fb';
}

themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('syed_theme', theme); } catch {}
  describeTheme();
});

describeTheme();
refresh();
announce(toolPrompt());

try {
  const {mountLeakage} = await import('./leakage/index.mjs');
  leakage = mountLeakage(byId('leakage'), {getEvents: () => schedule.events});
  renderInspector();
} catch (error) {
  byId('leakage').append(make('h2', '', 'Single-transmon leakage'));
  byId('leakage').append(make('p', 'inspector-copy', 'The leakage experiment could not initialize. Reload the page to try again.'));
  console.error(error);
}
