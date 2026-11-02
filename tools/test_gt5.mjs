// Checks webmidi/gt5.js without a GT-5: against the Qt FloorBoard's own formulas
// and constants, default.syx / system.syx, and the patch files in packager/
// (Init Patches and saved patches, dumped from real GT-5s).
//
//     node tools/test_gt5.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(BASE, 'gt-5fxfloorboard_source_code_20250419');  // the Qt FloorBoard source
const WEB = path.join(BASE, 'webmidi');

const ctx = vm.createContext({ console, atob, performance });
for (const f of ['gt5-params.js', 'factory.js', 'gt5.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx, { filename: f });
}
const GT5 = vm.runInContext('GT5', ctx);
const P = vm.runInContext('GT5_PARAMS', ctx);

let failures = 0;
let checks = 0;
function check(ok, what) {
  checks++;
  if (!ok) { failures++; console.log(`FAIL  ${what}`); }
}
const hexStr = bytes => Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- constants (globalVariables.h)

check(hexStr(GT5.identityRequest(0)) === 'F0410000041100000000000000017FF7', 'identity request = idRequestString');
// globalVariables.h has checksum 7D there (copied from the GT-3's size 02 00 00 01); 79 is right.
check(hexStr(GT5.systemRequest(0)) === 'F041000004110000000002000005' + qtChecksum('F041000004110000000002000005') + 'F7', 'system request = systemRequest, with the right checksum');
check(GT5.PATCH_SIZE === 426 && GT5.FILE_PATCH_SIZE === 654, 'patchSize 426 / fullPatchSize 654');

// ---------------------------------------------------------------- MidiTable::patchRequest, re-done the C++ way

function qtChecksum(hex) {
  // MidiTable: sum of bytes from checksumOffset (6) on, then 128 - sum % 128 (00 stays 00).
  let sum = 0;
  for (let i = 6; i < hex.length / 2; i++) sum += parseInt(hex.substr(i * 2, 2), 16);
  const s = sum % 128;
  return (s ? 128 - s : 0).toString(16).toUpperCase().padStart(2, '0');
}
function qtPatchRequest(bank, patch) {
  let b = (bank * 5) - 5 + patch;
  let n = 0;
  if (b > 200) { n = 2; b -= 200; } else if (b > 100) { n = 1; b -= 100; }
  const a1 = (7 + n).toString(16).toUpperCase().padStart(2, '0');
  const a2 = (b - 1).toString(16).toUpperCase().padStart(2, '0');
  const msg = 'F041000004' + '11' + a1 + a2 + '0000' + '0000050C';
  return msg + qtChecksum(msg) + 'F7';
}
let prOk = true;
for (let n = 0; n < GT5.ALL_PATCHES; n++) {
  const bank = Math.floor(n / 5) + 1;
  const patch = (n % 5) + 1;
  if (hexStr(GT5.patchRequest(0, n)) !== qtPatchRequest(bank, patch)) { prOk = false; console.log('  patch', n, hexStr(GT5.patchRequest(0, n)), qtPatchRequest(bank, patch)); break; }
  const area = GT5.patchArea(n);
  if (GT5.patchFromArea(area[0], area[1]) !== n) { prOk = false; console.log('  area round trip', n); break; }
}
check(prOk, 'patchRequest / patchArea for all 250 patches match MidiTable::patchRequest');
const tempReq = 'F041000004110A0000000000050C';
check(hexStr(GT5.patchRequest(0)) === tempReq + qtChecksum(tempReq) + 'F7', 'temp patch request (0A 00)');
// floorBoardDisplay::writeToMemory, for the user banks.
let wmOk = true;
for (let n = 0; n < GT5.USER_PATCHES; n++) {
  const a = GT5.patchArea(n);
  if (a[0] !== 7 + Math.floor(n / 128) || a[1] !== n % 128) wmOk = false;
}
check(wmOk, 'user patch addresses match writeToMemory');
check(GT5.patchLabel(0) === 'U1-1-1' && GT5.patchLabel(99) === 'U4-5-5' && GT5.patchLabel(100) === 'P1-1-1' && GT5.patchLabel(249) === 'P6-5-5', 'patch labels (setPatchNumDisplay)');

// ---------------------------------------------------------------- SysxIO::getPatchChangeMsg

let pcOk = true;
for (let n = 0; n < GT5.ALL_PATCHES; n++) {
  const msb = Math.floor(n / 100).toString(16).padStart(2, '0');
  const pc = (n % 100).toString(16).padStart(2, '0');
  if (hexStr(GT5.programChange(n)) !== ('B000' + msb + 'B02000C0' + pc).toUpperCase()) { pcOk = false; break; }
}
check(pcOk, 'program change matches getPatchChangeMsg for all patches');

// ---------------------------------------------------------------- default.syx round trip

const defaultSyx = fs.readFileSync(path.join(ROOT, 'default.syx'));
const def = GT5.defaultPatch();
check(same(Array.from(GT5.encodeFile(def, { editor: true })), Array.from(defaultSyx)), 'default.syx -> patch -> file is byte-identical (654 bytes)');
check(GT5.patchName(def) === 'default', `default patch name: "${GT5.patchName(def)}"`);
console.log(`      default patch chain ${GT5.chain(def).join(',')}`);

// ---------------------------------------------------------------- on/off bits (stompBox.cpp)

const onNames = ['FX1', 'CS', 'WAH', 'LOOP', 'OD', 'PRE', 'SPKR', 'EQ', 'FX2', 'DD', 'CE', 'TP', 'RV', 'NS'];
console.log(`      default patch on: ${onNames.filter((_, c) => GT5.isOn(def, c)).join(' ')}`
  + ` · EXP ${GT5.isOn(def, 'exp')} CTL ${GT5.isOn(def, 'ctl')} A1 ${GT5.isOn(def, 'a1')}`);
check(GT5.isOn(def, 12) && GT5.isOn(def, 13) && GT5.isOn(def, 4) && GT5.isOn(def, 5) && !GT5.isOn(def, 0), 'default patch: RV NS OD PRE on, FX1 off');
const pb = GT5.defaultPatch();
const mOn = GT5.setOn(pb, 9, true);            // DD: offset 01, bit 0x02
check(hexStr(mOn) === 'F041000004120B000001' + '02' + qtChecksum('F041000004120B00000102') + 'F7' && GT5.isOn(pb, 9), `DD on: ${hexStr(mOn)}`);
GT5.setOn(pb, 8, true);
GT5.setOn(pb, 9, false);
check(pb.blocks[0][1] === 0x01 && GT5.isOn(pb, 8) && !GT5.isOn(pb, 9), 'FX2 on, DD off: byte 01 = 01');

// ---------------------------------------------------------------- system.syx

const sysMsgs = GT5.splitSysex(Array.from(fs.readFileSync(path.join(ROOT, 'system.syx'))));
let sysOk = true;
for (const m of sysMsgs) { try { GT5.parseDt1(m); } catch (e) { sysOk = false; console.log('  ', e.message); } }
check(sysOk && sysMsgs.length > 0, `system.syx: ${sysMsgs.length} DT1 messages, all checksums ok`);
check(same(Array.from(GT5.systemSyx()), Array.from(fs.readFileSync(path.join(ROOT, 'system.syx')))), 'factory.js system.syx = system.syx');
check(GT5.systemSyx().length === GT5.SYSTEM_SIZE, `system dump is ${GT5.SYSTEM_SIZE} bytes`);

const sys = GT5.decodeSystem(GT5.systemSyx());
let sysParams = 0;
let sysInRange = 0;
for (const area of GT5.SYSTEM_AREAS) {
  for (const p of area.params) {
    sysParams++;
    const v = GT5.getSystemValue(sys, area, p.offset);
    if (v !== null && v >= p.min && v <= p.max) sysInRange++;
    else console.log(`      ${area.address.map(GT5.hex).join(' ')} ${p.offset} ${p.name}: ${v}`);
  }
}
check(sysInRange === sysParams, `system.syx holds all ${sysParams} system parameters, in range (${sysInRange})`);
const tuner = GT5.systemArea('Tuner');
const midiArea = GT5.systemArea('Midi');
console.log(`      tuner ${GT5.label(tuner.params[0], GT5.getSystemValue(sys, tuner, 0))}, `
  + `EXP pedal out ${GT5.label(midiArea.params[1], GT5.getSystemValue(sys, midiArea, 1))}`);
const sysEdit = GT5.cloneSystem(sys);
const sm = GT5.setSystemValue(sysEdit, midiArea, 1, 9, 3);
check(hexStr(sm) === `F0410300041201020001` + `09${hexStr([GT5.checksum([1, 2, 0, 1, 9])])}F7`
  && GT5.getSystemValue(sysEdit, midiArea, 1) === 9 && GT5.getSystemValue(sys, midiArea, 1) !== 9,
'system edit: DT1 01 02 00 <offset> with the device ID, stored in the copy only (MidiTable::dataChange)');
const sysBack = GT5.decodeSystem(GT5.concat(GT5.encodeSystem(sysEdit)));
check(sysBack.length === sysEdit.length && sysBack.every((c, i) => same(c.address, sysEdit[i].address) && same(Array.from(c.data), Array.from(sysEdit[i].data))),
  `system encode -> decode keeps all ${sysEdit.length} chunks`);

// ---------------------------------------------------------------- the real patches

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(path.join(ROOT, 'packager')).filter(f => f.toLowerCase().endsWith('.syx'));
let rt = 0;
let patchCount = 0;
let shortName = 0;
let badChecksums = 0;
const foreign = [];
// Compare ignoring checksums: files with wrong ones (80 for 00, one off) come back corrected.
const withoutChecksums = bytes => GT5.splitSysex(bytes).flatMap(m => Array.from(m.slice(0, -2)));
const goodChecksums = bytes => GT5.splitSysex(bytes).every(m => m[0] !== 0xF0 || m[1] !== 0x41 || GT5.checksum(m.slice(6, -2)) === m[m.length - 2]);
const outOfRange = new Map();   // "block/offset name" -> count
const all = [];
for (const f of files) {
  const bytes = Array.from(fs.readFileSync(f));
  const rel = path.relative(ROOT, f);
  let res;
  if (!GT5.splitSysex(bytes).some(GT5.isGt5Dt1)) { foreign.push(rel); continue; }  // other units' files
  try {
    res = GT5.decodeFile(bytes);
  } catch (e) {
    check(false, `${rel}: ${e.message}`);
    continue;
  }
  if (!goodChecksums(bytes)) badChecksums++;
  const editor = GT5.splitSysex(bytes).some(m => m[1] === 0x00);
  if (res.some(r => r.missing.length)) { check(false, `${rel}: missing blocks ${res.find(r => r.missing.length).missing}`); continue; }
  patchCount += res.length;
  // Re-encode at the addresses the file came with, then compare.
  const again = GT5.concat(res.flatMap(r => (r.source === null
    ? GT5.encodePatch(r.patch, { to: 'file', editor })
    : [...GT5.encodePatch(r.patch, { to: r.source, dev: bytes[2] }),
      ...(editor ? GT5.encodePatch(r.patch, { to: 'file', editor }).slice(GT5.PATCH_PACKETS) : [])])));
  const short = res.length * GT5.PATCH_SIZE - bytes.length;  // old files: 11-byte name blocks
  if (same(withoutChecksums(again), withoutChecksums(bytes))) rt++;
  else if (short > 0 && short <= res.length) { rt++; shortName++; }
  else check(false, `${rel}: re-encoded bytes differ (${bytes.length} -> ${again.length})`);
  for (const { patch } of res) {
    all.push(patch);
    for (const b of P.blocks) {
      if (b.editorOnly) continue;
      for (const p of b.params) {
        const v = GT5.getValue(patch, b.id, p.offset);
        const key = `${GT5.hex(b.id)}/${GT5.hex(p.offset)} ${p.name}`;
        if (v < p.min || v > p.max) outOfRange.set(key, (outOfRange.get(key) || 0) + 1);
      }
    }
  }
}
console.log(`      ${foreign.length} files are from other units (not GT-5 SysEx), skipped: ${foreign.map(f => path.basename(f)).join(', ')}`);
console.log(`      ${badChecksums} files have wrong checksums (80 for 00, or one off) - loaded anyway, like the FloorBoard does`);
check(rt === files.length - foreign.length, `${rt}/${files.length - foreign.length} patch files (${patchCount} patches) decode and re-encode byte-identically`
  + `${shortName ? ` - ${shortName} old files with an 11-byte name come back with the GT-5's 12` : ''}`);
if (outOfRange.size) {
  console.log(`      values outside the midi.xml range in the files (${outOfRange.size} parameters) - informative, not a failure:`);
  for (const [k, n] of [...outOfRange].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`        ${n.toString().padStart(4)} x ${k}`);
}
const badChains = all.filter(p => !GT5.isValidChain(GT5.chain(p))).length;
console.log(`      ${badChains} of ${all.length} patches have a broken effect chain`);

// Bulk: several patches in one file.
const bulk = GT5.encodeFile(all.slice(0, 3));
const back = GT5.decodeFile(Array.from(bulk));
check(back.length === 3 && back.every((r, i) => P.blocks.every(b => b.editorOnly || same(Array.from(r.patch.blocks[b.id]), Array.from(all[i].blocks[b.id])))),
  'bulk file of 3 patches splits back into 3');

// ---------------------------------------------------------------- labels (MidiTable::rangeToValue)

const lbl = (b, o, v) => GT5.label(GT5.param(b, o), v);
check(lbl(0x01, 0x1F, 50) === '50 %', `OD drive 50 -> "${lbl(0x01, 0x1F, 50)}"`);
check(lbl(0x01, 0x1E, 0) === 'Natural OD', `OD type 0 -> "${lbl(0x01, 0x1E, 0)}"`);
check(lbl(0x02, 0x0E, 1800) === '1800ms' && lbl(0x02, 0x0E, 300) === '300ms', `delay time -> "${lbl(0x02, 0x0E, 300)}" / "${lbl(0x02, 0x0E, 1800)}"`);
check(lbl(0x01, 0x7E, 2) === '-2', `SYN octave 2 -> "${lbl(0x01, 0x7E, 2)}" (midi.xml typo fixed)`);
check(lbl(0x01, 0x30, 20) === '0dB' && lbl(0x01, 0x30, 0) === '-20dB', `EQ low -> "${lbl(0x01, 0x30, 0)}" / "${lbl(0x01, 0x30, 20)}"`);

// ---------------------------------------------------------------- live edit messages (MidiTable::dataChange)

const p = GT5.defaultPatch();
const m1 = GT5.setValue(p, 0x01, 0x1F, 77);
const want1 = 'F041000004120B00011F4D';
check(hexStr(m1) === want1 + qtChecksum(want1) + 'F7', `OD drive edit: ${hexStr(m1)}`);
const m2 = GT5.setValue(p, 0x02, 0x0E, 600);      // two-byte: 600 = 04 58
const want2 = 'F041000004120B00020E0458';
check(hexStr(m2) === want2 + qtChecksum(want2) + 'F7' && GT5.getValue(p, 0x02, 0x0E) === 600, `delay time edit: ${hexStr(m2)}`);
let threw = false;
try { GT5.setValue(p, 0x01, 0x1F, 101); } catch { threw = true; }
check(threw, 'out-of-range value is refused');
const m3 = GT5.setPatchName(p, 'Hello');
check(GT5.patchName(p) === 'Hello' && m3.length === 11 && hexStr(m3[0]).startsWith('F041000004120B00050048')
  && hexStr(m3[10]).startsWith('F041000004120B00050A20'), 'patch name edit: one DT1 per letter (0B 00 05 00 … 0A)');
const order = GT5.chain(p).slice().reverse();
const m4 = GT5.setChain(p, order);
check(m4.length === 15 && hexStr(m4[0]).startsWith('F041000004120B000008') && hexStr(m4[14]).startsWith('F041000004120B000016')
  && same(GT5.chain(p), order), 'chain edit: one DT1 per slot, 0B 00 00 08 … 16');
const temp = GT5.encodePatch(p, { to: 'temp', dev: 5 });
check(temp.length === 6 && temp.every(m => m[2] === 5 && m[6] === 0x0A && m[7] === 0x00), 'whole patch to temp: 6 DT1 to 0A 00 (writeToBuffer)');

// ---------------------------------------------------------------- live changes (tried on a real GT-5)

const a = GT5.defaultPatch();
const b = GT5.clonePatch(a);
GT5.setValue(b, 0x01, 0x1F, 90);          // OD drive
GT5.setValue(b, 0x02, 0x0E, 600);         // delay time, two bytes
GT5.setOn(b, 9, !GT5.isOn(a, 9));         // DD on/off
GT5.setPatchName(b, 'Live');
GT5.setValue(b, 0x03, 0x02, 5);           // EXP min: not in the temporary patch
const lc = GT5.liveChanges(a, b);
const names = lc.messages.map(m => GT5.hexBytes(m.slice(6, 10)));
// "default" -> "Live   " changes 7 letters
check(lc.messages.length === 1 + 1 + 1 + 7 && lc.skipped >= 1, `live changes: one message per parameter / letter, assign skipped (${lc.messages.length} msgs, ${lc.skipped} skipped)`);
check(names.includes('0B 00 01 1F') && names.includes('0B 00 02 0E') && names.includes('0B 00 00 01') && names.includes('0B 00 05 00')
  && lc.messages.every(m => m.length <= 14), 'live changes: addresses 0B 00 …, at most 2 data bytes each');
check(GT5.liveChanges(a, a).messages.length === 0, 'no change -> nothing to send');
const other = GT5.decodeFile(fs.readFileSync(path.join(ROOT, 'packager', 'Init Patches', 'Fender.syx')))[0].patch;
console.log(`      a whole different patch would take ${GT5.liveChanges(a, other).messages.length} messages (the editor sends at most 10)`);

// ---------------------------------------------------------------- assign targets

let tOk = 0;
for (const t of GT5.TARGETS) if (GT5.target(t.code).param) tOk++;
check(tOk === GT5.TARGETS.length, `${tOk}/${GT5.TARGETS.length} assign targets point at a known parameter`);
const t0 = GT5.target(0x65);
console.log(`      target 0x65 = "${t0.name}" -> block ${GT5.hex(t0.block)} offset ${GT5.hex(t0.offset)} (${t0.param?.name}, ${t0.param?.min}-${t0.param?.max})`);
const tOnOff = GT5.target(0x00);
check(tOnOff.virtual && tOnOff.param.max === 1, `on/off target -> virtual Off/On (${tOnOff.param.name})`);

// ---------------------------------------------------------------- live switches

// Every On/Off target code the layout uses is the "<effect>: On/Off" (or FB "Off/On") entry of the target table.
const switchable = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13];  // TP has no On/Off target
let onOk = 0;
for (const code of switchable) {
  const t = GT5.target(GT5.onTarget(a, code));
  if (t && t.virtual && /: (On\/Off|Off\/On)$/.test(t.name)) onOk++;
}
check(onOk === switchable.length, `on/off targets of the effects are On/Off entries of the target table (${onOk})`);

// The patch tried on the GT-5 (tools/livesw_test.txt): FX1 on CC#22 there, the layout now has EQ on it.
const tried = GT5.decodePatch(fs.readFileSync(path.join(BASE, 'tools', 'livesw_test.txt'), 'utf8').trim().split('\n')
  .map(l => Uint8Array.from(l.trim().split(' '), x => parseInt(x, 16))), { verifyChecksum: false }).patch;
check([[4, 20], [5, 21], [0, 22], [8, 23], [9, 24], [10, 25], [12, 26], [2, 27], [7, null]].every(([c, cc]) => GT5.liveSwitch(tried, c) === cc)
  && GT5.ownAssigns(tried).length === 0, 'live switches of the tried patch found (FX1 CC22, ..., WAH CC27)');

const ls = GT5.clonePatch(tried);
GT5.setLiveSwitches(ls);
const lsDiff = [0x00, 0x03, 0x04].flatMap(id => [...ls.blocks[id]].map((x, k) => (x !== tried.blocks[id][k] ? `${GT5.hex(id)}/${GT5.hex(k)}` : null)).filter(Boolean));
check(GT5.hasLiveSwitches(ls) && lsDiff.join() === '03/2E' && GT5.liveSwitch(ls, 7) === 22,
  `setLiveSwitches = the tried layout with EQ in place of FX1 (differs at ${lsDiff.join(' ')})`);
GT5.setValue(ls, 0x01, 0x39, 1);  // FX2 Harmonist -> Flanger: its live switch is out of date until written again
check(GT5.liveSwitch(ls, 8) === null && !GT5.hasLiveSwitches(ls) && GT5.ownAssigns(ls).length === 0,
  'FX2 type change: the old switch no longer counts, but is no "own" assign either');
const factoryOwn = GT5.decodeFile(fs.readFileSync(path.join(BASE, 'gt5-gyari.syx'))).filter(r => GT5.ownAssigns(r.patch).length).length;
check(factoryOwn === 32, `factory user patches with their own assigns: ${factoryOwn} (expected 32)`);
check(GT5.liveSwitchMessages(25, false, 0).map(GT5.hexBytes).join(' | ') === 'B0 19 7F | B0 19 00',
  'switch off: CC 127 first, then 0 (the assign acts on a change only)');

// The messages tried on a real GT-5 (2026-10-24): OD Level 10, then the Sound Change Request.
const scrPatch = GT5.defaultPatch();
const scrRun = GT5.withSoundChange([GT5.setValue(scrPatch, 0x01, 0x22, 10, 0)], 0).map(GT5.hexBytes);
check(scrRun.join(' | ') === 'F0 41 00 00 04 12 0B 00 01 22 0A 48 F7 | F0 41 00 00 04 12 0A 00 06 00 00 70 F7',
  `parameter + Sound Change Request: ${scrRun.join(' | ')}`);

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` - ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
