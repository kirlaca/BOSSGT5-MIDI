'use strict';

// What the GT-5 editor shows for each effect block: the pedal skin, which
// parameter picks its type, and which parameters belong to each type. The
// groups follow the edit pages of the Qt FloorBoard (stompbox_*.cpp).
//
// `code` is the effect's code in the FX chain (block 00, offsets 08-16), so the
// pedals can be laid out in the patch's own order; it is also the key of its
// on/off bit (GT5.ON_BITS). Most effects live in block 01; DD, CE, TP, RV, NS,
// FV and the Master live in block 02, which continues block 01 on the GT-5
// (the Guitar Synth of FX2 spills over into it). A parameter is an offset in
// the pedal's own block, or BLOCK2 + offset.

const EFFECTS = (() => {
  const FX = 0x01;
  const FX_B = 0x02;
  const BLOCK2 = 0x200;  // marks an offset in block 02 inside a block 01 pedal
  const B = o => BLOCK2 + o;

  // Pedal colours: approximations of the matching BOSS compacts - tweak freely.
  const PEDALS = [
    {
      code: 0, block: FX, abbr: 'FX1', title: 'Feedbacker / Slow Gear', body: '#6d57a6', ink: '#ffffff',
      type: 0x00, typeUi: 'seg',
      types: {
        0: { groups: [['Feedbacker', [0x01, 0x02, 0x03, 0x04]], ['Vibrato', [0x05, 0x06]]], main: [0x01, 0x03, 0x05, 0x06] },
        1: { groups: [['Slow Gear', [0x07, 0x08]]] },
      },
      labels: { 1: 'Rise', 2: 'Rise ↑', 3: 'Level', 4: 'Level ↑', 5: 'V.Rate', 6: 'V.Depth', 7: 'Sens', 8: 'Rise' },
    },
    {
      code: 1, block: FX, abbr: 'CS', title: 'Compressor / Limiter', body: '#2f6cc8', ink: '#ffffff',
      type: 0x09, typeUi: 'seg',
      types: {
        0: { groups: [['Compressor', [0x0A, 0x0B, 0x0C, 0x0D]]] },
        1: { groups: [['Limiter', [0x0E, 0x0F, 0x10, 0x11]]] },
      },
      labels: { 0x0A: 'Sustain', 0x0B: 'Attack', 0x0C: 'Tone', 0x0D: 'Level', 0x0E: 'Thresh', 0x0F: 'Release', 0x10: 'Tone', 0x11: 'Level' },
    },
    {
      code: 2, block: FX, abbr: 'WAH', title: 'Wah / Auto Wah', body: '#2a2b30', ink: '#e8e8ea',
      type: 0x12, typeUi: 'seg',
      types: {
        0: { groups: [['Pedal Wah', [0x13, 0x14]]] },
        1: { groups: [['Auto Wah', [0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C]]], main: [0x17, 0x18, 0x19, 0x1C] },
      },
      labels: {
        0x13: 'Pedal', 0x14: 'Level', 0x15: 'Mode', 0x16: 'Polarity', 0x17: 'Sens', 0x18: 'Freq', 0x19: 'Peak',
        0x1A: 'Rate', 0x1B: 'Depth', 0x1C: 'Level',
      },
    },
    {
      code: 3, block: FX, abbr: 'LOOP', title: 'Send / Return Loop', body: '#8a8f99', ink: '#151515',
      types: { null: { groups: [['External loop', [0x1D]]] } },
      labels: { 0x1D: 'Send' },
      notes: { all: 'The rear SEND / RETURN jacks: an external effect at this place in the chain.' },
    },
    {
      code: 4, block: FX, abbr: 'OD/DS', title: 'Overdrive / Distortion', body: '#f1c02c', ink: '#151515',
      type: 0x1E, typeUi: 'lcd',
      types: Object.fromEntries(Array.from({ length: 13 }, (_, t) => [t, {
        groups: [['Drive', [0x1F]], ['Tone', [0x20, 0x21]], ['Output', [0x22]]], main: [0x1F, 0x20, 0x21, 0x22],
      }])),
      labels: { 0x1F: 'Drive', 0x20: 'Bass', 0x21: 'Treble', 0x22: 'Level' },
      notes: {
        11: 'Custom 1: its character (bottom, attack, top, type, low / mid / high) is a system setting - System page, Custom OD/DS 1.',
        12: 'Custom 2: its character (bottom, attack, top, type, low / mid / high) is a system setting - System page, Custom OD/DS 2.',
      },
    },
    {
      code: 5, block: FX, abbr: 'PRE', title: 'PreAmp', body: '#c39b45', ink: '#151515', wide: true,
      type: 0x23, typeUi: 'lcd',
      types: Object.fromEntries(Array.from({ length: 15 }, (_, t) => [t, {
        groups: [['Pre-amp', [0x24, 0x25, 0x26, 0x27, 0x28, 0x29]], ['Switches', [0x2A, 0x2B]]],
        main: [0x24, 0x25, 0x26, 0x27, 0x28, 0x29],
      }])),
      labels: { 0x24: 'Volume', 0x25: 'Bass', 0x26: 'Middle', 0x27: 'Treble', 0x28: 'Pres.', 0x29: 'Master', 0x2A: 'Bright', 0x2B: 'Gain' },
      notes: {
        13: 'Custom PreAmp 1: its voicing (bottom, top, 3-tone, clip, gain, cabinet …) is a system setting - System page, Custom PreAmp 1.',
        14: 'Custom PreAmp 2: its voicing (bottom, top, 3-tone, clip, gain, cabinet …) is a system setting - System page, Custom PreAmp 2.',
      },
    },
    {
      code: 6, block: FX, abbr: 'SP', title: 'Speaker Simulator', body: '#4b3a2f', ink: '#f2e6d6',
      type: 0x2C, typeUi: 'lcd',
      types: Object.fromEntries(Array.from({ length: 14 }, (_, t) => [t, { groups: [['Cabinet', [0x2D, 0x2E, 0x2F]]] }])),
      labels: { 0x2D: 'Mic', 0x2E: 'Mic Lvl', 0x2F: 'Direct' },
      notes: { all: 'The System page "Speaker Sim" setting can force the cabinet on or off for every patch.' },
    },
    {
      code: 7, block: FX, abbr: 'EQ', title: 'Equalizer', body: '#d5d8dd', ink: '#151515',
      faders: [0x30, 0x33, 0x36, 0x37, 0x38],
      types: { null: { groups: [['Low', [0x30]], ['Low-mid', [0x31, 0x32, 0x33]], ['High-mid', [0x34, 0x35, 0x36]], ['High', [0x37]], ['Output', [0x38]]] } },
      labels: { 0x30: 'Low', 0x31: 'Freq', 0x32: 'Q', 0x33: 'Lo-Mid', 0x34: 'Freq', 0x35: 'Q', 0x36: 'Hi-Mid', 0x37: 'High', 0x38: 'Level' },
    },
    {
      code: 8, block: FX, abbr: 'FX2', title: 'Modulation (FX-2)', body: '#2e9a8c', ink: '#ffffff',
      type: 0x39, typeUi: 'lcd',
      types: {
        0: {
          groups: [['Harmony 1', [0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x42, 0x43]],
            ['Harmony 2', [0x44, 0x45, 0x46, 0x47, 0x48, 0x4A, 0x4C]], ['Output', [0x4D, 0x4E]]],
          main: [0x3C, 0x43, 0x4C, 0x4E],
        },
        1: { groups: [['Flanger', [0x4F, 0x50, 0x51, 0x52, 0x53]]] },
        2: { groups: [['Phaser', [0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A]]], main: [0x55, 0x56, 0x57, 0x58] },
        3: {
          groups: [['Low', [0x5B]], ['Low-mid', [0x5C, 0x5D, 0x5E]], ['High-mid', [0x5F, 0x60, 0x61]], ['High', [0x62]], ['Output', [0x63]]],
          main: [0x5B, 0x5E, 0x61, 0x62],
        },
        4: { groups: [['Short Delay', [0x64, 0x66]], ['Output', [0x67]]] },
        5: { groups: [['Humanizer', [0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F]]], main: [0x6C, 0x6D, 0x6E, 0x6F] },
        6: { groups: [['Ring Modulator', [0x70, 0x71]], ['Output', [0x72, 0x73]]] },
        7: { groups: [['Vibrato', [0x74, 0x75, 0x76]], ['Rise', [0x77]]], main: [0x74, 0x75, 0x77] },
        8: { groups: [['Acoustic Sim', [0x78, 0x79, 0x7A]]] },
        9: {
          groups: [['Input', [0x7B, 0x7C]], ['Wave', [0x7D, 0x7E, 0x7F, B(0x00)]], ['Filter', [B(0x01), B(0x02), B(0x03), B(0x04), B(0x05)]],
            ['Envelope', [B(0x06), B(0x07), B(0x08), B(0x09)]], ['Output', [B(0x0A), B(0x0B)]]],
          main: [B(0x01), B(0x02), B(0x0A), B(0x0B)],
        },
      },
      labels: {
        0x3A: 'Voices', 0x3B: 'Mode', 0x3C: 'Pitch', 0x3D: 'Fine', 0x3E: 'Scale', 0x3F: 'Harmony', 0x40: 'Pre Dly', 0x42: 'Fdbk', 0x43: 'Level',
        0x44: 'Mode', 0x45: 'Pitch', 0x46: 'Fine', 0x47: 'Scale', 0x48: 'Harmony', 0x4A: 'Pre Dly', 0x4C: 'Level', 0x4D: 'Key', 0x4E: 'Direct',
        0x4F: 'Rate', 0x50: 'Depth', 0x51: 'Manual', 0x52: 'Reso', 0x53: 'Separ.',
        0x54: 'Stages', 0x55: 'Rate', 0x56: 'Depth', 0x57: 'Manual', 0x58: 'Reso', 0x59: 'Step', 0x5A: 'Step Rate',
        0x5B: 'Low', 0x5C: 'Freq', 0x5D: 'Q', 0x5E: 'Lo-Mid', 0x5F: 'Freq', 0x60: 'Q', 0x61: 'Hi-Mid', 0x62: 'High', 0x63: 'Level',
        0x64: 'Time', 0x66: 'Fdbk', 0x67: 'Level',
        0x68: 'Mode', 0x69: 'Vowel 1', 0x6A: 'Vowel 2', 0x6B: 'Sens', 0x6C: 'Rate', 0x6D: 'Depth', 0x6E: 'Manual', 0x6F: 'Level',
        0x70: 'Mode', 0x71: 'Freq', 0x72: 'Effect', 0x73: 'Direct',
        0x74: 'Rate', 0x75: 'Depth', 0x76: 'Trigger', 0x77: 'Rise',
        0x78: 'Top', 0x79: 'Body', 0x7A: 'Level',
        0x7B: 'Sens', 0x7C: 'Wave', 0x7D: 'Chromatic', 0x7E: 'Octave', 0x7F: 'PWM Rate', [B(0x00)]: 'PWM Depth',
        [B(0x01)]: 'Cutoff', [B(0x02)]: 'Reso', [B(0x03)]: 'Flt Sens', [B(0x04)]: 'Decay', [B(0x05)]: 'Flt Depth',
        [B(0x06)]: 'Attack', [B(0x07)]: 'Release', [B(0x08)]: 'Velocity', [B(0x09)]: 'Hold', [B(0x0A)]: 'Synth', [B(0x0B)]: 'Direct',
      },
      notes: { 0: 'Harmony 2 sounds when Voices is 2-Mono or 2-Stereo. Scale User uses the user harmonies on the System page.' },
    },
    {
      code: 9, block: FX_B, abbr: 'DD', title: 'Delay', body: '#ececec', ink: '#151515',
      type: 0x0D, typeUi: 'seg',
      types: {
        0: { groups: [['Time', [0x0C, 0x0E, 0x12]], ['Filter', [0x16]], ['Output', [0x17, 0x18]]], main: [0x0E, 0x12, 0x16, 0x17] },
        1: { groups: [['Time', [0x0C, 0x0E, 0x10, 0x11, 0x12]], ['Filter', [0x16]], ['Output', [0x17, 0x18]]], main: [0x0E, 0x11, 0x12, 0x17] },
        2: { groups: [['Time', [0x0C, 0x0E, 0x12]], ['Filter', [0x16]], ['Output', [0x17, 0x18]]], main: [0x0E, 0x12, 0x16, 0x17] },
        3: {
          groups: [['Time', [0x0C, 0x0E, 0x12]], ['Sound on Sound', [0x13, 0x14, 0x15]], ['Filter', [0x16]], ['Output', [0x17, 0x18]]],
          main: [0x0E, 0x12, 0x16, 0x17],
        },
      },
      labels: {
        0x0C: 'Time mode', 0x0E: 'Time', 0x10: 'Interval', 0x11: 'Tap', 0x12: 'Fdbk', 0x13: 'Hold', 0x14: 'Record', 0x15: 'Smooth',
        0x16: 'Hi Cut', 0x17: 'Level', 0x18: 'Direct',
      },
    },
    {
      code: 10, block: FX_B, abbr: 'CE', title: 'Chorus', body: '#7cc3e6', ink: '#0f1f28',
      seg: 0x19,
      types: { null: { groups: [['Chorus', [0x19, 0x1A, 0x1B, 0x1C]], ['Filter', [0x1D]], ['Output', [0x1E]]], main: [0x1A, 0x1B, 0x1C, 0x1E] } },
      labels: { 0x19: 'Mode', 0x1A: 'Rate', 0x1B: 'Depth', 0x1C: 'Pre Dly', 0x1D: 'Hi Cut', 0x1E: 'Level' },
    },
    {
      code: 11, block: FX_B, abbr: 'TP', title: 'Tremolo / Pan', body: '#d4553b', ink: '#ffffff',
      type: 0x1F, typeUi: 'seg',
      types: Object.fromEntries([0, 1].map(t => [t, { groups: [['Tremolo / Pan', [0x20, 0x21, 0x22]], ['Output', [0x23]]], main: [0x21, 0x22, 0x23] }])),
      labels: { 0x20: 'Wave', 0x21: 'Rate', 0x22: 'Depth', 0x23: 'Balance' },
    },
    {
      code: 12, block: FX_B, abbr: 'RV', title: 'Reverb', body: '#3b4966', ink: '#f2f4f8',
      type: 0x24, typeUi: 'lcd',
      types: Object.fromEntries(Array.from({ length: 5 }, (_, t) => [t, {
        groups: [['Reverb', [0x25, 0x26, 0x29]], ['Filter', [0x27, 0x28]], ['Output', [0x2A]]], main: [0x25, 0x26, 0x29, 0x2A],
      }])),
      labels: { 0x25: 'Time', 0x26: 'Pre Dly', 0x27: 'Lo Cut', 0x28: 'Hi Cut', 0x29: 'Density', 0x2A: 'Level' },
    },
    {
      code: 13, block: FX_B, abbr: 'NS', title: 'Noise Suppressor', body: '#b8bdc5', ink: '#151515',
      types: { null: { groups: [['Noise Suppressor', [0x2C, 0x2D]]] } },
      labels: { 0x2C: 'Thresh', 0x2D: 'Release' },
    },
    {
      code: 14, block: FX_B, abbr: 'FV', title: 'Foot Volume', body: '#1e1f23', ink: '#e8e8ea',
      always: true, // no switch: always in the chain, the EXP pedal moves it
      types: { null: { groups: [['Foot Volume', [0x2E]]] } },
      labels: { 0x2E: 'Level' },
    },
  ];

  const MASTER_KNOBS = [[FX_B, 0x2B, 'Level']];

  const BY_CODE = new Map(PEDALS.map(p => [p.code, p]));
  const DEFAULT_ORDER = PEDALS.map(p => p.code);

  // {block, offset} of one of a pedal's parameters.
  const where = (pedal, o) => (o >= BLOCK2 ? { block: FX_B, offset: o - BLOCK2 } : { block: pedal.block, offset: o });

  // The type entry of a pedal for the patch's current type value (null key for one-type pedals).
  function typeOf(pedal, patch) {
    if (pedal.type === undefined) return { value: null, def: pedal.types.null };
    const value = GT5.getValue(patch, pedal.block, pedal.type);
    return { value, def: pedal.types[value] || null };
  }

  const isOn = (pedal, patch) => pedal.always || GT5.isOn(patch, pedal.code);

  // A parameter's caption: the pedal's own label, else its midi.xml name tidied up.
  function caption(pedal, o) {
    const { block, offset } = where(pedal, o);
    return pedal.labels[o] || GT5.param(block, offset).name.replace(/^.*:\s*/, '');
  }

  // The midi.xml value texts, made to fit under a knob: note values as 1/8, 1/8T, 1/8.
  const NOTES = { whole: '1/1', half: '1/2', quarter: '1/4', eighth: '1/8', sixteenth: '1/16' };
  function shortValue(text) {
    let t = text.replace(/\b(whole|half|quarter|eighth|sixteenth) note/, (_, n) => `${NOTES[n]} note`);
    t = t.replace(/^(doted |# )?(1\/\d+) note( triplet)?$/, (_, dot, n, tri) => n + (tri ? 'T' : '') + (dot ? '.' : ''));
    return t.replace(/mS$/, 'ms').replace(/ (%|ms|dB)$/, '$1').replace(/''$/, '').trim();
  }

  const valueText = (block, offset, value) => shortValue(GT5.label(GT5.param(block, offset), value));

  // Which control fits a parameter: knob for ranges and numeric steps, a
  // segmented switch for 2-4 named choices, a list for longer named lists.
  function widgetFor(p) {
    const table = GT5_PARAMS.tables[p.t];
    if (!table.every(Array.isArray)) return 'knob';
    if (p.max - p.min < 4) return 'seg';
    const numeric = table.filter(e => /^[-+]?\d/.test(e[1])).length;
    return numeric >= table.length * 0.8 ? 'knob' : 'select';
  }

  // Effect order of a patch; a broken chain (garbage in old files) shows in the default order.
  function order(patch) {
    const chain = GT5.chain(patch);
    return GT5.isValidChain(chain) ? chain : DEFAULT_ORDER;
  }

  // The pedal knobs: the type's `main` list, else its first four knob-type parameters.
  function mainParams(pedal, def) {
    if (def.main) return def.main;
    const all = def.groups.flatMap(g => g[1]);
    return all.filter(o => {
      const { block, offset } = where(pedal, o);
      return widgetFor(GT5.param(block, offset)) === 'knob';
    }).slice(0, 4);
  }

  // block * 256 + offset -> the chain code of the pedal the parameter belongs to.
  const OWNER = new Map();
  for (const pedal of PEDALS) {
    const offsets = [pedal.type, pedal.seg, ...(pedal.faders || [])];
    for (const def of Object.values(pedal.types)) offsets.push(...def.groups.flatMap(g => g[1]), ...(def.main || []));
    for (const o of offsets) {
      if (o === undefined) continue;
      const { block, offset } = where(pedal, o);
      OWNER.set(block * 256 + offset, pedal.code);
    }
  }
  // The pedal (chain code) a parameter belongs to, or null (master, name, chain...).
  const pedalOf = (block, offset) => OWNER.get(block * 256 + offset) ?? null;

  return {
    PEDALS, BY_CODE, DEFAULT_ORDER, MASTER_KNOBS,
    where, typeOf, isOn, caption, shortValue, valueText, widgetFor, order, mainParams, pedalOf,
  };
})();
