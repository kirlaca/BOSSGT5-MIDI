'use strict';

// GT-5 editor UI: the effects page. Patch data and SysEx come from gt5.js, MIDI
// from midi.js, the per-effect layout from effects.js. Layout and behaviour
// follow the GT-3 editor (D:\BOSS_PEDALS\BOSSGT3\webmidi\app.js), itself taken from the ME-5's.

const CONN_KEY = 'gt5.webmidi.conn';
const AUTO_WRITE_KEY = 'gt5.autoWrite';
const MIDI_CHANNELS = 16;
const BANKS_PER_PAGE = GT5.BANKS_PER_GROUP;                                         // a page = a group
const USER_BANKS = GT5.USER_PATCHES / GT5.PATCHES_PER_BANK;                         // 20
const PRESET_BANKS = (GT5.ALL_PATCHES - GT5.USER_PATCHES) / GT5.PATCHES_PER_BANK;   // 30

const state = {
  library: new Array(GT5.ALL_PATCHES).fill(null), // patch per memory slot; null = not read yet
  source: 'Nothing read yet',
  current: 0,
  patch: null,      // the sound being edited (the GT-5's temporary patch)
  original: null,   // the patch as it was when selected - Revert returns here, even after an auto write
  conn: null,       // {output, input, dev, channel} when talking to a real GT-5
  autoWrite: false,
  area: 'user',     // patch map: 'user' | 'preset'
  page: 0,          // patch map page within the area
  detail: null,     // chain code of the pedal shown in the detail panel
  view: 'effects',  // one of VIEWS
  controller: 0,    // assign page: index into CONTROLLERS (EXP, CTL, Assign 1-8)
  sysScale: 0,      // system page: which user harmony scale (0-28) is shown
  // User patches whose library copy is not on the GT-5 yet (file loads, copies, offline writes).
  unsynced: new Set(),
  lib: { area: 'user', filter: '', selected: new Set() },  // library page
  system: GT5.decodeSystem(GT5.systemSyx()),  // system settings, see GT5.decodeSystem
  systemSource: 'Defaults (system.syx) - not read from the GT-5',
  systemRead: false,  // read from the connected GT-5 since connecting
  // Connected, but the current slot has not been read: the editor shows the default patch
  // as a placeholder. Nothing is sent or auto-written then, so a Write can't replace the
  // user's own sound with it. Cleared when the slot is read, or a patch is loaded on purpose.
  needsRead: false,
  // The GT-5 didn't answer a read: no more automatic reads (they can hang it)
  // until the user asks for one or connects again.
  noReplies: false,
  // Effects switched on in the editor but not on the GT-5: without a live switch
  // they are heard only after Write (see switchEffect).
  pendingOn: new Set(),
  // Parameters ('block/offset') edited since the patch was loaded: a switched-off
  // effect drops what is sent to it, so they go again when its live switch turns it on.
  touched: new Set(),
  liveOnly: false,  // effects page: show only the pedals with a live switch in the layout
};
const LIVE_ONLY_KEY = 'gt5.liveOnly';

const VIEWS = ['effects', 'assign', 'library', 'system'];

// How the GT-5 is read. Tried on a real unit (2026-10-22): it answers a data
// request (RQ1) correctly only for block 00. For the other blocks its reply
// carries two-byte values as 8-bit bytes (delay time 400 ms -> 01 90): a status
// byte inside the SysEx, which cuts the message - and asking on can leave it stuck
// on "DATA SENDING...". Its own BULK DUMP is fine, so reading = a bulk dump started
// on the GT-5 that the editor takes in (receiveDump). Requests stay off.
const READ_BY_REQUEST = false;

function askForBulkDump(what = 'the patches') {
  Ask.alert({
    icon: 'question',
    title: 'Send a Bulk Dump from the GT-5',
    text: [`The GT-5 can't be asked for ${what} reliably - but it sends them itself: on the GT-5 go to `
      + 'UTILITY → MIDI and press PARAMETER until BULK DUMP, choose what to send (TEMP = the current patch, '
      + 'or the user patches / system / all), and start it.',
    'The editor is listening: the patches go to their places, the system settings to the System page, '
      + 'and a message says what came. Then save them: Library → Save selected…, System → Save file….'],
  });
}

// ---------------------------------------------------------------- helpers

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const $ = sel => document.querySelector(sel);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 2800);
}

function arc(a0, a1, r = 42) {
  const pt = a => [50 + r * Math.sin((a * Math.PI) / 180), 50 - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = pt(a0);
  const [x1, y1] = pt(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// Counts an action as a GoatCounter event, as in the GT-3 editor. Only the event name
// is sent. The GT-5 page has no counter script yet, so this does nothing until one
// is added to index.html; it is also silent when blocked, offline or on localhost.
function track(event) {
  const send = () => { try { window.goatcounter?.count?.({ path: event, event: true }); } catch { /* not counted */ } };
  // The async counter script is in by the load event; earlier events wait for it.
  if (document.readyState === 'complete') send(); else window.addEventListener('load', send, { once: true });
}

const value = (block, offset) => GT5.getValue(state.patch, block, offset);
const optionLabel = (block, offset, v) => EFFECTS.valueText(block, offset, v);

// What "unchanged" means: the stored patch when it is known, else the patch as selected.
const basePatch = () => state.library[state.current] || state.original;
const isDirty = () => !GT5.samePatch(state.patch, basePatch());

// ---------------------------------------------------------------- MIDI out

// Live edits are coalesced per parameter and sent a moment later, so a fast
// knob drag sends the latest value instead of a backlog.
const pending = new Map();
let pendingTimer = null;

// soundChange: a Sound Change Request after the message(s), so the GT-5 plays them
// (patch sound only - not the system area, name or on/off bits).
function queueSend(key, message, { soundChange = false } = {}) {
  if (!state.conn || state.needsRead) return;
  pending.delete(key);  // to the end: a newer value goes out after what was queued since
  pending.set(key, soundChange ? [message, GT5.soundChange(dev())].flat() : message);
  if (pendingTimer === null) pendingTimer = setTimeout(flushSends, 25);
}

function flushSends() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  if (!state.conn || !pending.size) { pending.clear(); return Promise.resolve(); }
  const messages = [...pending.values()].flat();  // a name or a chain is one message per byte
  pending.clear();
  return Midi.send(state.conn.output, messages, { gapMs: SWITCH_GAP_MS }).catch(e => toast(`Send failed: ${e.message}`, 'error'));
}

// After Revert, Init or a file load: make the GT-5's temporary patch follow, as far
// as it can. It takes one parameter per message and overflows on a long run, so
// only what changed goes out, slowly, each with a Sound Change Request, and a whole
// different patch doesn't go at all (Write it, then select it). EXP / CTL / assign
// never change in its temporary patch.
const LIVE_LIMIT = 10;        // more changes than this: not sent (a long run froze a real GT-5)
const LIVE_GAP_MS = 300;
function sendChanges(before) {
  pending.clear();
  // What the GT-5 plays now, before pendingOn is forgotten.
  const heard = new Map(SWITCHED.map(c => [c, GT5.isOn(before, c) && !state.pendingOn.has(c)]));
  state.pendingOn.clear();
  if (!state.conn || state.needsRead) return Promise.resolve();
  const { messages, skipped } = GT5.liveChanges(before, state.patch, dev(), { onOff: false });
  const switches = SWITCHED.filter(c => GT5.isOn(state.patch, c) !== heard.get(c));
  if (messages.length + switches.length > LIVE_LIMIT) {
    toast(`Not sent to the GT-5: ${messages.length + switches.length} changes would overflow it - Write the patch, then select it`, 'error');
    return Promise.resolve();
  }
  if (skipped) toast('EXP / CTL / Assign changes reach the GT-5 only when the patch is written');
  for (const p of GT5.BLOCKS.filter(b => b.id === 0x01 || b.id === 0x02).flatMap(b => b.params.map(q => [b.id, q.offset]))) {
    if (GT5.getValue(before, ...p) !== GT5.getValue(state.patch, ...p)) state.touched.add(p.join('/'));
  }
  // The switches after the parameters: one switched on gets its parameters again then.
  return Midi.send(state.conn.output, GT5.withSoundChange(messages, dev()), { gapMs: LIVE_GAP_MS })
    .then(() => { for (const c of switches) switchEffect(c, GT5.isOn(state.patch, c)); })
    .catch(e => toast(`Send failed: ${e.message}`, 'error'));
}

const dev = () => state.conn?.dev ?? 0;

// ---------------------------------------------------------------- edits

function edit(block, offset, v, { structural = false } = {}) {
  if (v === value(block, offset)) return;
  // Tried on a real GT-5 (2026-10-24): with a Sound Change Request after it a
  // parameter plays at once - of an effect switched on by its live switch since
  // the patch loaded too, and of no effect (Master Level). A switched-off effect
  // drops it (switchEffect sends it again when it comes on).
  queueSend(`${block}/${offset}`, GT5.setValue(state.patch, block, offset, v, dev()), { soundChange: true });
  state.touched.add(`${block}/${offset}`);
  changed(structural);
}

// Something in state.patch changed: repaint, and restart the auto write countdown.
// Structural changes (type, on/off, order) rebuild the pedals.
function changed(structural = true) {
  if (structural) renderView(); else repaint();
  queueAutoWrite();
  refreshIndicators();
}

// Effect / controller on/off: a bit in block 00 (GT5.ON_BITS). EXP / CTL /
// assign bits go out as their whole byte; effects through switchEffect.
function setOn(key, on) {
  if (on === GT5.isOn(state.patch, key)) return;
  if (typeof key === 'number') {
    GT5.setOn(state.patch, key, on);
    switchEffect(key, on);
  } else {
    queueSend(`on/${GT5.ON_BITS[key][0]}`, GT5.setOn(state.patch, key, on, dev()));
  }
  changed(true);
}

// The effects with an on/off switch (chain codes; FV has none).
const SWITCHED = Object.keys(GT5.ON_BITS).filter(k => /^\d+$/.test(k)).map(Number);
const LIVE_CODES = new Set(GT5.LIVE_SWITCHES.map(s => s.code));
const SWITCH_GAP_MS = 30;

// The CC that switches effect `code` on the GT-5 now, or null. Its temporary
// patch never takes assign changes, so its live switches are those of the patch
// as it was loaded - with the effect types as they are now (FX2 / WAH targets).
function liveCc(code) {
  if (!state.original) return null;
  const p = GT5.clonePatch(state.patch);
  for (const id of [0x03, 0x04]) p.blocks[id] = state.original.blocks[id].slice();
  for (const k of [0x04, 0x05]) p.blocks[0x00][k] = state.original.blocks[0x00][k];  // assign on bits
  return GT5.liveSwitch(p, code);
}

// Make the GT-5 follow an effect's on/off (already set in state.patch). Tried on
// a real unit: a live switch (assign + CC) works both ways; the on/off bit by
// SysEx switches off fine, but switched on the effect plays wrong until the patch
// is reloaded (with a Sound Change Request too) - so without a live switch "on"
// waits for Write.
function switchEffect(code, on) {
  const wasPending = state.pendingOn.delete(code);
  if (!state.conn || state.needsRead) return;
  const cc = liveCc(code);
  if (cc !== null) {
    // Switched on: what was edited while it was off was dropped by the GT-5 - again.
    const messages = [...GT5.liveSwitchMessages(cc, on, state.conn.channel), ...(on ? touchedMessages(code) : [])];
    flushSends().then(() => Midi.send(state.conn.output, messages, { gapMs: SWITCH_GAP_MS }))
      .catch(e => toast(`Send failed: ${e.message}`, 'error'));
    return;
  }
  if (on) {
    state.pendingOn.add(code);
    toast(`${EFFECTS.BY_CODE.get(code).abbr} is on in the patch - the GT-5 plays it after Write (it has no live switch)`);
    return;
  }
  if (wasPending) return;  // the GT-5 never had it on
  const [offset] = GT5.ON_BITS[code];
  queueSend(`on/${offset}`, GT5.dt1(dev(), [0x0B, 0x00, 0x00, offset], [heardOnByte(offset)]));
}

// The edited parameters of effect `code`, each with a Sound Change Request.
function touchedMessages(code) {
  const messages = [];
  for (const key of state.touched) {
    const [block, offset] = key.split('/').map(Number);
    if (EFFECTS.pedalOf(block, offset) !== code) continue;
    const p = GT5.param(block, offset);
    messages.push(GT5.dt1(dev(), [0x0B, 0x00, block, offset], Array.from(state.patch.blocks[block].slice(offset, offset + p.size))));
  }
  return GT5.withSoundChange(messages, dev());
}

// An on/off byte as the GT-5 should have it: without the effects still waiting for Write.
function heardOnByte(offset) {
  let byte = state.patch.blocks[0x00][offset];
  for (const c of state.pendingOn) if (GT5.ON_BITS[c][0] === offset) byte &= ~GT5.ON_BITS[c][1];
  return byte;
}

// Before a write to the GT-5: put the live switches into the patches. A patch
// that uses its assigns for something else keeps them unless the user agrees.
async function addLiveSwitches(patches, labels) {
  const own = patches.map((p, k) => [labels[k], GT5.ownAssigns(p)]).filter(([, a]) => a.length);
  let replace = true;
  if (own.length) {
    const list = own.slice(0, 8).map(([l, a]) => `${l}: Assign ${a.join(', ')}`).join(' · ') + (own.length > 8 ? ' …' : '');
    replace = await Ask.confirm({
      icon: 'question',
      title: own.length === 1 ? 'This patch uses its own assigns' : `${own.length} patches use their own assigns`,
      text: [list,
        'Live switches (Assign 1-8 = CC#20-27: OD, PRE, EQ, FX2, DD, CE, RV, WAH) switch the effects on and off live from the editor. '
          + 'Replace the assigns with them, or keep them (then those effects switch on only after a Write)?'],
      confirmText: 'Live switches',
      cancelText: 'Keep assigns',
    });
  }
  for (const p of patches) if (replace || !GT5.ownAssigns(p).length) GT5.setLiveSwitches(p);
}

function setChain(order) {
  queueSend('chain', GT5.setChain(state.patch, order, dev()), { soundChange: true });
  changed();
}

function rename(name) {
  queueSend('name', GT5.setPatchName(state.patch, name, dev()));
  changed(false);
}

// ---------------------------------------------------------------- patch selection

let loadToken = 0;

async function selectPatch(n, { send = true } = {}) {
  n = (n + GT5.ALL_PATCHES) % GT5.ALL_PATCHES;
  const wrote = flushAutoWrite();
  await flushSends();
  const token = ++loadToken;
  state.current = n;
  followPage();
  state.needsRead = Boolean(state.conn && !state.library[n]);
  showPatch(state.library[n] || GT5.defaultPatch());
  if (!send || !state.conn) return;
  try {
    await wrote;
    await Midi.selectPatch(state.conn, n, state.conn.channel);
    if (READ_BY_REQUEST && !state.library[n] && !state.noReplies) {
      // Unknown slot: ask the GT-5 for it, unless the user has moved on meanwhile.
      // The GT-5 is busy switching patch for a moment (the FloorBoard waits too).
      await new Promise(r => setTimeout(r, 200));
      if (token !== loadToken) return;
      $('#source').textContent = `Reading ${GT5.patchLabel(n)}…`;
      const { patch } = await Midi.readPatch(state.conn, n);
      state.library[n] = patch;
      state.source = `${GT5.patchLabel(n)} read from GT-5`;
      if (token === loadToken) showStored();
      renderDisplay();
      renderPatchMap();
    }
  } catch (e) {
    if (e.noReply) {
      state.noReplies = true;
      renderDisplay();
      Ask.alert({
        icon: 'error',
        title: 'The GT-5 does not answer',
        text: ['It received the request but sent no patch data back, so the editor stops asking by itself '
          + '(a stream of requests can leave the GT-5 stuck on "DATA SENDING" - switch it off and on if that happens).',
        'You can still get the patches: start a BULK DUMP on the GT-5 (UTILITY → MIDI → PARAMETER pages) - '
          + 'the editor takes in whatever the GT-5 sends. Then save them with Library → Save selected….',
        '"Read GT-5" or connecting again asks the GT-5 once more.'],
      });
      return;
    }
    if (token === loadToken) {
      renderDisplay();
      toast(`${GT5.patchLabel(n)}: ${e.message}${state.needsRead ? ' - edits are not sent to the GT-5 until it is read' : ''}`, 'error');
    }
  }
}

// The current slot's stored patch is known now (read, loaded, copied): show it, unless
// the user is editing - but the needsRead placeholder is never worth keeping.
function showStored() {
  if (!state.library[state.current] || (!state.needsRead && isDirty())) return;
  state.needsRead = false;
  showPatch(state.library[state.current]);
}

function showPatch(patch) {
  cancelAutoWrite();
  state.pendingOn.clear();
  state.touched.clear();
  state.patch = GT5.clonePatch(patch);
  state.original = GT5.clonePatch(patch);
  renderAll();
}

// Keep the patch map on the page that holds the current patch.
function followPage() {
  const bank = Math.floor(state.current / GT5.PATCHES_PER_BANK);
  state.area = GT5.isUser(state.current) ? 'user' : 'preset';
  state.page = Math.floor((state.area === 'user' ? bank : bank - USER_BANKS) / BANKS_PER_PAGE);
}

// ---------------------------------------------------------------- write / auto write

const AUTO_WRITE_DELAY = 5000; // keep in sync with the countdown animation in style.css
let autoTimer = null;

function queueAutoWrite() {
  cancelAutoWrite();
  if (!state.autoWrite || state.needsRead || !GT5.isUser(state.current) || !isDirty()) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    renderAutoPending();
    writeTo(state.current, { auto: true });
  }, AUTO_WRITE_DELAY);
  renderAutoPending();
}

function cancelAutoWrite() {
  clearTimeout(autoTimer);
  autoTimer = null;
  renderAutoPending();
}

// Write now instead of waiting; resolves when done (at once if nothing is pending).
function flushAutoWrite() {
  if (autoTimer === null) return Promise.resolve();
  cancelAutoWrite();
  return writeTo(state.current, { auto: true });
}

function setAutoWrite(on) {
  state.autoWrite = on;
  try { localStorage.setItem(AUTO_WRITE_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
  $('#auto-write').checked = on;
  if (on) track('auto-write-on');
  queueAutoWrite();
}

function renderAutoPending() {
  const btn = $('#store');
  btn.classList.remove('pending');
  if (autoTimer === null) return;
  void btn.offsetWidth; // reflow so the animation starts over
  btn.classList.add('pending');
}

// Store the edited patch into user patch n (and on the GT-5 when connected).
async function writeTo(n, { auto = false } = {}) {
  const patch = GT5.clonePatch(state.patch); // the user may go on editing while it is sent
  const label = GT5.patchLabel(n);
  // An auto write queued before the read would store the placeholder.
  if (auto && state.needsRead) return;
  cancelAutoWrite();
  try {
    await flushSends();
    if (state.conn) {
      await addLiveSwitches([patch], [label]);
      if (!await askBulkLoad(label)) return;
      await Midi.writePatch(state.conn, patch, n);
      await askExit(label);
      // The editor shows the assigns as written (the rest may have been edited meanwhile).
      for (const id of [0x03, 0x04]) state.patch.blocks[id] = patch.blocks[id].slice();
      for (const k of [0x04, 0x05]) state.patch.blocks[0x00][k] = patch.blocks[0x00][k];
      state.pendingOn.clear();  // the GT-5 loads the written patch below
      state.touched.clear();
    }
    state.library[n] = patch;
    state.needsRead = false; // the editor's sound is now what that slot holds
    if (state.conn) state.unsynced.delete(n); else state.unsynced.add(n);
    if (n !== state.current) {
      // Now editing the copy just stored.
      state.current = n;
      followPage();
    }
    state.original = GT5.clonePatch(patch);
    // The GT-5 loads it from its memory - also when it was the patch it was playing.
    if (state.conn) await Midi.selectPatch(state.conn, n, state.conn.channel);
    renderPatchMap();
    renderDisplay();
    refreshIndicators();
    if (state.view === 'library') renderView();
    const where = state.conn ? label : `${label} (editor only - offline)`;
    toast(auto ? `Auto-written to ${where}` : `Written to ${where}`);
    if (!auto) track(state.conn ? 'write-patch' : 'write-patch-offline');
  } catch (e) {
    toast(`${auto ? 'Auto write' : 'Write'} failed: ${e.message}`, 'error');
  }
}

// The GT-5 stores patches only through its BULK LOAD page (tried on a real unit):
// sent in normal play they are ignored. The page waits by itself; leaving it with
// EXIT makes the GT-5 check the data and store it, which takes about 5 seconds.
function askBulkLoad(what) {
  return Ask.confirm({
    icon: 'question',
    title: `Write ${what} to the GT-5`,
    text: ['1. On the GT-5 open UTILITY → MIDI and press PARAMETER until BULK LOAD. The display shows "waiting".',
      '2. Then click Send. The GT-5 shows "receiving" while it comes in.'],
    confirmText: 'Send',
  });
}

function askExit(what) {
  return Ask.alert({
    icon: 'success',
    title: 'Now press EXIT on the GT-5',
    text: [`The GT-5 checks the data and stores ${what} when it leaves BULK LOAD - press EXIT and wait about 5 seconds `
      + '(until it is back on its normal display).', 'Then click OK: the editor switches the GT-5 to the patch.'],
  });
}

function openWriteDialog() {
  const select = $('#write-target');
  const target = GT5.isUser(state.current) ? state.current : 0;
  select.replaceChildren(...Array.from({ length: GT5.USER_PATCHES }, (_, n) => {
    const p = state.library[n];
    const o = h('option', '', `${GT5.patchLabel(n)}  ${p ? GT5.patchName(p) : '-'}`);
    o.value = n;
    o.selected = n === target;
    return o;
  }));
  $('#write-msg').textContent = !state.conn
    ? 'Offline: the patch is only stored in the editor (save it to a file to keep it).'
    : state.needsRead
      ? 'This patch has not been read from the GT-5: it starts from the default patch, not from what the GT-5 holds.'
      : 'Next the editor asks you to put the GT-5 on its BULK LOAD page: only there does it store patches.';
  $('#write-dialog').showModal();
  select.focus();
}

function revert() {
  cancelAutoWrite();
  const before = state.patch;
  state.patch = GT5.clonePatch(state.original);
  sendChanges(before);
  changed();
}

function loadInit() {
  const before = state.patch;
  state.needsRead = false;
  state.patch = GT5.defaultPatch();
  sendChanges(before);
  changed();
  toast('Init patch loaded - Write stores it');
}

// ---------------------------------------------------------------- reading the GT-5

async function readUserPatches() {
  if (!state.conn) return;
  if (!READ_BY_REQUEST) { askForBulkDump(`the ${GT5.USER_PATCHES} user patches`); return; }
  state.noReplies = false;
  const box = Ask.progress({ title: 'Reading the GT-5', text: `The ${GT5.USER_PATCHES} user patches, one after the other.` });
  let n = 0;
  try {
    for (; n < GT5.USER_PATCHES; n++) {
      box.update(n / GT5.USER_PATCHES, `${GT5.patchLabel(n)}  ${n + 1} / ${GT5.USER_PATCHES}`);
      state.library[n] = (await Midi.readPatch(state.conn, n)).patch;
      state.unsynced.delete(n);
    }
    box.update(1, 'Done');
    state.source = 'Read from GT-5';
    toast(`Read ${GT5.USER_PATCHES} user patches`);
    track('read-gt5');
  } catch (e) {
    Ask.alert({ icon: 'error', title: 'Read failed', text: [`At ${GT5.patchLabel(n)}: ${e.message}`, `${n} patches were read before it.`] });
    track('read-gt5-failed');
  } finally {
    box.close();
    showStored();
    renderAll();
  }
}

// ---------------------------------------------------------------- files

// SysEx the GT-5 sent on its own (a Bulk Dump started on the unit): patches go
// to their memory slots (they are what the GT-5 holds), the temporary patch into
// the editor, system data to the System page.
function receiveDump(bytes) {
  const messages = GT5.splitSysex(bytes).filter(GT5.isGt5Dt1);
  if (!messages.length) return;
  const notes = [];
  // A full dump holds the system area (00-02), lists the editor doesn't use (03-06)
  // and the patches (07 and up, one group per patch address). Every part is
  // taken on its own, so one bad message doesn't lose the rest.
  const systemMessages = messages.filter(m => m[6] <= 0x02);
  const patchMessages = messages.filter(m => m[6] >= 0x07);
  const skipped = messages.length - systemMessages.length - patchMessages.length;
  let hasSystem = false;
  if (systemMessages.length) {
    try {
      state.system = GT5.decodeSystem(GT5.concat(systemMessages.map(fixChecksum)));
      state.systemSource = 'Bulk dump from GT-5';
      state.systemRead = true;
      hasSystem = true;
    } catch (e) {
      notes.push(`System settings: ${e.message}`);
    }
  }
  const groups = new Map();
  for (const m of patchMessages) {
    const key = `${m[6]} ${m[7]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const stored = [];
  let temp = false;
  for (const [key, group] of groups) {
    try {
      const r = GT5.decodePatch(group, { verifyChecksum: false });
      if (r.missing.length) notes.push(`${r.source === null ? 'Temp patch' : GT5.patchLabel(r.source)}: blocks ${r.missing.map(GT5.hex).join(' ')} missing - taken from the init patch`);
      if (r.source === null) {
        temp = true;
        state.needsRead = false;
        state.patch = r.patch;
        state.original = GT5.clonePatch(r.patch);  // what the GT-5 plays: its assigns are the live switches
        state.pendingOn.clear();
        state.touched.clear();
      } else {
        state.library[r.source] = r.patch;
        state.unsynced.delete(r.source);
        stored.push(r.source);
      }
    } catch (e) {
      notes.push(`Address ${key.split(' ').map(Number).map(GT5.hex).join(' ')}: ${e.message}`);
    }
  }
  if (!hasSystem && !stored.length && !temp) {
    Ask.alert({ icon: 'error', title: 'GT-5 data came, but nothing could be used', text: [`${messages.length} messages.`, ...notes] });
    return;
  }
  state.source = 'Bulk dump from GT-5';
  if (stored.includes(state.current)) {
    state.needsRead = false;
    showPatch(state.library[state.current]);
  }
  if (stored.length > 1) {
    state.lib.area = GT5.isUser(stored[0]) ? 'user' : 'all';
    location.hash = '#library';
  }
  renderAll();
  const what = [];
  if (stored.length) what.push(`${stored.length} patches (${GT5.patchLabel(Math.min(...stored))} … ${GT5.patchLabel(Math.max(...stored))})`);
  if (temp) what.push('the current (temporary) patch - it is in the editor now');
  if (hasSystem) what.push('the system settings (System page)');
  if (skipped) what.push(`${skipped} messages of other data the editor doesn't use`);
  Ask.alert({
    icon: notes.length ? 'warning' : 'success',
    title: 'Received from the GT-5',
    text: [`${what.join(', ')}.`, ...notes.slice(0, 6),
      'Save them now: Library → Select shown → Save selected…' + (hasSystem ? ', and System → Save file….' : '.')],
  });
  track('bulk-dump-received');
}

// Messages from the GT-5 itself are taken even with a wrong checksum (like files are).
function fixChecksum(m) {
  const body = m.slice(6, m.length - 2);
  const out = Uint8Array.from(m);
  out[out.length - 2] = GT5.checksum(body);
  return out;
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bytes = new Uint8Array(reader.result);
      if (isSystemFile(bytes)) { loadSystemFile(bytes, file.name); return; }
      // A saved full bulk dump (system + patches, e.g. from tools/gt5_tester.py receive): take it like a live one.
      const dt1s = GT5.splitSysex(bytes).filter(GT5.isGt5Dt1);
      if (dt1s.some(m => m[6] <= 0x02) && dt1s.some(m => m[6] >= 0x07)) { receiveDump(bytes); return; }
      const results = GT5.decodeFile(bytes);
      if (results.length === 1) {
        // One patch: into the editor, like picking a sound; Write stores it.
        const before = state.patch;
        state.needsRead = false;
        state.patch = results[0].patch;
        sendChanges(before);
        changed();
        toast(`Loaded ${file.name} into the editor - Write stores it`);
        track('load-file');
        return;
      }
      // A bulk dump: into the user patches, at their own numbers when the file has them.
      let next = 0;
      let count = 0;
      for (const r of results) {
        const n = r.source ?? next;
        next = n + 1;
        if (!GT5.isUser(n)) continue;
        state.library[n] = r.patch;
        state.unsynced.add(n);
        count++;
      }
      state.source = `File · ${file.name}`;
      if (state.library[state.current]) state.needsRead = false;
      showPatch(state.library[state.current] || GT5.defaultPatch());
      toast(`Loaded ${count} patches from ${file.name} (editor only - Write stores them one by one)`);
      track('load-file');
    } catch (e) {
      toast(`Load failed: ${e.message}`, 'error');
    }
  };
  reader.onerror = () => toast(`Load failed: ${reader.error?.message}`, 'error');
  reader.readAsArrayBuffer(file);
}

// The browser downloads `bytes` as `filename` (no server, no folder to write into).
function download(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = h('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A system dump has data in the system area (address 00-02) and none in the patch areas.
function isSystemFile(bytes) {
  const messages = GT5.splitSysex(bytes).filter(GT5.isGt5Dt1);
  return messages.length > 0 && messages.every(m => m[6] <= 0x02);
}

const saveWhat = () => document.querySelector('input[name="save-what"]:checked').value;

function renderFileDialog() {
  const unknown = state.library.slice(0, GT5.USER_PATCHES).filter(p => !p).length;
  $('#file-msg').textContent = saveWhat() === 'bank'
    ? `${GT5.USER_PATCHES} patches as one .syx dump${unknown ? ` - ${unknown} not read yet are saved as the init patch` : ''}.`
    : 'The sound in the editor, with its name, as a single-patch .syx file.';
  const name = $('#file-name');
  const base = saveWhat() === 'bank' ? 'gt5-user-patches' : (GT5.patchName(state.patch).trim() || 'patch').replace(/[^\w.-]+/g, '_');
  if (!name.dataset.touched) name.value = `${base}.syx`;
}

function openSaveDialog() {
  $('#file-name').dataset.touched = '';
  renderFileDialog();
  $('#file-dialog').showModal();
  $('#file-name').focus();
  $('#file-name').select();
}

function saveFile() {
  let filename = $('#file-name').value.trim();
  if (!filename) return;
  if (!/\.syx$/i.test(filename)) filename += '.syx';
  try {
    const patches = saveWhat() === 'bank'
      ? state.library.slice(0, GT5.USER_PATCHES).map(p => p || GT5.defaultPatch())
      : [state.patch];
    download(GT5.encodeFile(patches, { editor: true }), filename);
    $('#file-dialog').close();
    toast(`Saved ${filename}`);
    track('save-file');
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'error');
  }
}

// ---------------------------------------------------------------- controls

// Every control registers a paint function; repaint() runs them after an edit.
let painters = [];
const repaint = () => painters.forEach(p => p());

// What a control shows and changes: {p, get(), set(v, options), text(v)}. The
// controls take (block, offset) for a patch parameter, or a binding object in
// place of the block (and no offset) for anything else - the system settings.
function patchBinding(block, offset) {
  return {
    p: GT5.param(block, offset),
    get: () => value(block, offset),
    set: (v, options) => edit(block, offset, v, options),
    text: v => optionLabel(block, offset, v),
  };
}
const bind = (block, offset) => (typeof block === 'object' ? block : patchBinding(block, offset));

// `range` / `text` override the parameter's own range and value texts - the
// assign Min / Max knobs take them from the target parameter.
function knob(block, offset, label, { size = 'normal', range: limits = null, text: textOf = null } = {}) {
  const b = bind(block, offset);
  const p = limits ? { min: limits[0], max: limits[1] } : b.p;
  const wrap = h('div', `knob-wrap${size === 'normal' ? '' : ` ${size}`}`);
  const dial = h('div', 'knob');
  const out = h('span', 'knob-value');
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', label);
  dial.setAttribute('aria-valuemin', p.min);
  dial.setAttribute('aria-valuemax', p.max);
  dial.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">
    <path class="knob-track" d="${arc(-135, 135)}"/><path class="knob-fill"/>
    <circle class="knob-cap" cx="50" cy="50" r="31"/><circle class="knob-cap-top" cx="50" cy="50" r="25"/>
    <line class="knob-pointer" x1="50" y1="42" x2="50" y2="23"/></svg>`;
  wrap.append(h('span', 'knob-label', label), dial, out);
  const fill = dial.querySelector('.knob-fill');
  const pointer = dial.querySelector('.knob-pointer');
  const range = Math.max(1, p.max - p.min);

  function paint() {
    const v = b.get();
    const f = clamp((v - p.min) / range, 0, 1);
    const angle = -135 + 270 * f;
    fill.setAttribute('d', f > 0 ? arc(-135, angle) : '');
    pointer.setAttribute('transform', `rotate(${angle} 50 50)`);
    const text = textOf ? textOf(v) : b.text(v);
    out.textContent = text;
    dial.setAttribute('aria-valuenow', v);
    dial.setAttribute('aria-valuetext', text);
  }

  // Values outside the range (old garbage) show as they are and snap in on the first move.
  const set = n => b.set(clamp(Math.round(n), p.min, p.max));

  dial.addEventListener('pointerdown', e => {
    e.preventDefault();
    dial.focus();
    dial.setPointerCapture(e.pointerId);
    dial.classList.add('dragging');
    const startY = e.clientY;
    const startValue = clamp(b.get(), p.min, p.max);
    // Full sweep in roughly 180px whatever the range, but never finer than 2px per step.
    const pxPerStep = clamp(180 / range, 2, 22);
    const move = ev => set(startValue + (startY - ev.clientY) / pxPerStep);
    const up = () => {
      dial.classList.remove('dragging');
      dial.removeEventListener('pointermove', move);
      dial.removeEventListener('pointerup', up);
      dial.removeEventListener('pointercancel', up);
    };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
    dial.addEventListener('pointercancel', up);
  });
  dial.addEventListener('wheel', e => {
    e.preventDefault();
    set(b.get() + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  dial.addEventListener('keydown', e => {
    const v = b.get();
    const big = Math.max(1, Math.ceil(range / 10));
    const next = {
      ArrowUp: v + 1, ArrowRight: v + 1, ArrowDown: v - 1, ArrowLeft: v - 1,
      PageUp: v + big, PageDown: v - big, Home: p.min, End: p.max,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  });

  painters.push(paint);
  paint();
  return wrap;
}

function fader(block, offset, label) {
  const b = bind(block, offset);
  const wrap = h('label', 'fader-wrap');
  const out = h('span', 'knob-value');
  const input = h('input');
  input.type = 'range';
  input.min = b.p.min;
  input.max = b.p.max;
  input.setAttribute('aria-label', label);
  const paint = () => {
    input.value = b.get();
    out.textContent = b.text(b.get());
    input.setAttribute('aria-valuetext', out.textContent);
  };
  input.addEventListener('input', () => b.set(Number(input.value)));
  input.addEventListener('keydown', e => e.stopPropagation());
  input.addEventListener('wheel', e => {
    e.preventDefault();
    b.set(clamp(b.get() + (e.deltaY < 0 ? 1 : -1), b.p.min, b.p.max));
  }, { passive: false });
  painters.push(paint);
  paint();
  wrap.append(h('span', 'knob-label', label), input, out);
  return wrap;
}

// Horizontal slider with its value in the caption (assign ranges, pedal time / rate).
function slider(block, offset, label) {
  const b = bind(block, offset);
  const wrap = h('label', 'slider');
  const caption = h('span', 'slider-caption');
  const out = h('b');
  caption.append(`${label} · `, out);
  const input = h('input');
  input.type = 'range';
  input.min = b.p.min;
  input.max = b.p.max;
  const paint = () => {
    input.value = b.get();
    out.textContent = b.text(b.get());
    input.setAttribute('aria-valuetext', out.textContent);
  };
  input.addEventListener('input', () => b.set(Number(input.value)));
  input.addEventListener('keydown', e => e.stopPropagation());
  painters.push(paint);
  paint();
  wrap.append(caption, input);
  return wrap;
}

// Round on/off switch for a 0/1 parameter.
function onSwitch(block, offset, label) {
  const b = bind(block, offset);
  const btn = h('button', 'switch');
  btn.type = 'button';
  btn.setAttribute('aria-label', `${label} on/off`);
  btn.append(h('span'));
  btn.addEventListener('click', () => b.set(b.get() ? 0 : 1, { structural: true }));
  const paint = () => {
    const on = b.get() === 1;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  };
  painters.push(paint);
  paint();
  return btn;
}

// Segmented switch over the named values of a parameter.
function segmented(block, offset, { structural = false } = {}) {
  const b = bind(block, offset);
  const seg = h('div', 'seg');
  const buttons = GT5.options(b.p).map(([v, text]) => {
    const btn = h('button', '', EFFECTS.shortValue(text));
    btn.type = 'button';
    btn.addEventListener('click', () => b.set(v, { structural }));
    seg.append(btn);
    return [v, btn];
  });
  const paint = () => {
    const now = b.get();
    for (const [v, btn] of buttons) btn.setAttribute('aria-pressed', String(v === now));
  };
  painters.push(paint);
  paint();
  return seg;
}

function listBox(block, offset, label, { structural = false, cls = '' } = {}) {
  const b = bind(block, offset);
  const select = h('select', cls);
  select.setAttribute('aria-label', label);
  for (const [v, text] of GT5.options(b.p)) {
    const o = h('option', '', text);
    o.value = v;
    select.append(o);
  }
  select.addEventListener('change', () => b.set(Number(select.value), { structural }));
  select.addEventListener('keydown', e => e.stopPropagation());
  const paint = () => { select.value = b.get(); };
  painters.push(paint);
  paint();
  return select;
}

// Any parameter in the detail panel, as the control that fits it.
function control(pedal, o) {
  const { block, offset } = EFFECTS.where(pedal, o);
  const p = GT5.param(block, offset);
  const label = EFFECTS.caption(pedal, o);
  const kind = EFFECTS.widgetFor(p);
  if (kind === 'knob') return knob(block, offset, label);
  const wrap = h('div', 'ctl');
  wrap.append(h('span', 'knob-label', label), kind === 'seg' ? segmented(block, offset) : listBox(block, offset, label));
  return wrap;
}

// A pedal's on/off as a binding for the controls (the bit in block 00).
function onBinding(key) {
  return {
    p: { min: 0, max: 1 },
    get: () => (GT5.isOn(state.patch, key) ? 1 : 0),
    set: v => setOn(key, v === 1),
    text: v => (v ? 'On' : 'Off'),
  };
}

// The type picker: ◀ name ▶ on a little LCD window, the name being a list too.
function typeWindow(pedal) {
  const p = GT5.param(pedal.block, pedal.type);
  const win = h('div', 'typewin');
  const step = d => {
    const v = value(pedal.block, pedal.type);
    edit(pedal.block, pedal.type, v + d > p.max ? p.min : v + d < p.min ? p.max : v + d, { structural: true });
  };
  const prev = h('button', '', '◀');
  prev.type = 'button';
  prev.setAttribute('aria-label', `Previous ${pedal.abbr} type`);
  prev.addEventListener('click', () => step(-1));
  const next = h('button', '', '▶');
  next.type = 'button';
  next.setAttribute('aria-label', `Next ${pedal.abbr} type`);
  next.addEventListener('click', () => step(1));
  win.append(prev, listBox(pedal.block, pedal.type, `${pedal.abbr} type`, { structural: true }), next);
  return win;
}

// ---------------------------------------------------------------- pedals

// Pressing on any of these works the control; anywhere else on a pedal picks it up.
const PEDAL_CONTROLS = 'button, input, select, label, .knob';

function renderPedal(pedal, order, i) {
  const position = i + 1;
  const on = EFFECTS.isOn(pedal, state.patch);
  const { value: typeValue, def } = EFFECTS.typeOf(pedal, state.patch);
  const el = h('article', `pedal${on ? '' : ' off'}${pedal.wide ? ' wide' : ''}${state.detail === pedal.code ? ' selected' : ''}`);
  el.style.setProperty('--body', pedal.body);
  el.style.setProperty('--ink', pedal.ink);
  el.dataset.code = pedal.code;

  const top = h('div', 'pedal-top');
  const check = h('span', 'check', `${position} · CHECK`);
  const cc = pedal.always ? null : liveCc(pedal.code);
  const waiting = state.pendingOn.has(pedal.code);
  const led = h('span', `led${on ? ' on' : ''}${waiting ? ' waiting' : ''}`);
  top.append(check);
  if (cc !== null) {
    const live = h('span', 'live-tag', `CC${cc}`);
    live.title = `Live switch: on / off goes to the GT-5 as MIDI CC#${cc} (an assign of this patch)`;
    top.append(live);
  }
  if (waiting) led.title = 'On in the patch - the GT-5 plays it after Write';
  top.append(led);
  el.append(top);

  if (pedal.type !== undefined) el.append(pedal.typeUi === 'lcd' ? typeWindow(pedal) : segmented(pedal.block, pedal.type, { structural: true }));
  if (pedal.seg !== undefined) el.append(segmented(pedal.block, pedal.seg));

  if (!def) {
    el.append(h('p', 'pedal-note', `Unknown type (${typeValue})`));
  } else if (pedal.faders) {
    const faders = h('div', 'faders');
    for (const o of pedal.faders) {
      const { block, offset } = EFFECTS.where(pedal, o);
      faders.append(fader(block, offset, EFFECTS.caption(pedal, o)));
    }
    el.append(faders);
  } else {
    const knobs = h('div', 'knobs');
    for (const o of EFFECTS.mainParams(pedal, def)) {
      const { block, offset } = EFFECTS.where(pedal, o);
      knobs.append(knob(block, offset, EFFECTS.caption(pedal, o)));
    }
    el.append(knobs);
  }

  el.append(h('div', 'spacer'));
  const plate = h('button', 'plate');
  plate.type = 'button';
  plate.title = 'Show every parameter';
  plate.setAttribute('aria-expanded', String(state.detail === pedal.code));
  plate.append(h('span', 'plate-model', pedal.abbr), h('span', 'plate-name', pedal.title), h('span', 'plate-more', '⋯'));
  plate.addEventListener('click', () => openDetail(state.detail === pedal.code ? null : pedal.code));
  el.append(plate);

  if (pedal.always) {
    el.append(h('div', 'treadle', 'EXP'));
  } else {
    const foot = h('button', 'footswitch');
    foot.type = 'button';
    foot.setAttribute('aria-label', `${pedal.abbr} on/off`);
    foot.setAttribute('aria-pressed', String(on));
    if (cc === null && state.conn) foot.title = 'No live switch: off is heard at once, on only after Write';
    foot.addEventListener('click', () => setOn(pedal.code, !on));
    el.append(foot);
  }
  if (on) el.append(h('span', 'on-bar'));

  // Drag the pedal by its body to move it in the chain, like the chips above.
  el.addEventListener('pointerdown', e => { el.draggable = !e.target.closest(PEDAL_CONTROLS); });
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', String(i));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); el.draggable = false; });
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drop');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isInteger(from) && from !== i) moveInChain(order, from, i);
  });
  return el;
}

function renderMaster() {
  const el = h('div', 'module');
  el.append(h('span', 'module-title', 'Master'));
  for (const [block, offset, label] of EFFECTS.MASTER_KNOBS) el.append(knob(block, offset, label, { size: 'large' }));
  return el;
}

function renderChips(order) {
  const list = $('#chain-chips');
  list.replaceChildren();
  order.forEach((code, i) => {
    const pedal = EFFECTS.BY_CODE.get(code);
    const chip = h('li', `chip${EFFECTS.isOn(pedal, state.patch) ? '' : ' off'}`);
    chip.draggable = true;
    chip.tabIndex = 0;
    chip.title = `${pedal.title} - drag to move, click for its parameters`;
    const swatch = h('span', 'chip-swatch');
    swatch.style.background = pedal.body;
    chip.append(h('span', 'chip-n', String(i + 1)), swatch, h('span', '', pedal.abbr));
    chip.addEventListener('click', () => openDetail(code, { scroll: true }));
    chip.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(code, { scroll: true }); return; }
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const to = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to < 0 || to >= order.length) return;
      moveInChain(order, i, to);
      list.children[to]?.focus();
    });
    chip.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    chip.addEventListener('dragover', e => { e.preventDefault(); chip.classList.add('drop'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
    chip.addEventListener('drop', e => {
      e.preventDefault();
      chip.classList.remove('drop');
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isInteger(from) && from !== i) moveInChain(order, from, i);
    });
    list.append(chip);
  });
}

function moveInChain(order, from, to) {
  const next = order.slice();
  const [code] = next.splice(from, 1);
  next.splice(to, 0, code);
  setChain(next);
}

function renderBoard() {
  const order = EFFECTS.order(state.patch);
  const board = $('#chain');
  board.replaceChildren();
  order.forEach((code, i) => {
    if (!state.liveOnly || LIVE_CODES.has(code)) board.append(renderPedal(EFFECTS.BY_CODE.get(code), order, i));
  });
  $('#live-only').checked = state.liveOnly;
  board.append(renderMaster());
  renderChips(order);
  renderDetail();
}

// ---------------------------------------------------------------- detail panel

function openDetail(code, { scroll = false } = {}) {
  state.detail = code;
  renderView();
  if (scroll && code !== null) {
    document.querySelector(`.pedal[data-code="${code}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderDetail() {
  const panel = $('#detail');
  const pedal = state.detail === null ? null : EFFECTS.BY_CODE.get(state.detail);
  panel.hidden = !pedal;
  document.body.classList.toggle('detail-open', Boolean(pedal));
  panel.replaceChildren();
  if (!pedal) return;
  panel.style.setProperty('--body', pedal.body);

  const head = h('div', 'detail-head');
  const badge = h('span', 'detail-badge', pedal.abbr);
  badge.style.background = pedal.body;
  badge.style.color = pedal.ink;
  head.append(badge, h('h2', '', pedal.title));
  if (!pedal.always) {
    const on = EFFECTS.isOn(pedal, state.patch);
    const sw = h('button', `btn small onoff${on ? ' on' : ''}`, on ? 'ON' : 'OFF');
    sw.type = 'button';
    sw.setAttribute('aria-pressed', String(on));
    sw.addEventListener('click', () => setOn(pedal.code, !on));
    head.append(sw);
  }
  if (pedal.type !== undefined) head.append(listBox(pedal.block, pedal.type, `${pedal.abbr} type`, { structural: true, cls: 'detail-type' }));
  const close = h('button', 'btn small detail-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the detail panel');
  close.addEventListener('click', () => openDetail(null));
  head.append(close);
  panel.append(head);

  const { value: typeValue, def } = EFFECTS.typeOf(pedal, state.patch);
  const note = pedal.notes?.[typeValue] ?? pedal.notes?.all;
  if (note) panel.append(h('p', 'detail-note', note));
  const body = h('div', 'detail-body');
  for (const [title, offsets] of def ? def.groups : []) {
    const group = h('section', 'group');
    if (title) group.append(h('h3', '', title));
    const row = h('div', 'group-controls');
    for (const o of offsets) row.append(control(pedal, o));
    group.append(row);
    body.append(group);
  }
  panel.append(body);
}

// ---------------------------------------------------------------- display, map, status

function lcdInfo() {
  const type = (block, offset) => GT5.label(GT5.param(block, offset), value(block, offset));
  return `PRE:${type(0x01, 0x23)}  OD:${type(0x01, 0x1E)}`;
}

function renderDisplay() {
  $('#patch-label').textContent = GT5.patchLabel(state.current);
  $('#source').textContent = state.needsRead && !READ_BY_REQUEST
    ? `${GT5.patchLabel(state.current)} not read - send a Bulk Dump from the GT-5 (Read GT-5 tells how)`
    : state.source;
}

function refreshIndicators() {
  const dirty = isDirty();
  $('#edited').classList.toggle('on', dirty);
  $('#store').classList.toggle('primary', dirty);
  $('#revert').disabled = !dirty && GT5.samePatch(state.patch, state.original);
  $('#patch-name').textContent = GT5.patchName(state.patch) || ' ';
  $('#lcd-info').textContent = lcdInfo();
  $('#auto-write').closest('label').classList.toggle('dim', !GT5.isUser(state.current));
}

function renderPatchMap() {
  const user = state.area === 'user';
  const banks = user ? USER_BANKS : PRESET_BANKS;
  const pages = Math.ceil(banks / BANKS_PER_PAGE);
  state.page = clamp(state.page, 0, pages - 1);
  const first = state.page * BANKS_PER_PAGE;
  const last = Math.min(banks, first + BANKS_PER_PAGE) - 1;
  const prefix = user ? 'U' : 'P';
  const groups = Math.ceil(banks / BANKS_PER_PAGE);
  $('#pm-range').textContent = `Group ${prefix}${state.page + 1} of ${groups}`;
  $('#pm-prev').disabled = state.page === 0;
  $('#pm-next').disabled = state.page === pages - 1;

  const area = $('#pm-area');
  area.replaceChildren(...[['user', 'User'], ['preset', 'Preset']].map(([key, text]) => {
    const b = h('button', '', text);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.area === key));
    b.addEventListener('click', () => { state.area = key; state.page = 0; renderPatchMap(); });
    return b;
  }));

  const map = $('#patch-map');
  map.replaceChildren();
  for (let b = first; b <= last; b++) {
    const row = h('div', 'pm-bank');
    row.append(h('span', 'pm-bank-no', `${prefix}${state.page + 1}-${(b % BANKS_PER_PAGE) + 1}`));
    for (let i = 0; i < GT5.PATCHES_PER_BANK; i++) {
      const n = (user ? b : b + USER_BANKS) * GT5.PATCHES_PER_BANK + i;
      const patch = state.library[n];
      const cell = h('button', `pm-cell${n === state.current ? ' current' : ''}${patch ? '' : ' unknown'}${state.unsynced.has(n) ? ' unsynced' : ''}`);
      cell.type = 'button';
      const name = patch ? GT5.patchName(patch) : '';
      cell.title = `${GT5.patchLabel(n)} ${name || '(not read yet)'}${state.unsynced.has(n) ? ' - only in the editor, not on the GT-5' : ''}`;
      cell.append(h('span', 'pm-num', String(i + 1)), h('span', 'pm-name', name));
      cell.addEventListener('click', () => selectPatch(n));
      row.append(cell);
    }
    map.append(row);
  }
}

function renderStatus() {
  const btn = $('#conn-status');
  btn.classList.toggle('online', Boolean(state.conn));
  renderConnText();
  $('#lib-read').disabled = !state.conn;
  if (state.view === 'library' || state.view === 'system') renderView(); // their buttons depend on the connection
  if (state.view === 'system') readSystemOnce();
}

// Only the visible page is built; its controls register the painters.
function renderView() {
  painters = [];
  for (const view of VIEWS) $(`#view-${view}`).hidden = view !== state.view;
  document.body.classList.toggle('detail-open', state.view === 'effects' && state.detail !== null);
  for (const tab of document.querySelectorAll('.tab[data-view]')) {
    const on = tab.dataset.view === state.view;
    tab.classList.toggle('on', on);
    if (on) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  ({ effects: renderBoard, assign: renderAssign, library: renderLibrary, system: renderSystem })[state.view]();
}

function setView(view) {
  state.view = VIEWS.includes(view) ? view : 'effects';
  renderView();
  if (state.view === 'system') readSystemOnce();
}

function renderConnText() {
  $('#conn-text').textContent = state.conn
    ? `${state.conn.output} · Dev ${state.conn.dev + 1}${state.needsRead ? ' · not read' : ''}`
    : 'Offline';
}

function renderAll() {
  renderConnText();
  renderDisplay();
  renderPatchMap();
  renderView();
  refreshIndicators();
}

// ---------------------------------------------------------------- patch name

function startRename() {
  const btn = $('#patch-name');
  const input = $('#name-input');
  input.value = GT5.patchName(state.patch);
  btn.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function endRename(commit) {
  const btn = $('#patch-name');
  const input = $('#name-input');
  if (input.hidden) return;
  input.hidden = true;
  btn.hidden = false;
  if (commit && input.value !== GT5.patchName(state.patch)) rename(input.value);
  btn.focus();
}

// ---------------------------------------------------------------- connection

function connect(ports, { quiet = false } = {}) {
  state.noReplies = false;
  state.conn = ports;
  state.systemRead = false;
  try {
    if (ports) localStorage.setItem(CONN_KEY, JSON.stringify(ports)); else localStorage.removeItem(CONN_KEY);
  } catch { /* storage blocked */ }
  state.needsRead = false;
  renderStatus();
  $('#conn-dialog').close();
  // Start from what the GT-5 really holds: go to the current patch and read it if unknown.
  if (ports) selectPatch(state.current);
  else if (!quiet) toast('Offline - edits stay in the editor.');
}

// Reconnect to last session's ports if they are plugged in. Only asks the browser
// for MIDI when there was a connection before, so a first visit gets no prompt.
async function restoreConnection() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(CONN_KEY)); } catch { /* storage blocked */ }
  if (!saved?.output) return;
  try {
    await Midi.init();
    watchPorts();
    if (Midi.outputs().some(p => p.name === saved.output)) {
      state.conn = saved;
      renderStatus();
      toast(`Reconnected to ${saved.output} · Dev ${saved.dev + 1}`);
      track('reconnect');
      selectPatch(state.current);
    }
  } catch { /* stay offline; the connection dialog shows the reason */ }
}

let watching = false;
function watchPorts() {
  if (watching) return;
  watching = true;
  Midi.onPortsChanged(() => {
    if (state.conn && !Midi.outputs().some(p => p.name === state.conn.output)) {
      state.conn = null; // keep the saved ports, so plugging back in + reload reconnects
      state.needsRead = false;
      renderStatus();
      toast('MIDI interface unplugged - offline', 'error');
    }
    if ($('#conn-dialog').open) fillPortLists();
  });
}

function fillPortLists() {
  const outputs = Midi.outputs();
  const inputs = Midi.inputs();
  for (const [id, ports, current] of [['#port-out', outputs, state.conn?.output], ['#port-in', inputs, state.conn?.input]]) {
    const select = $(id);
    const keep = select.value || current;
    select.replaceChildren(...ports.map(p => {
      const o = h('option', '', p.name);
      o.selected = p.name === keep;
      return o;
    }));
  }
  $('#conn-msg').textContent = outputs.length ? '' : 'No MIDI ports found - is the interface plugged in?';
}

function numberOptions(select, count, selected) {
  select.replaceChildren(...Array.from({ length: count }, (_, i) => {
    const o = h('option', '', String(i + 1));
    o.value = i;
    o.selected = i === selected;
    return o;
  }));
}

// Only its end: during a bulk dump a full redraw of thousands of lines keeps the browser too busy.
function showLog() {
  const pre = $('#midi-log');
  pre.textContent = Midi.logText(300) || '(nothing yet)';
  pre.scrollTop = pre.scrollHeight;
}

async function openConnDialog() {
  const msg = $('#conn-msg');
  msg.textContent = 'Asking the browser for MIDI access…';
  numberOptions($('#port-dev'), GT5.DEVICE_IDS, state.conn?.dev ?? 0);
  numberOptions($('#port-channel'), MIDI_CHANNELS, state.conn?.channel ?? 0);
  $('#port-out').replaceChildren();
  $('#port-in').replaceChildren();
  $('#conn-dialog').showModal();
  showLog();  // what came and went while the dialog was closed
  try {
    await Midi.init();
    watchPorts();
    fillPortLists();
  } catch (e) {
    msg.textContent = e.message;
    if (navigator.requestMIDIAccess) track('midi-denied'); // no Web MIDI at all is counted on load
  }
}

async function autoDetect() {
  const btn = $('#conn-detect');
  btn.disabled = true;
  $('#conn-msg').textContent = 'Searching every port on all 32 device IDs…';
  try {
    await Midi.init();
    const found = await Midi.detectGt5();
    // Not yet checked on the unit: device ID 1-16 is taken to mean the same MIDI channel.
    if (found) {
      connect({ ...found, channel: found.dev % MIDI_CHANNELS });
      track('connect-auto');
    } else {
      $('#conn-msg').textContent = 'GT-5 not found on any MIDI port. Are MIDI IN and OUT both connected?';
      track('detect-not-found');
    }
  } catch (e) {
    $('#conn-msg').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('#prev').addEventListener('click', () => selectPatch(state.current - 1));
  $('#next').addEventListener('click', () => selectPatch(state.current + 1));
  $('#store').addEventListener('click', openWriteDialog);
  $('#write-ok').addEventListener('click', () => {
    $('#write-dialog').close();
    writeTo(Number($('#write-target').value));
  });
  $('#revert').addEventListener('click', revert);
  $('#auto-write').addEventListener('change', e => setAutoWrite(e.target.checked));
  $('#live-only').addEventListener('change', e => {
    state.liveOnly = e.target.checked;
    try { localStorage.setItem(LIVE_ONLY_KEY, state.liveOnly ? '1' : '0'); } catch { /* storage blocked */ }
    renderView();
  });
  $('#lib-init').addEventListener('click', loadInit);
  $('#lib-load').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', e => {
    const [file] = e.target.files;
    e.target.value = ''; // picking the same file again still fires change
    if (file) loadFile(file);
  });
  $('#lib-save').addEventListener('click', openSaveDialog);
  for (const radio of document.querySelectorAll('input[name="save-what"]')) radio.addEventListener('change', renderFileDialog);
  $('#file-name').addEventListener('input', e => { e.target.dataset.touched = '1'; });
  $('#file-ok').addEventListener('click', saveFile);
  $('#file-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveFile(); }
  });
  $('#lib-read').addEventListener('click', readUserPatches);
  $('#pm-prev').addEventListener('click', () => { state.page--; renderPatchMap(); });
  $('#pm-next').addEventListener('click', () => { state.page++; renderPatchMap(); });

  $('#patch-name').addEventListener('click', startRename);
  const nameInput = $('#name-input');
  nameInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
  });
  nameInput.addEventListener('blur', () => endRename(true));

  $('#conn-status').addEventListener('click', openConnDialog);
  $('#conn-detect').addEventListener('click', autoDetect);
  $('#conn-use').addEventListener('click', () => {
    const output = $('#port-out').value;
    const input = $('#port-in').value;
    if (!output) return;
    connect({ output, input, dev: Number($('#port-dev').value), channel: Number($('#port-channel').value) });
    track('connect-manual');
  });
  $('#conn-disconnect').addEventListener('click', () => connect(null));
  // Only drawn while open, and only its end: during a bulk dump a full redraw of
  // thousands of lines keeps the browser too busy. Copy log takes all of it.
  const logBox = $('#conn-dialog').querySelector('.midi-log');
  Midi.onLog(() => { if ($('#conn-dialog').open && logBox.open) showLog(); });
  logBox.addEventListener('toggle', showLog);
  $('#midi-log-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(Midi.logText()).then(() => toast('MIDI log copied'), () => toast('Copy failed', 'error'));
  });

  // Drop a .syx file anywhere on the page to load it.
  document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    loadFile(file);
  });

  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || e.target.closest('input, select, textarea, [role="slider"], .chip')) return;
    if (e.key === 'ArrowLeft') selectPatch(state.current - 1);
    if (e.key === 'ArrowRight') selectPatch(state.current + 1);
    if (e.key === 'Escape' && state.view === 'effects' && state.detail !== null) openDetail(null);
  });

  Midi.onDump(receiveDump);
  // While a bulk dump comes in, show that something is happening.
  let lastProgress = 0;
  Midi.onDumpProgress(n => {
    if (performance.now() - lastProgress < 250) return;
    lastProgress = performance.now();
    toast(`Receiving from the GT-5… ${(n / 1024).toFixed(1)} kB`);
  });
  wireLibrary();
  wireSystem();

  // The page is in the address (#assign), so reload and the back button keep it.
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
}

function init() {
  wire();
  // No auto write on the GT-5: every write needs its BULK LOAD page (see askBulkLoad).
  state.autoWrite = false;
  $('#auto-write').checked = state.autoWrite;
  try { state.liveOnly = localStorage.getItem(LIVE_ONLY_KEY) === '1'; } catch { /* storage blocked */ }
  followPage();
  state.view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'effects';
  showPatch(GT5.defaultPatch());
  renderStatus();
  restoreConnection();
  // Visitors on Safari / iOS can never connect - worth knowing how many arrive.
  if (!navigator.requestMIDIAccess) track('no-webmidi');
}

init();
