// Runs webmidi/midi.js against a simulated GT-5 behind a fake Web MIDI API:
// port detection, device ID detection, patch read, patch write, program change,
// system read.
//
//     node tools/test_midi.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(BASE, 'webmidi');

// ---------------------------------------------------------------- fake Web MIDI + GT-5

const GT5_DEV = 0x10;   // the simulated unit answers only on device ID 10 (17)
const sent = [];        // everything the GT-5 received

class FakeInput extends EventTarget {
  constructor(name) { super(); this.name = name; }
  async open() {}
  deliver(bytes) {
    const e = new Event('midimessage');
    e.data = Uint8Array.from(bytes);
    // Real Web MIDI is asynchronous; so is this.
    setTimeout(() => { this.onmidimessage?.(e); this.dispatchEvent(e); }, 2);
  }
}

class FakeOutput {
  constructor(name, onSend) { this.name = name; this.onSend = onSend; }
  async open() {}
  send(data) { this.onSend(Uint8Array.from(data)); }
}

let GT5;   // filled once the editor scripts are loaded
let stored = null;   // the user patch the fake GT-5 holds at U1-1-1
const gt5In = new FakeInput('GT-5 MIDI IN (from GT-5)');
const otherIn = new FakeInput('Other synth IN');
function gt5Receives(m) {
  sent.push(m);
  if (m[0] !== 0xF0) return;
  if (!(m[1] === 0x41 && m[3] === 0x00 && m[4] === 0x04 && m[2] === GT5_DEV)) return; // not for us
  if (m[5] === 0x11) {
    const address = Array.from(m.slice(6, 10));
    if (address.every(b => b === 0) && m[10] === 0x02) {
      if (GT5.checksum(m.slice(6, 14)) !== m[14]) return;   // a real Roland unit ignores bad checksums
      // The whole system area: system.syx, sent with the unit's own device ID.
      for (const c of GT5.decodeSystem(GT5.systemSyx())) gt5In.deliver(GT5.dt1(GT5_DEV, c.address, c.data));
    } else if (address[0] <= 0x02) {
      // A piece of the system area (the identity request is its first byte, tuner 440 Hz).
      const size = m[12] * 128 + m[13];
      if (size > 0x7F) return;
      const c = GT5.decodeSystem(GT5.systemSyx()).find(x => x.address.slice(0, 3).join() === address.slice(0, 3).join()
        && address[3] >= x.address[3] && address[3] < x.address[3] + x.data.length);
      if (!c) return;
      const from = address[3] - c.address[3];
      gt5In.deliver(GT5.dt1(GT5_DEV, address, c.data.slice(from, from + size)));
    } else if (address[0] >= 0x07 && !(m[12] === 0x05 && m[13] === 0x0C)) {
      // One block, as the editor asks now (the whole-patch request hangs a real GT-5).
      const n = GT5.patchFromArea(address[0], address[1]);
      const patch = n === 0 && stored ? stored : GT5.defaultPatch();
      const msgs = GT5.encodePatch(patch, { to: n === null ? 'temp' : n, dev: GT5_DEV });
      const block = GT5.parseDt1(msgs.find(x => x[8] === address[2])).data;
      const size = m[12] * 128 + m[13];
      if (size > 0x7F) return;   // like the real GT-5: no answer to a 128-byte request
      gt5In.deliver(GT5.dt1(GT5_DEV, address, block.slice(address[3], address[3] + size)));
    } else if (address[2] === 0 && address[3] === 0) {
      const n = GT5.patchFromArea(address[0], address[1]);
      const patch = n === 0 && stored ? stored : GT5.defaultPatch();
      // The GT-5 answers with its own patch address in every message (0A 00 for the temp patch).
      const to = n === null ? 'temp' : n;
      for (const msg of GT5.encodePatch(patch, { to, dev: GT5_DEV })) gt5In.deliver(msg);
    }
  } else if (m[5] === 0x12) {
    // Collect a patch write into U1-1-1.
    const { address, data } = GT5.parseDt1(m);
    if (address[0] === 0x07 && address[1] === 0x00) {
      stored = stored || GT5.defaultPatch();
      stored.blocks[address[2]].set(data, address[3]);
    }
  }
}
const access = {
  outputs: new Map([
    ['o1', new FakeOutput('Other synth OUT', () => {})],
    ['o2', new FakeOutput('GT-5 MIDI OUT (to GT-5)', gt5Receives)],
  ]),
  inputs: new Map([['i1', otherIn], ['i2', gt5In]]),
};

const ctx = vm.createContext({
  console, atob, performance, setTimeout, clearTimeout, Event, EventTarget,
  navigator: { requestMIDIAccess: async opts => { if (!opts?.sysex) throw new Error('sysex not asked'); return access; } },
});
for (const f of ['gt5-params.js', 'factory.js', 'gt5.js', 'midi.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx, { filename: f });
}
GT5 = vm.runInContext('GT5', ctx);
const Midi = vm.runInContext('Midi', ctx);

// ---------------------------------------------------------------- tests

let failures = 0;
let checks = 0;
function check(ok, what) {
  checks++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
}

await Midi.init();
const t0 = performance.now();
const conn = await Midi.detectGt5();
check(conn && conn.output === 'GT-5 MIDI OUT (to GT-5)' && conn.input === 'GT-5 MIDI IN (from GT-5)' && conn.dev === GT5_DEV,
  `detect: ${JSON.stringify(conn)} in ${Math.round(performance.now() - t0)} ms`);

const temp = await Midi.readPatch(conn);
check(GT5.hexBytes(sent.filter(m => m[0] === 0xF0).at(-1).slice(6, 8)) === '0A 00', 'temp patch is read from 0A 00');
check(temp.source === null && GT5.patchName(temp.patch) === GT5.patchName(GT5.defaultPatch()), `read temp patch: "${GT5.patchName(temp.patch)}"`);

const edited = GT5.defaultPatch();
GT5.setValue(edited, 0x01, 0x1F, 88);
GT5.setPatchName(edited, 'Web MIDI');
sent.length = 0;
const t1 = performance.now();
await Midi.writePatch(conn, edited, 0);
const sysex = sent.filter(m => m[0] === 0xF0);
check(sysex.length === 6 && sysex.every(m => m[6] === 0x07 && m[7] === 0x00 && m[2] === GT5_DEV),
  `write U1-1-1: ${sysex.length} DT1 messages to 07 00, paced over ${Math.round(performance.now() - t1)} ms`);

const back = await Midi.readPatch(conn, 0);
check(back.source === 0 && GT5.patchName(back.patch) === 'Web MIDI' && GT5.getValue(back.patch, 0x01, 0x1F) === 88,
  `read U1-1-1 back: "${GT5.patchName(back.patch)}", OD drive ${GT5.getValue(back.patch, 0x01, 0x1F)}`);

let refused = false;
try { await Midi.writePatch(conn, edited, 200); } catch { refused = true; }
check(refused, `writing a preset (${GT5.patchLabel(200)}) is refused`);

sent.length = 0;
await Midi.selectPatch(conn, 150);
check(GT5.hexBytes(sent[0]) === 'B0 00 01 B0 20 00 C0 32', `program change to ${GT5.patchLabel(150)}: ${GT5.hexBytes(sent[0])}`);

const sysBytes = GT5.concat(await Midi.readSystem(conn));
const sysRead = GT5.decodeSystem(sysBytes);
const tunerArea = GT5.systemArea('Tuner');
const sysSaved = GT5.concat(GT5.encodeSystem(sysRead, 0));
check(sysRead.length === GT5.decodeSystem(GT5.systemSyx()).length && GT5.hexBytes(sysSaved) === GT5.hexBytes(GT5.systemSyx()) && GT5.getSystemValue(sysRead, tunerArea, 0) === 5,
  `read system area in ${GT5.systemRequests(0).length} pieces: ${sysRead.length} chunks, saved = system.syx (${sysSaved.length} bytes), tuner ${GT5.label(tunerArea.params[0], GT5.getSystemValue(sysRead, tunerArea, 0))}`);

// A bulk dump started on the GT-5 after detection: detection found the unit
// before all 32 requests were out - that once left midi.js thinking a request
// was still waiting, and it dropped every dump after it.
const dumps = [];
Midi.onDump(bytes => dumps.push(bytes));
const tempDump = GT5.encodePatch(GT5.defaultPatch(), { to: 'temp', dev: GT5_DEV });
for (const m of tempDump) gt5In.deliver(m);
await new Promise(r => setTimeout(r, 3500));
check(dumps.length === 1 && GT5.splitSysex(dumps[0]).length === tempDump.length,
  `bulk dump after detection taken in (${dumps.length} dump, ${dumps[0] ? GT5.splitSysex(dumps[0]).length : 0} messages)`);

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` - ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
