'use strict';

// GT-5 SysEx protocol and patch model - the browser-side port of SysxIO.cpp /
// MidiTable.cpp. Parameter definitions come from gt5-params.js (generated from
// midi.xml by tools/gen_gt5_params.mjs).
//
// Message format (Roland DT1 / RQ1, 4-byte address, two-byte model ID):
//     F0 41 <dev> 00 04 12 <a1 a2 a3 a4> <data...> <checksum> F7     (DT1, data set)
//     F0 41 <dev> 00 04 11 <a1 a2 a3 a4> <s1 s2 s3 s4> <checksum> F7 (RQ1, data request)
// The checksum is the standard Roland one: it covers the address and the data
// (or size), so that (sum + checksum) % 128 === 0.
//
// A patch is one DT1 message per block: address <area> <area> <block> 00.
//     0A 00 bb 00   temporary patch, whole (bulk write; RQ1 of the temp patch)
//     0B 00 bb oo   temporary patch, one parameter (live edits; the FloorBoard's files)
//     07 nn bb 00   user patch nn (08 / 09 for the presets); see patchArea()
// Blocks 00-05 (6 messages, 426 bytes) are the GT-5's own: 00 effect on/off bits
// and chain, 01-02 the effects (02 continues 01 past its 128th byte), 03-04 EXP /
// CTL / Assign 1-8, 05 the name. Blocks 17-19 hold the editor's patch
// description / creator / scratch pad: the FloorBoard keeps them in its .syx
// files behind a non-Roland header (F0 00 ...), the GT-5 never sees them.
//
// Effect on/off is not a byte per effect: block 00 offsets 00-07 hold 4 bits
// each (stompBox.cpp); see ON_BITS.

const GT5 = (() => {
  const SOX = 0xF0;
  const EOX = 0xF7;
  const ROLAND_ID = 0x41;
  const MODEL_ID = [0x00, 0x04];
  const CMD_RQ1 = 0x11;
  const CMD_DT1 = 0x12;
  const HEADER_LENGTH = 6;   // F0 41 dev 00 04 cmd
  const ADDRESS_LENGTH = 4;
  // The FloorBoard writes the editor-only blocks with manufacturer ID 00 and
  // area 0B 00 (and, taken over from its GT-3 version, model 00 1B), so no
  // Roland unit ever takes them for its own data.
  const EDITOR_HEADER = [SOX, 0x00, 0x00, 0x00, 0x1B, CMD_DT1];
  const EDITOR_AREA = [0x0B, 0x00];

  const DEVICE_IDS = 32;     // Roland device ID 00-1F
  const FILE_DEVICE_ID = 0;  // files are written with device ID 00, like default.syx

  const TEMP_AREA = [0x0B, 0x00];       // temporary patch, individual: live edits, files
  const TEMP_BULK_AREA = [0x0A, 0x00];  // temporary patch, bulk: whole-patch send and read back
  const USER_AREA_MSB = 0x07;

  const BLOCKS = GT5_PARAMS.blocks;
  const BLOCK = new Map(BLOCKS.map(b => [b.id, b]));
  const DEVICE_BLOCKS = BLOCKS.filter(b => !b.editorOnly);  // 00-05
  const PATCH_PACKETS = DEVICE_BLOCKS.length;               // 6
  const messageLength = b => HEADER_LENGTH + ADDRESS_LENGTH + b.size + 2;
  const PATCH_SIZE = DEVICE_BLOCKS.reduce((n, b) => n + messageLength(b), 0);  // 426
  const FILE_PATCH_SIZE = BLOCKS.reduce((n, b) => n + messageLength(b), 0);     // 654

  const ONOFF_BLOCK = 0x00;
  const CHAIN_BLOCK = 0x00;
  const CHAIN_OFFSET = 0x08;
  const CHAIN_LENGTH = 15;
  const NAME_BLOCK = 0x05;
  const NAME_LENGTH = 11;
  // The FloorBoard's virtual on/off address (block 19 is the scratch pad in files).
  const VIRTUAL_BLOCK = 0x19;

  // Patch memory (globalVariables.h): 20 user banks + 30 preset banks, 5 patches each.
  // The GT-5 counts them in groups of 5 banks: U1-1-1 .. U4-5-5, P1-1-1 .. P6-5-5.
  const PATCHES_PER_BANK = 5;
  const BANKS_PER_GROUP = 5;
  const USER_BANKS = 20;
  const ALL_BANKS = 50;
  const USER_PATCHES = USER_BANKS * PATCHES_PER_BANK;   // 100
  const ALL_PATCHES = ALL_BANKS * PATCHES_PER_BANK;     // 250
  const PATCHES_PER_AREA = 100;                         // MidiTable::patchRequest: 07 / 08 / 09 xx
  const PROGRAMS_PER_BANK_SELECT = 100;                 // bankSize: CC#0 steps every 100 patches

  console.assert(PATCH_PACKETS === 6 && PATCH_SIZE === 426 && FILE_PATCH_SIZE === 654);

  class PatchError extends Error {}

  const hex = b => b.toString(16).toUpperCase().padStart(2, '0');
  const hexBytes = bytes => Array.from(bytes, hex).join(' ');

  const checksum = bytes => (128 - (Array.from(bytes).reduce((a, b) => a + b, 0) & 0x7F)) & 0x7F;

  function checkDevice(dev) {
    if (!(Number.isInteger(dev) && dev >= 0 && dev < DEVICE_IDS)) {
      throw new PatchError(`device ID must be 0-31, got ${dev}`);
    }
  }

  function dt1(dev, address, data) {
    checkDevice(dev);
    const body = [...address, ...data];
    return Uint8Array.from([SOX, ROLAND_ID, dev, ...MODEL_ID, CMD_DT1, ...body, checksum(body), EOX]);
  }

  // `size` is four 7-bit bytes, like the address (the FloorBoard sends end addresses there, e.g. 00 00 05 0C).
  function rq1(dev, address, sizeBytes) {
    checkDevice(dev);
    const body = [...address, ...sizeBytes];
    return Uint8Array.from([SOX, ROLAND_ID, dev, ...MODEL_ID, CMD_RQ1, ...body, checksum(body), EOX]);
  }

  // Split a byte stream into F0 ... F7 messages; bytes outside them are dropped.
  function splitSysex(bytes) {
    const messages = [];
    let start = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === SOX) start = i;
      else if (bytes[i] === EOX && start >= 0) {
        messages.push(Uint8Array.from(bytes.slice(start, i + 1)));
        start = -1;
      }
    }
    return messages;
  }

  const isGt5Header = m => m.length > HEADER_LENGTH && m[0] === SOX && m[1] === ROLAND_ID && m[2] < DEVICE_IDS
    && m[3] === MODEL_ID[0] && m[4] === MODEL_ID[1];
  const isEditorHeader = m => m.length > HEADER_LENGTH && EDITOR_HEADER.every((b, i) => m[i] === b);
  const isGt5Dt1 = m => isGt5Header(m) && m[5] === CMD_DT1;

  // {dev, address: [4], data, editor} of a DT1 message from or for a GT-5.
  function parseDt1(m, verifyChecksum = true) {
    const editor = isEditorHeader(m);
    if (!editor && !isGt5Dt1(m)) throw new PatchError(`not a GT-5 DT1 message: ${hexBytes(m.slice(0, 6))}`);
    if (m.length < HEADER_LENGTH + ADDRESS_LENGTH + 2 || m[m.length - 1] !== EOX) throw new PatchError('truncated DT1 message');
    const body = m.slice(HEADER_LENGTH, m.length - 2);
    if (verifyChecksum && checksum(body) !== m[m.length - 2]) {
      throw new PatchError(`checksum mismatch at ${hexBytes(body.slice(0, 4))}: expected ${hex(checksum(body))}, got ${hex(m[m.length - 2])}`);
    }
    return { dev: editor ? null : m[2], address: Array.from(body.slice(0, 4)), data: body.slice(4), editor };
  }

  // ------------------------------------------------------------ patch memory

  // Patch number 0-249: 0-99 = user U1-1-1 .. U4-5-5, 100-249 = preset P1-1-1 .. P6-5-5.
  function checkPatch(n) {
    if (!(Number.isInteger(n) && n >= 0 && n < ALL_PATCHES)) throw new PatchError(`patch number out of range 0-249: ${n}`);
  }

  const isUser = n => n < USER_PATCHES;

  // Group-bank-patch, as the GT-5's display shows it (floorBoardDisplay::setPatchNumDisplay).
  function patchLabel(n) {
    checkPatch(n);
    const user = isUser(n);
    const k = user ? n : n - USER_PATCHES;
    const bank = Math.floor(k / PATCHES_PER_BANK);
    const group = Math.floor(bank / BANKS_PER_GROUP) + 1;
    return `${user ? 'U' : 'P'}${group}-${(bank % BANKS_PER_GROUP) + 1}-${(k % PATCHES_PER_BANK) + 1}`;
  }

  // First two address bytes of patch n (MidiTable::patchRequest: 100 patches per area byte).
  function patchArea(n) {
    checkPatch(n);
    return [USER_AREA_MSB + Math.floor(n / PATCHES_PER_AREA), n % PATCHES_PER_AREA];
  }

  const isTempArea = (a1, a2) => (a1 === TEMP_AREA[0] || a1 === TEMP_BULK_AREA[0]) && a2 === 0x00;

  // Inverse of patchArea; null for the temporary patch areas.
  function patchFromArea(a1, a2) {
    if (isTempArea(a1, a2)) return null;
    const n = (a1 - USER_AREA_MSB) * PATCHES_PER_AREA + a2;
    if (a1 < USER_AREA_MSB || a2 >= PATCHES_PER_AREA || n >= ALL_PATCHES) {
      throw new PatchError(`not a patch address: ${hex(a1)} ${hex(a2)}`);
    }
    return n;
  }

  // Bank select + program change (SysxIO::getPatchChangeMsg): CC#0 = n / 100, CC#32 = 0, PC = n % 100.
  function programChange(n, channel = 0) {
    checkPatch(n);
    if (!(Number.isInteger(channel) && channel >= 0 && channel < 16)) throw new PatchError(`MIDI channel must be 0-15, got ${channel}`);
    return Uint8Array.from([
      0xB0 | channel, 0x00, Math.floor(n / PROGRAMS_PER_BANK_SELECT),
      0xB0 | channel, 0x20, 0x00,
      0xC0 | channel, n % PROGRAMS_PER_BANK_SELECT,
    ]);
  }

  // ------------------------------------------------------------ requests

  // The FloorBoard's identity request is a read of the first system byte (tuner
  // pitch); any GT-5 DT1 reply means a GT-5 is listening on that device ID.
  const identityRequest = dev => rq1(dev, [0x00, 0x00, 0x00, 0x00], [0x00, 0x00, 0x00, 0x01]);
  // The whole system area (globalVariables.h systemRequest: 00 00 00 00, size 02 00 00 05).
  // The FloorBoard sends it with checksum 7D, left over from its GT-3 version; the right one is 79.
  const systemRequest = dev => rq1(dev, [0x00, 0x00, 0x00, 0x00], [0x02, 0x00, 0x00, 0x05]);
  // All 6 blocks of a patch (patchRequestSize 00 00 05 0C: up to block 05, byte 0C).
  const PATCH_REQUEST_SIZE = [0x00, 0x00, 0x05, 0x0C];
  const patchRequest = (dev, n = null) => rq1(dev, [...(n === null ? TEMP_BULK_AREA : patchArea(n)), 0x00, 0x00], PATCH_REQUEST_SIZE);
  // A patch in small pieces. A real GT-5 hangs ("DATA SENDING..." until switched
  // off) on patchRequest, whose range runs over the gaps between the blocks, and
  // on a 128-byte request (size 00 00 01 00); it answers a 24-byte one. So every
  // request stays inside one block and asks for at most REQUEST_CHUNK bytes.
  const REQUEST_CHUNK = 0x40;
  const sizeBytes = size => [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F];
  const blockRequests = (dev, n = null) => DEVICE_BLOCKS.flatMap(b => {
    const out = [];
    for (let o = 0; o < b.size; o += REQUEST_CHUNK) {
      out.push(rq1(dev, [...(n === null ? TEMP_BULK_AREA : patchArea(n)), b.id, o], sizeBytes(Math.min(REQUEST_CHUNK, b.size - o))));
    }
    return out;
  });

  // Device ID of the first GT-5 DT1 message in `bytes`, or null.
  function replyDevice(bytes) {
    for (const m of splitSysex(bytes)) if (isGt5Dt1(m)) return m[2];
    return null;
  }

  // ------------------------------------------------------------ patch model

  // A patch is {blocks: {id: Uint8Array}} - the data bytes of every block, by block number.
  const emptyPatch = () => ({ blocks: Object.fromEntries(BLOCKS.map(b => [b.id, new Uint8Array(b.size)])) });
  const clonePatch = p => ({ blocks: Object.fromEntries(BLOCKS.map(b => [b.id, p.blocks[b.id].slice()])) });

  // Messages -> patch. Returns {patch, source, missing}: source is the patch number
  // the data came from (null = temporary patch / file without one), missing lists
  // the device blocks that were absent and taken from `fallback` (default: the init patch).
  // A block may come shorter than the GT-5's (old files hold an 11-byte name).
  function decodePatch(messages, { fallback = null, verifyChecksum = true } = {}) {
    const patch = clonePatch(fallback || defaultPatch());
    const seen = new Set();
    let source;
    for (const m of messages) {
      const { address, data, editor } = parseDt1(m, verifyChecksum);
      const [a1, a2, blockId, offset] = address;
      if (!BLOCK.get(blockId)) throw new PatchError(`unknown block ${hex(blockId)}`);
      // The data may run on past its block: Roland addresses are 7-bit, so byte 80
      // of block bb is byte 00 of block bb+1. A unit may send the patch in other
      // pieces than one message per block - every byte goes where its address says.
      for (let i = 0; i < data.length; i++) {
        const pos = offset + i;
        const id = blockId + Math.floor(pos / 128);
        const block = BLOCK.get(id);
        if (!block || pos % 128 >= block.size) continue;  // a gap in the address space
        patch.blocks[id][pos % 128] = data[i];
        seen.add(id);
      }
      if (!editor) {
        const n = patchFromArea(a1, a2);
        if (source === undefined) source = n;
        else if (source !== n) throw new PatchError('the messages belong to different patches');
      }
    }
    const missing = DEVICE_BLOCKS.filter(b => !seen.has(b.id)).map(b => b.id);
    return { patch, source: source === undefined ? null : source, missing };
  }

  // Patch -> DT1 messages. `to` = 'temp' (the patch the GT-5 is playing, bulk
  // area 0A 00), a patch number (store into that memory) or 'file' (0B 00,
  // device ID 00, like default.syx). `editor` adds the editor-only blocks (files only).
  function encodePatch(patch, { to = 'temp', dev = FILE_DEVICE_ID, editor = false } = {}) {
    const area = to === 'temp' ? TEMP_BULK_AREA : to === 'file' ? TEMP_AREA : patchArea(to);
    if (to === 'file') dev = FILE_DEVICE_ID;
    if (editor && to !== 'file') throw new PatchError('editor-only blocks belong in files, not on the GT-5');
    const messages = DEVICE_BLOCKS.map(b => dt1(dev, [...area, b.id, 0x00], patch.blocks[b.id]));
    if (editor) {
      for (const b of BLOCKS.filter(x => x.editorOnly)) {
        const body = [...EDITOR_AREA, b.id, 0x00, ...patch.blocks[b.id]];
        messages.push(Uint8Array.from([...EDITOR_HEADER, ...body, checksum(body), EOX]));
      }
    }
    return messages;
  }

  const concat = messages => {
    const out = new Uint8Array(messages.reduce((n, m) => n + m.length, 0));
    let i = 0;
    for (const m of messages) { out.set(m, i); i += m.length; }
    return out;
  };

  // A .syx file -> patches. One file may hold many patches back to back (a bulk
  // dump); a new patch starts whenever the block number stops increasing.
  // Checksums are not checked: many files in circulation carry 80 for 00 or are
  // one off, and the FloorBoard loads them all the same. Writing recomputes them.
  function decodeFile(bytes) {
    const groups = [];
    let last = Infinity;
    for (const m of splitSysex(bytes)) {
      if (!isGt5Dt1(m) && !isEditorHeader(m)) continue;
      if (isGt5Dt1(m) && m[6] < USER_AREA_MSB) continue;  // system data
      const block = m[HEADER_LENGTH + 2];
      if (block <= last) groups.push([]);
      groups[groups.length - 1].push(m);
      last = block;
    }
    if (!groups.length) throw new PatchError('no GT-5 patch data in this file');
    return groups.map(g => decodePatch(g, { verifyChecksum: false }));
  }

  function encodeFile(patches, { editor = false } = {}) {
    return concat([].concat(patches).flatMap(p => encodePatch(p, { to: 'file', editor })));
  }

  // ------------------------------------------------------------ parameters

  const PARAM_INDEX = new Map();
  for (const b of BLOCKS) for (const p of b.params) PARAM_INDEX.set(b.id * 256 + p.offset, { ...p, block: b.id });

  function param(block, offset) {
    const p = PARAM_INDEX.get(block * 256 + offset);
    if (!p) throw new PatchError(`no parameter at block ${hex(block)} offset ${hex(offset)}`);
    return p;
  }

  // Two-byte values are MSB first, 7 bits each (SysxIO::getSourceValue).
  function getValue(patch, block, offset) {
    const p = param(block, offset);
    const d = patch.blocks[block];
    return p.size === 2 ? d[offset] * 128 + d[offset + 1] : d[offset];
  }

  const valueBytes = (p, value) => (p.size === 2 ? [value >> 7, value & 0x7F] : [value]);

  function checkValue(p, value) {
    if (!Number.isInteger(value) || value < p.min || value > p.max) {
      throw new PatchError(`${p.name || `${hex(p.block)}/${hex(p.offset)}`}: value ${value} out of range ${p.min}-${p.max}`);
    }
  }

  // Store `value` in the patch; returns the DT1 message that makes the GT-5's
  // temporary patch follow (MidiTable::dataChange: address 0B 00 block offset).
  // The GT-5 plays it only after a Sound Change Request (soundChange).
  function setValue(patch, block, offset, value, dev = FILE_DEVICE_ID) {
    const p = param(block, offset);
    checkValue(p, value);
    const bytes = valueBytes(p, value);
    patch.blocks[block].set(bytes, offset);
    return dt1(dev, [...TEMP_AREA, block, offset], bytes);
  }

  // Sound Change Request: "you must send data to the SCR address after sending the
  // parameter data" (GT-5 MIDI Implementation; the FloorBoard never sends it).
  // Tried on a real GT-5 (2026-10-24): a parameter at 0B 00 followed by this plays
  // at once, whatever the GT-5's display shows; without it the GT-5 took a value
  // only for the parameter its display was on. The 0A 00 area takes nothing unless
  // the GT-5 is on its Bulk Load page. Value 00-7F, any.
  const SCR_ADDRESS = [...TEMP_BULK_AREA, 0x06, 0x00];
  const soundChange = (dev = FILE_DEVICE_ID) => dt1(dev, SCR_ADDRESS, [0x00]);

  // `messages` with a Sound Change Request after each one - the sure way (two
  // parameters with one request after them was not clearly heard).
  const withSoundChange = (messages, dev = FILE_DEVICE_ID) => messages.flatMap(m => [m, soundChange(dev)]);

  // Display text of a value, as MidiTable::rangeToValue builds it: a discrete
  // entry wins, else the first range that holds it maps it linearly.
  function label(p, value) {
    const table = GT5_PARAMS.tables[p.t];
    for (const e of table) if (Array.isArray(e) && e[0] === value) return e[1];
    for (const e of table) {
      if (Array.isArray(e) || value < e.lo || value > e.hi) continue;
      const base = e.base || 0;
      const start = e.lo - base;
      // Same arithmetic as the original (not min + (v - lo) * step), so labels match it exactly.
      const result = (value - base) * ((e.max - e.min) / (e.hi - e.lo)) + (e.min - start);
      return result.toFixed(e.dp) + (e.unit || '');
    }
    return String(value);
  }

  // Every valid value of a parameter with its label - for list boxes.
  function options(p) {
    const out = [];
    const table = GT5_PARAMS.tables[p.t];
    for (let v = p.min; v <= p.max; v++) {
      const known = table.some(e => (Array.isArray(e) ? e[0] === v : v >= e.lo && v <= e.hi));
      if (known) out.push([v, label(p, v)]);
    }
    return out;
  }

  // ------------------------------------------------------------ effect on/off bits

  // Where each switch lives: [offset in block 00, bit mask] (stompBox::updateButton).
  // Effect codes are the chain codes (FX1 0 ... NS 13); FV (14) has no switch.
  const ON_BITS = {
    0: [0x03, 0x01], 1: [0x03, 0x02], 2: [0x03, 0x04], 3: [0x03, 0x08],      // FX1 CS WAH LOOP
    4: [0x02, 0x01], 5: [0x02, 0x02], 6: [0x02, 0x04], 7: [0x02, 0x08],      // OD PRE SPKR EQ
    8: [0x01, 0x01], 9: [0x01, 0x02], 10: [0x01, 0x04], 11: [0x01, 0x08],    // FX2 DD CE TP
    12: [0x00, 0x01], 13: [0x00, 0x02],                                      // RV NS
    exp: [0x07, 0x01], ctl: [0x07, 0x02],
    a1: [0x05, 0x01], a2: [0x05, 0x02], a3: [0x05, 0x04], a4: [0x05, 0x08],
    a5: [0x04, 0x01], a6: [0x04, 0x02], a7: [0x04, 0x04], a8: [0x04, 0x08],
  };

  function onBit(key) {
    const bit = ON_BITS[key];
    if (!bit) throw new PatchError(`no on/off switch for ${key}`);
    return bit;
  }

  const isOn = (patch, key) => {
    const [offset, mask] = onBit(key);
    return (patch.blocks[ONOFF_BLOCK][offset] & mask) !== 0;
  };

  // Flip one switch; returns the DT1 message with its whole byte (the FloorBoard sends 0B 00 00 <offset> <byte>).
  function setOn(patch, key, on, dev = FILE_DEVICE_ID) {
    const [offset, mask] = onBit(key);
    const d = patch.blocks[ONOFF_BLOCK];
    d[offset] = on ? d[offset] | mask : d[offset] & ~mask & 0x7F;
    return dt1(dev, [...TEMP_AREA, ONOFF_BLOCK, offset], [d[offset]]);
  }

  // ------------------------------------------------------------ live switches
  //
  // Tried on a real GT-5 (2026-10-23/24): an effect switched on through its on/off
  // bit plays wrong (clean, even the preamp's drive gone) until the patch is
  // reloaded - with a Sound Change Request too. An assign with a MIDI CC source and
  // the effect's On/Off target switches it both ways, live, LED and all. The assigns
  // can't be changed in the temporary patch, so they are stored with the patch:
  // "live switches", a fixed layout, Assign 1-8 = CC#20-27. Once an assign drives
  // an effect, its on/off bit does nothing audible - only the CC does.
  // A switched-off effect drops the parameters sent to it; what it got while on
  // stays through off and on again.

  // Pedal (chain code) -> its On/Off assign target; for some it depends on the type.
  const ON_TARGETS = {
    0: [[0x01, 0x00], [0x00, 0x05]],       // FX1: Feedbacker, Slow Gear
    1: [[0x01, 0x09], [0x06, 0x08]],       // CS: Compressor, Limiter
    2: [[0x01, 0x12], [0x0A, 0x0D]],       // WAH: Wah, Auto Wah
    3: 0x12, 4: 0x14, 5: 0x1A, 6: 0x24, 7: 0x26,  // LOOP OD PRE SP EQ
    8: [[0x01, 0x39], [0x2C, 0x35, 0x3B, 0x42, 0x48, 0x4B, 0x52, 0x56, 0x5A, 0x5E]],  // FX2, by its type
    9: 0x64, 10: 0x6C, 12: 0x74, 13: 0x78,  // DD CE RV NS (TP has no On/Off target)
  };

  // The target code that switches pedal `code` on and off in this patch; null if there is none.
  function onTarget(patch, code) {
    const t = ON_TARGETS[code];
    if (t === undefined) return null;
    if (typeof t === 'number') return t;
    const [[block, offset], codes] = t;
    return codes[patch.blocks[block][offset]] ?? null;
  }

  // Assign i (0-7): 16 bytes from 03 0E; Assign 8 runs on into block 04.
  const ASSIGN = { target: 0, min: 2, max: 4, source: 6, mode: 7, lo: 8, hi: 9 };
  const ASSIGN_COUNT = 8;
  const assignAt = (i, field) => {
    const at = 0x0E + i * 0x10 + ASSIGN[field];
    return at < 0x80 ? [0x03, at] : [0x04, at - 0x80];
  };
  const getAssign = (patch, i, field) => {
    const [block, offset] = assignAt(i, field);
    const d = patch.blocks[block];
    return field === 'min' || field === 'max' ? d[offset] * 128 + d[offset + 1] : d[offset];
  };
  function putAssign(patch, i, field, bytes) {
    const [block, offset] = assignAt(i, field);
    patch.blocks[block].set(bytes, offset);
  }

  // Assign source values: CC#1-31 are 8-38, CC#64-95 39-70 (the source table).
  const ccSource = cc => (cc <= 31 ? 7 + cc : cc - 25);
  const sourceCc = s => (s >= 8 && s <= 38 ? s - 7 : s >= 39 && s <= 70 ? s + 25 : null);
  const ASSIGN_NORMAL = 0;

  // The layout: Assign i switches LIVE_SWITCHES[i].code with CC LIVE_SWITCHES[i].cc.
  const LIVE_SWITCHES = [[4, 20], [5, 21], [7, 22], [8, 23], [9, 24], [10, 25], [12, 26], [2, 27]]
    .map(([code, cc]) => ({ code, cc }));

  // The CC that switches pedal `code` live in this patch (any assign that is on,
  // has a CC source and the pedal's On/Off target with Min Off / Max On), or null.
  function liveSwitch(patch, code) {
    const target = onTarget(patch, code);
    if (target === null) return null;
    for (let i = 0; i < ASSIGN_COUNT; i++) {
      const cc = assignCc(patch, i);
      if (cc !== null && getAssign(patch, i, 'target') === target) return cc;
    }
    return null;
  }

  // The CC of assign i if it is on and works as an on/off switch, else null.
  function assignCc(patch, i) {
    const cc = sourceCc(getAssign(patch, i, 'source'));
    const ok = isOn(patch, `a${i + 1}`) && cc !== null
      && getAssign(patch, i, 'min') === 0 && getAssign(patch, i, 'max') === 1
      && getAssign(patch, i, 'mode') === ASSIGN_NORMAL
      && getAssign(patch, i, 'lo') === 0 && getAssign(patch, i, 'hi') === 127;
    return ok ? cc : null;
  }

  // The assigns that are on but are not the live switch layout: the patch's own
  // use of them, which setLiveSwitches would overwrite. Assign numbers 1-8. A
  // live switch whose target is out of date (FX2 / WAH type changed) is still ours.
  function ownAssigns(patch) {
    const own = [];
    LIVE_SWITCHES.forEach(({ cc }, i) => {
      if (isOn(patch, `a${i + 1}`) && assignCc(patch, i) !== cc) own.push(i + 1);
    });
    return own;
  }

  // Whether the patch holds the whole layout, with the targets of its current types.
  const hasLiveSwitches = patch => LIVE_SWITCHES.every(({ code, cc }, i) =>
    assignCc(patch, i) === cc && getAssign(patch, i, 'target') === onTarget(patch, code));

  // Put the live switch layout into Assign 1-8, with the targets of the patch's
  // current types (FX2 and WAH change with them). Only for writing the patch:
  // the temporary patch doesn't take assign changes.
  function setLiveSwitches(patch) {
    LIVE_SWITCHES.forEach(({ code, cc }, i) => {
      putAssign(patch, i, 'target', [onTarget(patch, code), 0]);
      putAssign(patch, i, 'min', [0, 0]);
      putAssign(patch, i, 'max', [0, 1]);
      putAssign(patch, i, 'source', [ccSource(cc), ASSIGN_NORMAL, 0, 127]);
      setOn(patch, `a${i + 1}`, true);
    });
  }

  // The CC messages that switch a live switch: the opposite value first, as the
  // assign acts only on a change (after a patch change the GT-5 takes the CC to be 0).
  const liveSwitchMessages = (cc, on, channel = 0) => [
    Uint8Array.from([0xB0 | channel, cc, on ? 0 : 127]),
    Uint8Array.from([0xB0 | channel, cc, on ? 127 : 0]),
  ];

  // ------------------------------------------------------------ name, chain, targets

  // 7E / 7F are arrows on the GT-5's display (SysxIO::returnPatchName).
  function patchName(patch) {
    return String.fromCharCode(...patch.blocks[NAME_BLOCK].slice(0, NAME_LENGTH))
      .replace(/\x7E/g, '→').replace(/\x7F/g, '←').replace(/\s+$/, '');
  }

  // Returns the DT1 messages for the temporary patch: one per letter. Tried on a
  // real GT-5 (2026-10-23): the temporary patch takes one parameter per message -
  // the name in one message changed only its first letter, letter by letter it all came.
  function setPatchName(patch, name, dev = FILE_DEVICE_ID) {
    const bytes = Array.from(name.slice(0, NAME_LENGTH).padEnd(NAME_LENGTH, ' '), c => {
      if (c === '→') return 0x7E;
      if (c === '←') return 0x7F;
      const code = c.charCodeAt(0);
      return code >= 0x20 && code <= 0x7D ? code : 0x3F; // '?' for anything the GT-5 can't show
    });
    patch.blocks[NAME_BLOCK].set(bytes, 0);
    return bytes.map((b, k) => dt1(dev, [...TEMP_AREA, NAME_BLOCK, k], [b]));
  }

  // Effect order: 15 slots, each holding an effect code (FX1, CS, WAH, ... FV).
  const chain = patch => Array.from(patch.blocks[CHAIN_BLOCK].slice(CHAIN_OFFSET, CHAIN_OFFSET + CHAIN_LENGTH));
  const isValidChain = order => order.length === CHAIN_LENGTH && new Set(order).size === CHAIN_LENGTH
    && order.every(c => Number.isInteger(c) && c >= 0 && c < CHAIN_LENGTH);

  // A new effect order (every code exactly once); returns the DT1 messages that
  // send it to the temporary patch, one per chain slot (see setPatchName).
  function setChain(patch, order, dev = FILE_DEVICE_ID) {
    if (!isValidChain(order)) throw new PatchError(`not an effect order: ${order.join(' ')}`);
    patch.blocks[CHAIN_BLOCK].set(order, CHAIN_OFFSET);
    return order.map((c, k) => dt1(dev, [...TEMP_AREA, CHAIN_BLOCK, CHAIN_OFFSET + k], [c]));
  }

  // What it takes to turn the GT-5's temporary patch from `before` into `after`,
  // as the GT-5 takes it (tried on a real unit, 2026-10-23): one parameter per
  // message - a message with a whole block keeps only its start, and a long run
  // of changes (a whole patch, ~350 messages) overflows its MIDI buffer.
  // The EXP / CTL / assign settings (blocks 03-04, and their on/off bits) don't
  // change in the temporary patch at all; they are counted in `skipped`.
  // Returns {messages, skipped}.
  // onOff: false leaves the effect on/off bytes out (the caller switches them itself).
  function liveChanges(before, after, dev = FILE_DEVICE_ID, { onOff = true } = {}) {
    const messages = [];
    let skipped = 0;
    const was = before.blocks;
    const now = after.blocks;
    const send = (block, offset, bytes) => messages.push(dt1(dev, [...TEMP_AREA, block, offset], bytes));
    if (onOff) for (let k = 0; k < 4; k++) if (was[ONOFF_BLOCK][k] !== now[ONOFF_BLOCK][k]) send(ONOFF_BLOCK, k, [now[ONOFF_BLOCK][k]]);
    for (let k = 4; k < 8; k++) if (was[ONOFF_BLOCK][k] !== now[ONOFF_BLOCK][k]) skipped++;
    for (let k = CHAIN_OFFSET; k < CHAIN_OFFSET + CHAIN_LENGTH; k++) {
      if (was[CHAIN_BLOCK][k] !== now[CHAIN_BLOCK][k]) send(CHAIN_BLOCK, k, [now[CHAIN_BLOCK][k]]);
    }
    for (const id of [0x01, 0x02]) {
      for (const p of BLOCK.get(id).params) {
        const bytes = Array.from(now[id].slice(p.offset, p.offset + p.size));
        if (bytes.some((b, k) => b !== was[id][p.offset + k])) send(id, p.offset, bytes);
      }
    }
    for (const id of [0x03, 0x04]) {
      for (let k = 0; k < now[id].length; k++) if (was[id][k] !== now[id][k]) skipped++;
    }
    for (let k = 0; k < NAME_LENGTH; k++) if (was[NAME_BLOCK][k] !== now[NAME_BLOCK][k]) send(NAME_BLOCK, k, [now[NAME_BLOCK][k]]);
    return { messages, skipped };
  }

  const samePatch = (a, b) => BLOCKS.every(({ id }) => a.blocks[id].length === b.blocks[id].length
    && a.blocks[id].every((x, k) => x === b.blocks[id][k]));

  const TARGETS = GT5_PARAMS.targets.list.map(([code, block, offset, name]) => ({ code, block, offset, name }));
  const TARGET_BY_CODE = new Map(TARGETS.map(t => [t.code, t]));

  // What an Assign / EXP / CTL target code drives: {code, block, offset, name, param}.
  // On/off targets point at the virtual block 19 (Off/On, Stop/Start); their
  // param is that two-value table. The Min / Max values of an assign are shown
  // in the target parameter's own units.
  function target(code) {
    const t = TARGET_BY_CODE.get(code);
    if (!t) return null;
    return { ...t, param: PARAM_INDEX.get(t.block * 256 + t.offset) || null, virtual: t.block === VIRTUAL_BLOCK };
  }

  // ------------------------------------------------------------ system settings

  // The system area (tuner, global, system, MIDI, harmony scales, custom OD /
  // preamp, manual) as it came in: one {address: [4], data} chunk per DT1
  // message, keyed by address, so a dump read from the GT-5 or a file goes back
  // out byte for byte - parts midi.xml doesn't describe (the program change map)
  // included. Every system parameter is one byte.
  const SYSTEM_AREAS = GT5_PARAMS.system.filter(s => s.params.length);
  const SYSTEM_LAST_MSB = 0x02;  // system data lives below the patch areas (07 and up)
  const SYSTEM_SIZE = 1367;      // SysxIO::systemReply

  function decodeSystem(bytes) {
    const chunks = new Map();
    for (const m of splitSysex(bytes)) {
      if (!isGt5Dt1(m)) continue;
      const { address, data } = parseDt1(m);
      if (address[0] > SYSTEM_LAST_MSB) continue;
      chunks.set(address.join(' '), { address, data: Uint8Array.from(data) });
    }
    if (!chunks.size) throw new PatchError('no GT-5 system data');
    // Pieces read one after the other (systemRequests) join up again, so the dump
    // saves as the same messages as the GT-5's own.
    const out = [];
    for (const c of chunks.values()) {
      const prev = out[out.length - 1];
      if (prev && prev.address.slice(0, 3).join() === c.address.slice(0, 3).join()
        && prev.address[3] + prev.data.length === c.address[3] && prev.data.length + c.data.length <= 128) {
        const joined = new Uint8Array(prev.data.length + c.data.length);
        joined.set(prev.data);
        joined.set(c.data, prev.data.length);
        prev.data = joined;
      } else out.push(c);
    }
    return out;
  }

  const cloneSystem = system => system.map(c => ({ address: c.address.slice(), data: c.data.slice() }));

  // By sub-area name ("Midi") or full address.
  const systemArea = (name, msb = 0) => SYSTEM_AREAS.find(a => a.name === name && a.address[2] === msb);

  function systemParam(area, offset) {
    const p = area.params.find(q => q.offset === offset);
    if (!p) throw new PatchError(`no system parameter ${area.name}/${offset}`);
    return p;
  }

  const sameArea = (c, area) => c.address[0] === area.address[0] && c.address[1] === area.address[1] && c.address[2] === area.address[2];
  const findChunk = (system, area, offset) => system.find(c => sameArea(c, area) && offset >= c.address[3] && offset < c.address[3] + c.data.length);

  // null when the dump doesn't hold that byte.
  function getSystemValue(system, area, offset) {
    const c = findChunk(system, area, offset);
    return c ? c.data[offset - c.address[3]] : null;
  }

  // Store a value and return the DT1 message that sets it on the GT-5 (which stores system settings at once).
  function setSystemValue(system, area, offset, value, dev = FILE_DEVICE_ID) {
    const p = systemParam(area, offset);
    checkValue(p, value);
    let c = findChunk(system, area, offset);
    if (!c) {
      c = { address: [...area.address, offset], data: new Uint8Array(1) };
      system.push(c);
    }
    c.data[offset - c.address[3]] = value;
    return dt1(dev, [...area.address, offset], [value]);
  }

  const encodeSystem = (system, dev = FILE_DEVICE_ID) => system.map(c => dt1(dev, c.address, c.data));

  // The system area in small requests, like the patches (blockRequests): the
  // address and length of every chunk in system.syx, at most REQUEST_CHUNK bytes each.
  function systemRequests(dev) {
    return decodeSystem(base64Bytes(SYSTEM_SYX_BASE64)).flatMap(c => {
      const out = [];
      for (let o = 0; o < c.data.length; o += REQUEST_CHUNK) {
        out.push(rq1(dev, [...c.address.slice(0, 3), c.address[3] + o], sizeBytes(Math.min(REQUEST_CHUNK, c.data.length - o))));
      }
      return out;
    });
  }

  // ------------------------------------------------------------ factory data

  function base64Bytes(b64) {
    const bin = atob(b64);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  let defaultCache = null;
  function defaultPatch() {
    if (!defaultCache) {
      const messages = splitSysex(base64Bytes(DEFAULT_PATCH_SYX_BASE64));
      defaultCache = decodePatch(messages, { fallback: emptyPatch() }).patch;
    }
    return clonePatch(defaultCache);
  }

  return {
    PatchError, DEVICE_IDS, BLOCKS, BLOCK, PATCH_PACKETS, PATCH_SIZE, FILE_PATCH_SIZE, NAME_LENGTH, CHAIN_LENGTH,
    USER_PATCHES, ALL_PATCHES, PATCHES_PER_BANK, BANKS_PER_GROUP, TARGETS, ON_BITS, SYSTEM_SIZE,
    hex, hexBytes, checksum, dt1, rq1, splitSysex, parseDt1, concat, isGt5Dt1,
    patchLabel, patchArea, patchFromArea, programChange, isUser,
    identityRequest, systemRequest, patchRequest, blockRequests, replyDevice,
    emptyPatch, clonePatch, defaultPatch, decodePatch, encodePatch, decodeFile, encodeFile,
    param, getValue, setValue, soundChange, withSoundChange, label, options, isOn, setOn,
    LIVE_SWITCHES, onTarget, liveSwitch, ownAssigns, hasLiveSwitches, setLiveSwitches, liveSwitchMessages,
    patchName, setPatchName, chain, isValidChain, setChain, samePatch, liveChanges, target,
    systemSyx: () => base64Bytes(SYSTEM_SYX_BASE64),
    SYSTEM_AREAS, decodeSystem, cloneSystem, systemRequests, systemArea, systemParam, getSystemValue, setSystemValue, encodeSystem,
  };
})();
