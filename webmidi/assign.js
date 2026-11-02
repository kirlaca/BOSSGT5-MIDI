'use strict';

// EXP / CTL / Assign page. Every controller is patch data in blocks 03-04
// (block 04 holds the rest of Assign 8); their on/off switches are bits in
// block 00 (GT5.ON_BITS):
//     03 00-05     EXP pedal   target, min, max
//     03 06-0D     CTL pedal   target, min, max, source mode
//     03 0E-...    Assign 1-8, 16 bytes each: also source, mode, active range,
//                  internal pedal, wave pedal
// The target is a one-byte code into the target table (gt5-params.js; the byte
// after it is unused); Min and Max are two-byte values shown in the target
// parameter's own range and units, and reset to its full range when the target
// changes (customControlTarget.cpp).
// Uses the controls and helpers of app.js (h, knob, slider, edit, value, ...).

// Field -> offset within an assign's 16 bytes.
const ASSIGN_FIELDS = { target: 0, min: 2, max: 4, source: 6, mode: 7, lo: 8, hi: 9, trigger: 10, time: 11, curve: 12, rate: 13, wave: 14 };

// An assign's fields as [block, offset]: Assign 8 starts at 03 7E and runs on into block 04.
function assignFields(i) {
  const start = 0x0E + i * 0x10;
  return Object.fromEntries(Object.entries(ASSIGN_FIELDS).map(([k, o]) => {
    const at = start + o;
    return [k, at < 0x80 ? [0x03, at] : [0x04, at - 0x80]];
  }));
}

const CONTROLLERS = [
  { name: 'EXP Pedal', key: 'exp', fixedSource: 'EXP pedal', f: { target: [0x03, 0x00], min: [0x03, 0x02], max: [0x03, 0x04] } },
  { name: 'CTL Pedal', key: 'ctl', fixedSource: 'CTL pedal', f: { target: [0x03, 0x06], min: [0x03, 0x08], max: [0x03, 0x0A], mode: [0x03, 0x0D] } },
  ...Array.from({ length: 8 }, (_, i) => ({ name: `Assign ${i + 1}`, key: `a${i + 1}`, assign: true, f: assignFields(i) })),
];

const SOURCE_INTERNAL = 4;
const SOURCE_WAVE = 5;

// A controller field's value, and the (block, offset) pair the controls of app.js take.
const fval = (c, k) => value(...c.f[k]);
const isOnC = c => GT5.isOn(state.patch, c.key);

// "CC#01 Midi Controller" -> "CC#01"; the pedal names in title case.
function sourceName(text) {
  const cc = /^CC#\s*(\d+)/.exec(text);
  if (cc) return `CC#${cc[1].padStart(2, '0')}`;
  return text.replace(/\bPDL\b/, 'PEDAL').toLowerCase().replace(/(^|\s)(\w)/g, (_, s, c) => s + c.toUpperCase())
    .replace(/\b(Exp|Ctl)\b/g, m => m.toUpperCase()).replace(/-([lmh])$/i, (_, c) => `-${c.toUpperCase()}`);
}

// The controller's target: {code, block, offset, name, param} or null for a code the table doesn't know.
const targetOf = c => GT5.target(fval(c, 'target'));

function sourceText(c) {
  if (c.fixedSource) return c.fixedSource;
  return sourceName(GT5.label(GT5.param(...c.f.source), fval(c, 'source')));
}

// Min / Max knob limits and texts: the target parameter's, else the raw stored numbers.
function targetScale(c) {
  const t = targetOf(c);
  if (!t) {
    const own = GT5.param(...c.f.min);
    return { range: [own.min, own.max], text: v => String(v), name: `Unknown target (${fval(c, 'target')})` };
  }
  return { range: [t.param.min, t.param.max], text: v => EFFECTS.valueText(t.block, t.offset, v), name: t.name, target: t };
}

// A new target: Min / Max go to the ends of its range, so it starts out doing something sensible.
function setTarget(c, code) {
  const t = GT5.target(code);
  edit(...c.f.target, code);
  edit(...c.f.min, t.param.min);
  edit(...c.f.max, t.param.max, { structural: true });
}

// ---------------------------------------------------------------- list

function renderControllerList() {
  const list = $('#ctl-list');
  list.replaceChildren(...CONTROLLERS.map((c, i) => {
    const on = isOnC(c);
    const t = targetOf(c);
    const b = h('button', `ctl-item${i === state.controller ? ' sel' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === state.controller));
    const name = h('span', 'ctl-name');
    name.append(h('span', `dot${on ? ' on' : ''}`), c.name);
    const what = on ? `${t ? t.name : 'Unknown target'} · ${sourceText(c)}` : 'Off';
    b.append(name, h('span', `ctl-target${on ? ' live' : ''}`, what));
    b.addEventListener('click', () => { state.controller = i; renderView(); });
    return b;
  }));
}

// ---------------------------------------------------------------- cards

function card(title, note = '', dim = false) {
  const el = h('section', `card${dim ? ' dim' : ''}`);
  const head = h('h2', 'card-h', title);
  if (note) head.append(h('span', 'card-note', note));
  el.append(head);
  return el;
}

function field(label, control) {
  const el = h('div', 'field');
  el.append(h('span', '', label), control);
  return el;
}

// The target list, grouped by the effect it belongs to ("OD/DS: Drive" -> OD/DS).
function targetSelect(c) {
  const select = h('select');
  select.setAttribute('aria-label', `${c.name} target`);
  const code = fval(c, 'target');
  if (!GT5.target(code)) {
    const o = h('option', '', `Unknown target (${code})`);
    o.value = code;
    select.append(o);
  }
  let group = null;
  let groupName = null;
  for (const t of GT5.TARGETS) {
    const name = t.name.includes(':') ? t.name.split(':')[0] : 'Other';
    if (name !== groupName) {
      groupName = name;
      group = h('optgroup');
      group.label = name;
      select.append(group);
    }
    const o = h('option', '', t.name);
    o.value = t.code;
    group.append(o);
  }
  select.value = code;
  select.addEventListener('change', () => setTarget(c, Number(select.value)));
  select.addEventListener('keydown', e => e.stopPropagation());
  return select;
}

function targetCard(c) {
  const scale = targetScale(c);
  const el = card('Target', `${GT5.TARGETS.length} targets, grouped by effect`);
  el.append(field('What this controller moves', targetSelect(c)));
  const knobs = h('div', 'minmax');
  const arrow = h('span', 'minmax-arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  knobs.append(
    knob(...c.f.min, 'Min', { size: 'xl', range: scale.range, text: scale.text }),
    arrow,
    knob(...c.f.max, 'Max', { size: 'xl', range: scale.range, text: scale.text }),
  );
  el.append(knobs);
  const note = h('p', 'card-foot');
  note.append("Min and Max use the target's own range and units: ",
    h('b', '', `${scale.text(scale.range[0])} … ${scale.text(scale.range[1])}`));
  el.append(note);
  return el;
}

function sourceCard(c) {
  const el = card('Source');
  if (c.assign) el.append(field('What moves it', listBox(...c.f.source, `${c.name} source`, { structural: true })));
  else el.append(h('p', 'card-foot', `Always the ${c.fixedSource}.`));
  if (c.f.mode) el.append(field('Mode', segmented(...c.f.mode)));
  if (c.assign) {
    const range = h('div', 'two');
    range.append(slider(...c.f.lo, 'Active range low'), slider(...c.f.hi, 'Active range high'));
    el.append(range);
  }
  return el;
}

// Source position 0-127 -> target value, as the pedal applies it.
function responseCard(c) {
  const el = card('Response', 'source → target');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 340 180');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'How the source position maps onto the target value');
  svg.classList.add('response');
  svg.innerHTML = `<rect class="r-frame" x="30" y="10" width="300" height="140"/>
    <rect class="r-band" y="10" height="140"/>
    <path class="r-curve"/>
    <text class="r-min" x="24" text-anchor="end"/><text class="r-max" x="24" text-anchor="end"/>
    <text x="30" y="168">0</text><text x="330" y="168" text-anchor="end">127</text>
    <text class="r-src" x="180" y="168" text-anchor="middle"/>`;
  el.append(svg);
  const X = s => 30 + (s / 127) * 300;
  const scale = targetScale(c);
  const span = Math.max(1, scale.range[1] - scale.range[0]);
  const Y = v => 150 - clamp((v - scale.range[0]) / span, 0, 1) * 140;
  const q = sel => svg.querySelector(sel);
  painters.push(() => {
    const min = fval(c, 'min');
    const max = fval(c, 'max');
    const lo = c.assign ? fval(c, 'lo') : 0;
    const hi = c.assign ? fval(c, 'hi') : 127;
    const toggle = Boolean(c.f.mode) && fval(c, 'mode') === 1;
    const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
    q('.r-curve').setAttribute('d', toggle
      ? `M30 ${Y(min)} H${X((a + b) / 2)} V${Y(max)} H330`
      : `M30 ${Y(min)} H${X(a)} L${X(b)} ${Y(max)} H330`);
    q('.r-band').setAttribute('x', X(a));
    q('.r-band').setAttribute('width', Math.max(0, X(b) - X(a)));
    q('.r-min').setAttribute('y', Y(min) + 4);
    q('.r-min').textContent = scale.text(min);
    q('.r-max').setAttribute('y', Y(max) + 4);
    q('.r-max').textContent = scale.text(max);
    q('.r-src').textContent = `${sourceText(c)}${toggle ? ' (toggle)' : ''}`;
  });
  return el;
}

function internalCard(c) {
  const used = fval(c, 'source') === SOURCE_INTERNAL;
  const el = card('Internal pedal', 'used when Source is Internal Pedal', !used);
  el.append(field('Trigger', listBox(...c.f.trigger, 'Internal pedal trigger')));
  const row = h('div', 'two');
  row.append(slider(...c.f.time, 'Time'), field('Curve', segmented(...c.f.curve)));
  el.append(row);
  return el;
}

function waveCard(c) {
  const used = fval(c, 'source') === SOURCE_WAVE;
  const el = card('Wave pedal', 'used when Source is Wave Pedal', !used);
  el.append(field('Waveform', segmented(...c.f.wave)), slider(...c.f.rate, 'Rate'));
  return el;
}

// ---------------------------------------------------------------- page

function renderAssign() {
  renderControllerList();
  const c = CONTROLLERS[state.controller];
  const main = $('#ctl-detail');
  const head = h('div', 'ctl-head');
  const title = h('div', 'ctl-title');
  const on = isOnC(c);
  title.append(h('h1', '', c.name), onSwitch(onBinding(c.key), null, c.name), h('span', 'muted', on ? 'On' : 'Off'));
  const [b, o] = c.f.target;
  head.append(title, h('span', 'muted', `Patch data · ${GT5.hex(b)} ${GT5.hex(o)}`));
  // Tried on a real GT-5: its temporary patch doesn't take these - only a written patch does.
  const note = h('p', 'card-foot', 'On the GT-5 these settings take effect only when the patch is written (Write → BULK LOAD on the GT-5) '
    + 'and selected again - changes here are not heard live.');


  const cards = h('div', 'cards');
  cards.append(targetCard(c), sourceCard(c), responseCard(c));
  if (c.assign) cards.append(internalCard(c), waveCard(c));
  main.replaceChildren(head, note, cards);
  repaint();
}
