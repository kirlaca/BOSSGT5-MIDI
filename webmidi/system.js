'use strict';

// System page: the GT-5's own settings - tuner, output, global EQ, controls,
// patch change, MIDI, manual mode, the custom OD/DS and preamp voicings and the
// 29 user harmony scales (menuPage_system.cpp). They are not patch data: the
// GT-5 stores each change at once, so there is no Write here. The groups and
// their order follow the Qt page.
// Uses the helpers of app.js (h, $, state, knob, segmented, listBox, ...).

const SYSTEM_GROUPS = [
  ['Output', 'Global', [[0, 'Output select'], [5, 'Speaker sim']]],
  ['Global EQ / NS / Reverb', 'Global', [[1, 'Low EQ'], [2, 'High EQ'], [3, 'NS Thresh'], [4, 'Reverb']]],
  ['Tuner', 'Tuner', [[0, 'Pitch'], [1, 'String display'], [2, 'Output']]],
  ['Controls', 'System', [[0, 'Dial function'], [4, 'Assign hold'], [1, 'Sub CTL 1'], [2, 'Sub CTL 2']]],
  ['Patch change', 'System', [[3, 'Mode']]],
  ['MIDI', 'Midi', [[0, 'Program change out'], [5, 'Program map'], [1, 'EXP pedal out'], [2, 'CTL pedal out'],
    [3, 'Sub CTL 1 out'], [4, 'Sub CTL 2 out']]],
  ['Manual mode', 'Manual', [[0, 'Pedal 1'], [1, 'Pedal 2'], [2, 'Pedal 3'], [3, 'Pedal 4'], [4, 'Pedal 5']]],
  ...[1, 2].map(n => [`Custom OD/DS ${n}`, 'OD/DS Custom',
    ['Bottom', 'Attack', 'Top', 'Type', 'Low', 'Mid', 'High'].map((label, i) => [(n - 1) * 7 + i, label])]),
  ...[1, 2].map(n => [`Custom PreAmp ${n}`, 'Preamp Custom',
    ['Bottom', 'Top', 'Volume type', '3-tone', 'Clip', 'Presence', 'Gain', 'Low', 'High', 'Cabinet'].map((label, i) => [(n - 1) * 10 + i, label])]),
];

// The user harmony scales: 29 scales x 12 notes, one byte each, running on over
// three system addresses (01 03 00 / 01 / 02, 128 bytes apiece).
const HR_SCALES = 29;
const HR_NOTES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

function scaleNote(scale, note) {
  const i = scale * HR_NOTES.length + note;
  return { area: GT5.systemArea('HR Scale', Math.floor(i / 128)), offset: i % 128 };
}

// A system parameter for the controls of app.js (see patchBinding there).
function systemBinding(area, offset) {
  const p = GT5.systemParam(area, offset);
  return {
    p,
    get: () => GT5.getSystemValue(state.system, area, offset) ?? p.min,
    set: v => {
      if (v === GT5.getSystemValue(state.system, area, offset)) return;
      const message = GT5.setSystemValue(state.system, area, offset, v, dev());
      queueSend(`sys/${area.address.join('.')}/${offset}`, message);
      repaint();
    },
    text: v => EFFECTS.shortValue(GT5.label(p, v)).replace(/ Midi Controller$/, ''),
  };
}

function systemControl(area, offset, label) {
  const b = systemBinding(area, offset);
  const kind = EFFECTS.widgetFor(b.p);
  if (kind === 'knob') return knob(b, null, label);
  const wrap = h('div', 'ctl');
  wrap.append(h('span', 'knob-label', label), kind === 'seg' ? segmented(b, null) : listBox(b, null, label));
  return wrap;
}

function scaleGroup() {
  const group = h('section', 'group');
  const head = h('h3', '', 'User harmony scales');
  const pick = h('select', 'scale-pick');
  pick.setAttribute('aria-label', 'User scale');
  for (let s = 0; s < HR_SCALES; s++) {
    const o = h('option', '', `User ${s + 1}`);
    o.value = s;
    pick.append(o);
  }
  pick.value = state.sysScale;
  pick.addEventListener('change', () => { state.sysScale = Number(pick.value); renderView(); });
  pick.addEventListener('keydown', e => e.stopPropagation());
  head.append(' ', pick);
  group.append(head, h('p', 'muted', 'The harmony the Harmonist plays for each note of the key, when its Scale is User.'));
  const row = h('div', 'group-controls');
  HR_NOTES.forEach((note, i) => {
    const { area, offset } = scaleNote(state.sysScale, i);
    const wrap = h('div', 'ctl');
    wrap.append(h('span', 'knob-label', note), listBox(systemBinding(area, offset), null, `User ${state.sysScale + 1} ${note}`));
    row.append(wrap);
  });
  group.append(row);
  return group;
}

function renderSystem() {
  const groups = $('#sys-groups');
  groups.replaceChildren(...SYSTEM_GROUPS.map(([title, areaName, params]) => {
    const area = GT5.systemArea(areaName);
    const group = h('section', 'group');
    group.append(h('h3', '', title));
    const row = h('div', 'group-controls');
    for (const [offset, label] of params) row.append(systemControl(area, offset, label));
    group.append(row);
    return group;
  }), scaleGroup());
  $('#sys-source').textContent = state.conn ? state.systemSource : `${state.systemSource} · offline: changes stay in the editor`;
  $('#sys-read').disabled = !state.conn;
  $('#sys-send').disabled = !state.conn;
}

// ---------------------------------------------------------------- reading / files

async function readSystem() {
  if (!READ_BY_REQUEST) { askForBulkDump('its system settings'); return; }
  const btn = $('#sys-read');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const messages = await Midi.readSystem(state.conn);
    state.system = GT5.decodeSystem(GT5.concat(messages));
    state.systemSource = 'Read from GT-5';
    state.systemRead = true;
    toast('System settings read from the GT-5');
    track('system-read');
  } catch (e) {
    toast(`System read failed: ${e.message}`, 'error');
  } finally {
    btn.textContent = 'Read from GT-5';
    if (state.view === 'system') renderView();
  }
}

// Opening the page while connected shows the GT-5's own settings, not the defaults.
function readSystemOnce() {
  if (READ_BY_REQUEST && state.conn && !state.systemRead) readSystem();
}

async function sendSystem() {
  if (!await Ask.confirm({
    title: 'Send all system settings?',
    text: 'Every system setting on the GT-5 is replaced by what this page shows. The GT-5 stores them at once.',
    confirmText: 'Send',
  })) return;
  try {
    await flushSends();
    await Midi.send(state.conn.output, GT5.encodeSystem(state.system, state.conn.dev));
    state.systemRead = true;
    toast('System settings sent to the GT-5');
    track('system-send');
  } catch (e) {
    toast(`Send failed: ${e.message}`, 'error');
  }
}

function loadSystemFile(bytes, name) {
  try {
    state.system = GT5.decodeSystem(bytes);
    state.systemSource = `File · ${name}`;
    location.hash = '#system';
    renderView();
    toast(state.conn ? `Loaded ${name} - "Send all to GT-5" puts it on the GT-5` : `Loaded ${name}`);
  } catch (e) {
    toast(`Load failed: ${e.message}`, 'error');
  }
}

function wireSystem() {
  $('#sys-read').addEventListener('click', readSystem);
  $('#sys-send').addEventListener('click', sendSystem);
  $('#sys-load').addEventListener('click', () => $('#sys-file').click());
  $('#sys-file').addEventListener('change', e => {
    const [file] = e.target.files;
    e.target.value = '';
    if (!file) return;
    file.arrayBuffer().then(buf => loadSystemFile(new Uint8Array(buf), file.name), err => toast(`Load failed: ${err.message}`, 'error'));
  });
  $('#sys-save').addEventListener('click', () => {
    download(GT5.concat(GT5.encodeSystem(state.system)), 'gt5-system.syx');
    toast('Saved gt5-system.syx');
  });
}
