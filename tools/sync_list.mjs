// The messages that would bring the GT-5's temporary patch fully in line with a
// patch, one parameter each, types first - for tools/temp_experiment.py --method sync.
//
//     node tools/sync_list.mjs <dump.syx> <a1 hex> <a2 hex> [name] > list.txt
//
// Output: one line per message, "T <hex>" for a type switch (needs a longer pause), "P <hex>" otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'webmidi');
const ctx = vm.createContext({ console, atob });
for (const f of ['gt5-params.js', 'factory.js', 'gt5.js']) vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx);
const GT5 = vm.runInContext('GT5', ctx);

const [file, a1, a2, name] = process.argv.slice(2);
const want = [parseInt(a1, 16), parseInt(a2, 16)];
const group = GT5.splitSysex(fs.readFileSync(file)).filter(m => GT5.isGt5Dt1(m) && m[6] === want[0] && m[7] === want[1]);
const patch = GT5.decodePatch(group, { verifyChecksum: false }).patch;
if (name) GT5.setPatchName(patch, name);

// Every parameter different: liveChanges from a patch whose every byte is off by one.
const other = GT5.clonePatch(patch);
for (const b of GT5.BLOCKS) other.blocks[b.id] = other.blocks[b.id].map(x => (x + 1) & 0x7F);
const { messages } = GT5.liveChanges(other, patch, 0);

const TYPES = new Set(['01 00', '01 09', '01 12', '01 1E', '01 23', '01 2C', '01 39', '02 0C', '02 0D', '02 19', '02 1F', '02 24']);
const key = m => GT5.hexBytes(m.slice(8, 10));
const types = messages.filter(m => TYPES.has(key(m)));
const rest = messages.filter(m => !TYPES.has(key(m)));
for (const m of types) console.log(`T ${GT5.hexBytes(m)}`);
for (const m of rest) console.log(`P ${GT5.hexBytes(m)}`);
console.error(`${types.length} type switches + ${rest.length} parameters`);
