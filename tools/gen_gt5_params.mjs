// Generate the Web MIDI editor's data files from the Qt FloorBoard's sources.
//
//     node tools/gen_gt5_params.mjs
//
// Reads   midi.xml, default.syx, system.syx  (in gt-5fxfloorboard_source_code_20250419/)
// Writes  webmidi/gt5-params.js  - every patch and system parameter with its value table
//         webmidi/factory.js     - default.syx / system.syx embedded as base64
//
// midi.xml layout, as MidiTable.cpp reads it:
//
//     <Structure> / <LSB block> / <LSB 00> / <DATA offset> / <PARAM ...>
//     <System>    / <LSB area>  / <LSB sub> / <Msb 00>     / <Msb offset> / <PARAM ...>
//
// A <DATA> whose children are <DATA> elements is a two-byte value: byte 1 is the
// MSB, byte 2 the LSB (7 bits each), and the child <DATA value=msb> holds the
// <PARAM>s for the LSB. The empty <DATA> after it is that LSB byte.
// A <PARAM value="range" name="lo/hi/min/max" desc="unit"> maps lo..hi (hex)
// linearly onto min..max for display; any other <PARAM> is one discrete value.
//
// GT-5 specifics (compared with the GT-3 generator this one is ported from):
// - The patch blocks are 00-05 (the GT-5's own) and 17-19 (editor-only notes),
//   not numbered without gaps. Block sizes come from default.syx: the name block
//   holds 12 bytes, of which midi.xml describes 11.
// - The assign Target is one byte (MidiTable reads it as a plain list); its
//   <PARAM>s carry the target block in `desc` and the offset in `customdesc`.
//   Block "19" there is the FloorBoard's virtual on/off switch address.
// - No Python: the editor is browser-only, so is its tooling.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(BASE, 'gt-5fxfloorboard_source_code_20250419');  // the Qt FloorBoard source
const OUT_DIR = path.join(BASE, 'webmidi');

// Blocks 17-19 are the editor's own notes (patch description, creator, scratch pad).
// The GT-5 has no such memory; they live only in .syx files, behind a non-Roland header.
const EDITOR_ONLY_FIRST_BLOCK = 0x17;

// Typos in midi.xml, fixed here so the XML stays as the FloorBoard ships it.
// "where|value|name" -> corrected value
const VALUE_FIXES = new Map([
  // SYN:Octave Shift lists "00=0, 01=-1, 01=-2"; real patches hold 02 there.
  ['block 01 offset 7E|01|-2', '02'],
]);

function fail(msg) {
  console.error(`gen_gt5_params: ${msg}`);
  process.exit(1);
}
const warn = msg => console.error(`warning: ${msg}`);
const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');

// ---------------------------------------------------------------- a minimal XML reader

// Enough for midi.xml: elements, attributes, comments, the declaration. No text nodes needed.
function parseXml(src) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const unescape = s => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    return String.fromCharCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {
      const top = stack.pop();
      if (top.tag !== m[1]) fail(`XML: </${m[1]}> closes <${top.tag}>`);
    } else if (m[2]) {
      const el = { tag: m[2], attrs: {}, children: [] };
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[3]))) el.attrs[a[1]] = unescape(a[2] ?? a[3]);
      stack[stack.length - 1].children.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  if (stack.length !== 1) fail('XML: unclosed elements');
  return root.children[0];
}

const text = (e, attr) => (e.attrs[attr] || '').trim();
const child = (e, tag) => e.children.find(c => c.tag === tag);

function number(s, where) {
  const n = Number(s);
  if (s.trim() === '' || Number.isNaN(n)) fail(`${where}: range bound ${JSON.stringify(s)} is not a number`);
  return n;
}

// MidiTable::rangeToValue: precision = digits after the '.' of the max bound.
const decimals = s => (s.includes('.') ? s.split('.').pop().length : 0);

// Value tables, deduplicated: most parameters share "Off/On" or "0-100 %".
class Tables {
  constructor() { this.tables = []; this.index = new Map(); }
  add(entries) {
    const key = JSON.stringify(entries);
    if (!this.index.has(key)) {
      this.index.set(key, this.tables.length);
      this.tables.push(entries);
    }
    return this.index.get(key);
  }
}

// <PARAM> list -> table entries; values are offset by `base` (MSB * 128).
function entriesOf(params, where, base = 0) {
  const entries = [];
  const seen = new Set();
  for (const p of params) {
    if (p.tag !== 'PARAM') fail(`${where}: expected PARAM, got ${p.tag}`);
    const name = p.attrs.name || '';
    const value = VALUE_FIXES.get(`${where}|${p.attrs.value}|${name.trim()}`) ?? p.attrs.value;
    if (value === 'range') {
      const parts = name.split('/');
      if (parts.length !== 4) fail(`${where}: bad range ${JSON.stringify(name)}`);
      const lo = parseInt(parts[0], 16);
      const hi = parseInt(parts[1], 16);
      if (hi <= lo) fail(`${where}: empty range ${JSON.stringify(name)}`);
      entries.push({
        lo: base + lo, hi: base + hi,
        min: number(parts[2], where), max: number(parts[3], where),
        dp: decimals(parts[3]), unit: p.attrs.desc || '', base,
      });
    } else {
      const v = base + parseInt(value, 16);
      if (Number.isNaN(v)) fail(`${where}: bad value ${JSON.stringify(value)}`);
      // Lookups take the first match (QList::indexOf), so a duplicate value is dead.
      if (seen.has(v)) {
        warn(`${where}: duplicate value ${value} (${JSON.stringify(name.trim())}) ignored`);
        continue;
      }
      seen.add(v);
      // The MIDI settings keep their value texts in desc (name="" desc="CC#01 ...").
      entries.push([v, name.trim() || (p.attrs.desc || '').trim()]);
    }
  }
  return entries;
}

function compact(entry) {
  if (Array.isArray(entry)) return entry;
  const e = {};
  for (const [k, v] of Object.entries(entry)) {
    if ((k === 'base' && v === 0) || (k === 'unit' && v === '')) continue;
    e[k] = v;
  }
  return e;
}

function entryBounds(entries) {
  const vals = entries.flatMap(e => (Array.isArray(e) ? [e[0]] : [e.lo, e.hi]));
  return [Math.min(...vals), Math.max(...vals)];
}

// One <DATA> / <Msb> -> parameter (without the offset), or null for an empty byte.
function paramOf(data, where, tables, { system = false } = {}) {
  const kids = data.children;
  const p = system
    ? { name: text(data, 'customdesc') || text(data, 'desc') || text(data, 'name'), short: text(data, 'customdesc') }
    : { name: text(data, 'desc') || text(data, 'name'), short: text(data, 'customdesc') };
  if (p.name === 'MIDI SETTING') p.name = p.short;  // the MIDI settings' own names are in customdesc
  if (!kids.length) return null;
  let entries;
  if (kids.every(k => k.tag === 'DATA')) {
    entries = [];
    for (const k of kids) {
      const msb = parseInt(k.attrs.value, 16);
      entries.push(...entriesOf(k.children, `${where} msb ${hex2(msb)}`, msb * 128));
    }
    p.size = 2;
  } else {
    entries = entriesOf(kids, where);
    p.size = 1;
  }
  [p.min, p.max] = entryBounds(entries);
  p.t = tables.add(entries.map(compact));
  return p;
}

function paramsOf(container, where, tables, { editorOnly = false, system = false } = {}) {
  const params = [];
  const covered = new Set();
  for (const data of container) {
    if (data.tag !== 'DATA' && data.tag !== 'Msb') fail(`${where}: unexpected <${data.tag}>`);
    const value = data.attrs.value;
    if (value === 'range') {
      // One table over offsets lo..hi; name like "00/0B/Chain1/Chain12".
      const parts = text(data, 'name').split('/');
      const lo = parseInt(parts[0], 16);
      const hi = parseInt(parts[1], 16);
      const label = parts[2].replace(/\d+$/, '');
      const t = tables.add(entriesOf(data.children, where).map(compact));
      const [vmin, vmax] = entryBounds(tables.tables[t]);
      for (let off = lo; off <= hi; off++) {
        params.push({ offset: off, name: `${label}${off - lo + 1}`, short: `${label}${off - lo + 1}`, size: 1, min: vmin, max: vmax, t });
        covered.add(off);
      }
      continue;
    }
    const offset = parseInt(value, 16);
    const p = paramOf(data, `${where} offset ${hex2(offset)}`, tables, { system });
    if (p === null) {
      // The LSB of the two-byte value before it, or an unused byte.
      if (!covered.has(offset) && !editorOnly) {
        const prev = params.find(q => q.offset === offset - 1);
        // The byte after a one-byte Target is its unused "Target LSB".
        if ((!prev || prev.size !== 2) && !/^Target/.test(prev?.short || '')) warn(`${where}: empty byte ${hex2(offset)} is not the LSB of a two-byte value`);
      }
      continue;
    }
    params.push({ offset, ...p });
    for (let i = 0; i < p.size; i++) covered.add(offset + i);
  }
  return { params, size: covered.size ? Math.max(...covered) + 1 : 0 };
}

// ---------------------------------------------------------------- .syx files

function syxMessages(file) {
  const data = fs.readFileSync(path.join(ROOT, file));
  const msgs = [];
  let start = 0;
  while (start < data.length) {
    const end = data.indexOf(0xF7, start);
    if (end < 0) fail(`${file}: unterminated SysEx message`);
    msgs.push(data.subarray(start, end + 1));
    start = end + 1;
  }
  return { data, msgs };
}

// ---------------------------------------------------------------- patch structure

function structure(xmlRoot, tables) {
  // Message data lengths in default.syx are the block sizes the GT-5 really uses.
  const { msgs } = syxMessages('default.syx');
  const sizeOf = new Map(msgs.map(m => [m[8], m.length - 12]));
  const blocks = [];
  for (const blk of child(xmlRoot, 'Structure').children) {
    const id = parseInt(blk.attrs.value, 16);
    const subs = blk.children;
    if (subs.length !== 1 || subs[0].attrs.value !== '00') fail(`block ${hex2(id)}: expected exactly one <LSB value="00">`);
    const editorOnly = id >= EDITOR_ONLY_FIRST_BLOCK;
    const { params, size: xmlSize } = paramsOf(subs[0].children, `block ${hex2(id)}`, tables, { editorOnly });
    const size = sizeOf.get(id);
    if (size === undefined) fail(`block ${hex2(id)} is not in default.syx`);
    if (Math.max(xmlSize, subs[0].children.length) > size) fail(`block ${hex2(id)}: midi.xml describes more bytes than default.syx holds (${size})`);
    blocks.push({
      id, abbr: text(blk, 'abbr') || text(blk, 'name'), name: text(blk, 'name'),
      size, ...(editorOnly ? { editorOnly: true } : {}), params,
    });
  }
  if (blocks.length !== msgs.length) fail(`default.syx has ${msgs.length} messages, midi.xml ${blocks.length} blocks`);
  return blocks;
}

function system(xmlRoot, tables) {
  const areas = [];
  for (const area of child(xmlRoot, 'System').children) {
    for (const sub of area.children) {
      for (const msb of sub.children) {
        const address = [parseInt(area.attrs.value, 16), parseInt(sub.attrs.value, 16), parseInt(msb.attrs.value, 16)];
        const where = `system ${address.map(hex2).join(' ')}`;
        const { params, size } = paramsOf(msb.children, where, tables, { system: true });
        areas.push({ address, name: text(sub, 'name'), size, params });
      }
    }
  }
  return areas;
}

// Assign / EXP / CTL target codes -> the parameter they drive. Every Target
// parameter must share one list, so it is stored once.
function targets(xmlRoot, blocks) {
  const lists = new Map();
  for (const blk of child(xmlRoot, 'Structure').children) {
    for (const data of blk.children[0].children) {
      if (!/^Target$/.test(text(data, 'customdesc'))) continue;
      const out = data.children.map(p => [parseInt(p.attrs.value, 16), parseInt(p.attrs.desc, 16),
        parseInt(p.attrs.customdesc, 16), (p.attrs.name || '').trim()]);
      lists.set(`${hex2(parseInt(blk.attrs.value, 16))}/${hex2(parseInt(data.attrs.value, 16))}`, out);
    }
  }
  if (!lists.size) fail('no Target parameters found');
  const first = [...lists.values()][0];
  for (const [where, list] of lists) {
    if (JSON.stringify(list) !== JSON.stringify(first)) fail(`target list of ${where} differs from the first one`);
  }
  const byBlock = new Map(blocks.map(b => [b.id, new Set(b.params.map(p => p.offset))]));
  for (const [code, block, offset, name] of first) {
    if (block === 0x19) continue;  // virtual on/off switch, resolved by gt5.js
    if (!byBlock.get(block)?.has(offset)) warn(`target ${code} (${JSON.stringify(name)}) points at ${hex2(block)}/${hex2(offset)}, which has no parameter`);
  }
  return { params: [...lists.keys()].sort(), list: first };
}

// ---------------------------------------------------------------- output

const js = v => JSON.stringify(v);
const headOf = item => js(Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'params'))).slice(0, -1);

function writeParams(blocks, sysAreas, tgt, tables) {
  const lines = [
    "'use strict';",
    '',
    '// GENERATED by tools/gen_gt5_params.mjs from midi.xml - do not edit by hand.',
    '//',
    '// blocks[].params[]: {offset, name, short, size (1|2 bytes), min, max, t} - blocks[].id is the block number',
    '// system[]:          {address: [a, b, c], name, size, params[]} - DT1 address is [...address, offset]',
    '// tables[t]:         value table - [value, label] or {lo, hi, min, max, dp, unit, base}',
    '// targets.list[]:    [code, block, offset, name] - what an Assign / EXP / CTL target drives',
    '',
    'const GT5_PARAMS = {',
    '  blocks: [',
  ];
  for (const b of blocks) {
    lines.push(`    ${headOf(b)}, "params": [`);
    for (const p of b.params) lines.push(`      ${js(p)},`);
    lines.push('    ] },');
  }
  lines.push('  ],', '  system: [');
  for (const a of sysAreas) {
    lines.push(`    ${headOf(a)}, "params": [`);
    for (const p of a.params) lines.push(`      ${js(p)},`);
    lines.push('    ] },');
  }
  lines.push('  ],', `  targets: { params: ${js(tgt.params)}, list: [`);
  for (const t of tgt.list) lines.push(`    ${js(t)},`);
  lines.push('  ] },', '  tables: [');
  for (const t of tables.tables) lines.push(`    ${js(t)},`);
  lines.push('  ],', '};', '');
  fs.writeFileSync(path.join(OUT_DIR, 'gt5-params.js'), lines.join('\n'));
}

function writeFactory() {
  const b64Lines = file => {
    const b64 = fs.readFileSync(path.join(ROOT, file)).toString('base64');
    const out = [];
    for (let i = 0; i < b64.length; i += 100) out.push(`  '${b64.slice(i, i + 100)}'`);
    return `${out.join(' +\n')};`;
  };
  const out = [
    "'use strict';",
    '',
    '// GENERATED by tools/gen_gt5_params.mjs - embedded so the editor also works opened',
    '// straight from disk, where fetch() of local files is blocked.',
    '',
    '// default.syx: the init patch (6 GT-5 blocks + 3 editor-only blocks, 654 bytes).',
    'const DEFAULT_PATCH_SYX_BASE64 =',
    b64Lines('default.syx'),
    '',
    '// system.syx: a full GT-5 system-area dump (1367 bytes).',
    'const SYSTEM_SYX_BASE64 =',
    b64Lines('system.syx'),
    '',
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'factory.js'), out.join('\n'));
}

const xmlRoot = parseXml(fs.readFileSync(path.join(ROOT, 'midi.xml'), 'latin1'));
const tables = new Tables();
const blocks = structure(xmlRoot, tables);
const sysAreas = system(xmlRoot, tables);
const tgt = targets(xmlRoot, blocks);
fs.mkdirSync(OUT_DIR, { recursive: true });
writeParams(blocks, sysAreas, tgt, tables);
writeFactory();
const n = blocks.reduce((s, b) => s + b.params.length, 0);
console.log(`${blocks.length} blocks, ${n} patch parameters, ${sysAreas.reduce((s, a) => s + a.params.length, 0)} system `
  + `parameters, ${tgt.list.length} targets, ${tables.tables.length} value tables`);
