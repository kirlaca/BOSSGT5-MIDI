'use strict';

// Library page: all 250 patch memories as a list - name, amp / drive / effect
// types, which effects are on, and whether the editor's copy is on the GT-5.
// Patches are picked with the check boxes, then read, written, copied, reset to
// the init patch or saved as one file together (bulkLoadDialog / bulkSaveDialog).
// Uses the helpers of app.js (h, $, state, selectPatch, setView, download, ...).

const LIB_AREAS = [['user', 'User'], ['preset', 'Preset'], ['all', 'All']];
const WRITE_PAUSE_MS = 100; // breathing room for the GT-5 to store each patch

function libraryNumbers() {
  const { area, filter } = state.lib;
  const first = area === 'preset' ? GT5.USER_PATCHES : 0;
  const last = area === 'user' ? GT5.USER_PATCHES : GT5.ALL_PATCHES;
  const needle = filter.trim().toLowerCase();
  const out = [];
  for (let n = first; n < last; n++) {
    const patch = state.library[n];
    if (needle && !(patch && GT5.patchName(patch).toLowerCase().includes(needle))) continue;
    out.push(n);
  }
  return out;
}

const selection = () => [...state.lib.selected].sort((a, b) => a - b);
const typeText = (patch, block, offset) => EFFECTS.shortValue(GT5.label(GT5.param(block, offset), GT5.getValue(patch, block, offset)));

// "Harmonist" when FX-2 is on, "Slow Gear · Harmonist" when FX-1 is on too.
function fxText(patch) {
  const parts = [];
  if (GT5.isOn(patch, 0)) parts.push(typeText(patch, 0x01, 0x00));
  if (GT5.isOn(patch, 8)) parts.push(typeText(patch, 0x01, 0x39));
  return parts.join(' · ') || '-';
}

function effectDots(patch) {
  const dots = h('span', 'lib-dots');
  for (const code of EFFECTS.order(patch)) {
    const pedal = EFFECTS.BY_CODE.get(code);
    const dot = h('span', 'lib-dot');
    dot.title = pedal.abbr;
    if (!pedal.always && EFFECTS.isOn(pedal, patch)) dot.style.background = pedal.body;
    else dot.classList.add('off');
    dots.append(dot);
  }
  return dots;
}

function stateText(n) {
  if (n === state.current && isDirty()) return ['Editing', 'edit'];
  if (!state.library[n]) return ['Not read', 'unknown'];
  if (state.unsynced.has(n)) return ['Editor only', 'unsynced'];
  return ['', ''];
}

function renderLibraryRow(n) {
  const patch = state.library[n];
  const row = h('tr', `${n === state.current ? 'current' : ''}${state.lib.selected.has(n) ? ' selected' : ''}`);
  const pick = h('input');
  pick.type = 'checkbox';
  pick.checked = state.lib.selected.has(n);
  pick.setAttribute('aria-label', `Select ${GT5.patchLabel(n)}`);
  pick.addEventListener('change', () => {
    if (pick.checked) state.lib.selected.add(n); else state.lib.selected.delete(n);
    row.classList.toggle('selected', pick.checked);
    renderLibraryBar();
  });
  const open = h('button', 'lib-open', GT5.patchLabel(n));
  open.type = 'button';
  open.title = 'Open in the editor';
  open.addEventListener('click', () => { selectPatch(n); location.hash = '#effects'; });
  const [label, cls] = stateText(n);
  const cells = patch
    ? [GT5.patchName(patch), typeText(patch, 0x01, 0x23), typeText(patch, 0x01, 0x1E), fxText(patch), effectDots(patch)]
    : ['- - -', '', '', '', ''];
  row.append(h('td', '', ''), h('td'));
  row.firstChild.append(pick);
  row.children[1].append(open);
  cells.forEach((c, i) => {
    const td = h('td', i === 0 ? 'lib-name' : '');
    td.append(c);
    row.append(td);
  });
  row.append(h('td', `lib-state ${cls}`, label));
  return row;
}

function renderLibraryBar() {
  const sel = selection();
  const users = sel.filter(GT5.isUser);
  const known = sel.filter(n => state.library[n]);
  $('#lib-count').textContent = `${libraryNumbers().length} shown · ${sel.length} selected`;
  $('#lib-read-sel').disabled = !state.conn || !sel.length;
  $('#lib-write-sel').disabled = !state.conn || !users.some(n => state.library[n]);
  $('#lib-copy').disabled = !known.length;
  $('#lib-init-sel').disabled = !users.length;
  $('#lib-save-sel').disabled = !known.length;
}

function renderLibrary() {
  const area = $('#lib-area');
  area.replaceChildren(...LIB_AREAS.map(([key, text]) => {
    const b = h('button', '', text);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.lib.area === key));
    b.addEventListener('click', () => { state.lib.area = key; renderLibrary(); });
    return b;
  }));
  $('#lib-filter').value = state.lib.filter;
  $('#lib-rows').replaceChildren(...libraryNumbers().map(renderLibraryRow));
  renderLibraryBar();
}

// ---------------------------------------------------------------- actions

// Runs `step(n)` for every patch with a progress box; stops at the first error.
async function forEachPatch(title, numbers, step, text = "Don't unplug the MIDI cable or switch the GT-5 off.") {
  const box = Ask.progress({ title, text });
  let done = 0;
  try {
    for (const n of numbers) {
      box.update(done / numbers.length, `${GT5.patchLabel(n)}  ${done + 1} / ${numbers.length}`);
      await step(n);
      done++;
    }
    box.update(1, 'Done');
  } catch (e) {
    Ask.alert({ icon: 'error', title: `${title} stopped`, text: [e.message, `${done} of ${numbers.length} patches were done before it.`] });
  } finally {
    box.close();
    renderPatchMap();
    renderView();
  }
  return done;
}

async function libraryRead() {
  if (!READ_BY_REQUEST) { askForBulkDump('these patches'); return; }
  const numbers = selection();
  const done = await forEachPatch('Reading from the GT-5', numbers, async n => {
    state.library[n] = (await Midi.readPatch(state.conn, n)).patch;
    state.unsynced.delete(n);
  });
  if (done === numbers.length) toast(`Read ${done} patches`);
  track('library-read');
  if (numbers.includes(state.current)) showStored();
}

async function libraryWrite() {
  const numbers = selection().filter(n => GT5.isUser(n) && state.library[n]);
  const what = `${GT5.patchLabel(numbers[0])}${numbers.length > 1 ? ` … ${GT5.patchLabel(numbers[numbers.length - 1])}` : ''}`;
  if (!await Ask.confirm({
    icon: 'question',
    title: `Write ${numbers.length} patches to the GT-5?`,
    text: `${what} on the GT-5 are overwritten with the editor's copies.`,
    confirmText: 'Write',
  })) return;
  await flushAutoWrite();
  // Into the editor's copies too: they are what the GT-5 will hold.
  await addLiveSwitches(numbers.map(n => state.library[n]), numbers.map(GT5.patchLabel));
  if (!await askBulkLoad(`${numbers.length} patches`)) return;
  const done = await forEachPatch('Sending to the GT-5', numbers, async n => {
    await Midi.writePatch(state.conn, state.library[n], n);
    state.unsynced.delete(n);
    await new Promise(r => setTimeout(r, WRITE_PAUSE_MS));
  }, 'Leave the GT-5 on BULK LOAD and the MIDI cable in until it is done.');
  if (done) await askExit(`${done} patches`);
  if (done === numbers.length) toast(`Wrote ${done} patches`);
  track('library-write');
  // The GT-5 keeps playing its old temporary patch - load the current one again.
  if (numbers.includes(state.current)) Midi.selectPatch(state.conn, state.current, state.conn.channel).catch(() => {});
}

function openCopyDialog() {
  const numbers = selection().filter(n => state.library[n]);
  const select = $('#copy-target');
  const start = numbers.length && GT5.isUser(numbers[0]) ? numbers[0] : 0;
  select.replaceChildren(...Array.from({ length: GT5.USER_PATCHES - numbers.length + 1 }, (_, n) => {
    const p = state.library[n];
    const o = h('option', '', `${GT5.patchLabel(n)}  ${p ? GT5.patchName(p) : '-'}`);
    o.value = n;
    o.selected = n === start;
    return o;
  }));
  const skipped = selection().length - numbers.length;
  $('#copy-msg').textContent = `${numbers.length} patches, in order, into consecutive user patches. `
    + `They are copied in the editor only - "Write to GT-5" stores them.${skipped ? ` ${skipped} not read yet are left out.` : ''}`;
  $('#copy-dialog').showModal();
  select.focus();
}

async function libraryCopy() {
  const numbers = selection().filter(n => state.library[n]);
  const start = Number($('#copy-target').value);
  $('#copy-dialog').close();
  const targets = numbers.map((_, i) => start + i);
  const overwritten = targets.filter(n => state.library[n] && !numbers.includes(n));
  if (overwritten.length && !await Ask.confirm({
    title: `Overwrite ${overwritten.length} patches?`,
    text: `${GT5.patchLabel(targets[0])} … ${GT5.patchLabel(targets[targets.length - 1])} in the editor are replaced.`,
    confirmText: 'Copy',
  })) return;
  const copies = numbers.map(n => GT5.clonePatch(state.library[n])); // all first: source and target may overlap
  targets.forEach((n, i) => { state.library[n] = copies[i]; state.unsynced.add(n); });
  state.lib.selected = new Set(targets);
  if (targets.includes(state.current)) showStored();
  renderPatchMap();
  renderView();
  track('library-copy');
  toast(`Copied ${targets.length} patches to ${GT5.patchLabel(start)} - not on the GT-5 yet`);
}

async function libraryInit() {
  const numbers = selection().filter(GT5.isUser);
  if (!await Ask.confirm({
    title: `Init ${numbers.length} patches?`,
    text: 'They get the init patch in the editor - "Write to GT-5" stores it.',
    confirmText: 'Init',
  })) return;
  for (const n of numbers) { state.library[n] = GT5.defaultPatch(); state.unsynced.add(n); }
  if (numbers.includes(state.current)) showStored();
  renderPatchMap();
  renderView();
  track('library-init');
}

function librarySave() {
  const numbers = selection().filter(n => state.library[n]);
  const name = numbers.length === 1
    ? (GT5.patchName(state.library[numbers[0]]).trim() || 'patch').replace(/[^\w.-]+/g, '_')
    : `gt5-${GT5.patchLabel(numbers[0])}-${GT5.patchLabel(numbers[numbers.length - 1])}`;
  download(GT5.encodeFile(numbers.map(n => state.library[n]), { editor: true }), `${name}.syx`);
  toast(`Saved ${numbers.length} patches as ${name}.syx`);
  track('library-save');
}

function wireLibrary() {
  $('#lib-filter').addEventListener('input', e => {
    state.lib.filter = e.target.value;
    $('#lib-rows').replaceChildren(...libraryNumbers().map(renderLibraryRow));
    renderLibraryBar();
  });
  $('#lib-filter').addEventListener('keydown', e => e.stopPropagation());
  $('#lib-sel-all').addEventListener('click', () => { for (const n of libraryNumbers()) state.lib.selected.add(n); renderLibrary(); });
  $('#lib-sel-none').addEventListener('click', () => { state.lib.selected.clear(); renderLibrary(); });
  $('#lib-read-sel').addEventListener('click', libraryRead);
  $('#lib-write-sel').addEventListener('click', libraryWrite);
  $('#lib-copy').addEventListener('click', openCopyDialog);
  $('#copy-ok').addEventListener('click', libraryCopy);
  $('#lib-init-sel').addEventListener('click', libraryInit);
  $('#lib-save-sel').addEventListener('click', librarySave);
}
