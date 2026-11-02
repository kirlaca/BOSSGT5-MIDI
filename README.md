# GT-5 MIDI Editor

A patch editor for the **BOSS GT-5 Guitar Effects Processor** (1996), controlled over MIDI SysEx from a computer or phone. It is a browser port of the Qt [GT-5 FxFloorBoard](http://sourceforge.net/projects/fxfloorboard/), built like the author's GT-3 and ME-5 editors.

No install needed: the editor runs entirely in Chrome or Edge using the Web MIDI API, with no server-side code. (A small Python tool in `tools/` helps with testing and with taking in long Bulk Dumps; the editor does not need it.)

> **Status:** tried with a real GT-5 (October 2026). The GT-5 is particular over MIDI, and the editor works the way it does:
> - **Reading:** the GT-5 can't be asked for its patches – it answers a data request correctly only for the first block. It sends them in a **Bulk Dump started on the unit**, which the editor takes in (or `tools/gt5_tester.py receive` saves to a file, more reliable for a full dump).
> - **Live editing** works one parameter per message into the temporary patch (EXP / CTL / assign settings excepted).
> - **Writing** works only with the GT-5 on its **BULK LOAD** page; EXIT stores what came. The editor guides through it.
>
> Back up first: a full Bulk Dump saved to a file. [`WEBMIDI_FELDERITES.md`](WEBMIDI_FELDERITES.md) has the measurements.

## What it does

- **Effects page:** the patch's 15 effect blocks as BOSS-style pedals – FX1, CS, WAH, LOOP, OD/DS, PRE, SP, EQ, FX2, DD, CE, TP, RV, NS, FV – standing in the patch's own effect chain order, which can be rearranged by dragging. Type-dependent blocks (13 OD/DS, 15 preamp, 14 speaker, 10 FX-2 types, …) swap their knobs with the type; every parameter of every type is in the detail panel.
- **EXP / CTL / Assign page:** the expression pedal, CTL pedal and the 8 assigns – 126 targets, Min / Max in the target's own units, source, mode, active range, response curve, internal and wave pedal.
- **Library page:** all 250 patches (100 user + 150 preset) in a list; read, write, copy, init and save many at once.
- **System page:** tuner, output, global EQ, controls, MIDI, manual mode – and the GT-5's custom OD/DS, custom preamps and 29 user harmony scales.
- Edits are sent to the unit's temporary patch live, so you hear them immediately; Write stores them in a user patch.
- Reads and writes the FloorBoard's `.syx` files (single patches, bulk dumps, system dumps).

## What you need

- A BOSS GT-5.
- A USB-MIDI interface connected to both MIDI IN and MIDI OUT of the unit.
- Chrome or Edge on desktop or Android. Safari and iOS do not support Web MIDI.

## Using it

1. Connect the interface, crossed over: interface OUT → GT-5 MIDI IN, interface IN ← GT-5 MIDI OUT.
2. Open `webmidi/index.html` (or run `node tools/serve.mjs` and open `http://localhost:8000/`), and allow MIDI / SysEx access.
3. Pick the ports, device ID and patch change channel (auto-detect asks the GT-5 for data, which can leave it stuck on "DATA SENDING" – then switch it off and on).
4. On the GT-5 start a Bulk Dump (UTILITY → MIDI → PARAMETER … BULK DUMP); the editor takes the patches in. Save them.
5. Edit; to store, use Write (it guides you through the GT-5's BULK LOAD page) or the GT-5's own WRITE button.

User guides: [English](webmidi/guide.html) · [Magyar](webmidi/utmutato.html).

## Repository layout

| Path | What it is |
|---|---|
| `webmidi/` | **The editor.** Plain HTML/CSS/JS, no build step. See [`webmidi/README.md`](webmidi/README.md) (Hungarian) for the files and the protocol. |
| `index.html` | GitHub Pages entry point; redirects to `webmidi/`. |
| `tools/gen_gt5_params.mjs` | Generates `webmidi/gt5-params.js` and `webmidi/factory.js` from the FloorBoard's `midi.xml`, `default.syx` and `system.syx` (Node, no dependencies). |
| `tools/test_gt5.mjs`, `tools/test_midi.mjs` | Tests without a GT-5. |
| `tools/serve.mjs` | A tiny local web server for the editor. |
| `tools/gt5_tester.py` | A Windows test tool that talks to the GT-5 directly through winmm (no browser, no packages): `ports`, `listen`, `connect`, `handshake`, `receive` (takes in and saves a Bulk Dump). |
| `tools/temp_experiment.py` | The experiment that showed how the GT-5's temporary patch takes changes. |
| `gt-5fxfloorboard_source_code_20250419/` | The Qt FloorBoard source this is ported from. |
| `docs/` | The GT-5 service notes (local only, not redistributed). |
| `WEBMIDI_FELDERITES.md` | Survey, design notes and progress log (Hungarian). |

```
node tools/gen_gt5_params.mjs   # midi.xml -> webmidi/gt5-params.js, webmidi/factory.js
node tools/test_gt5.mjs         # protocol, default.syx / system.syx, real patch files
node tools/test_midi.mjs        # midi.js against a simulated GT-5
```

## Credits and license

The parameter map, value tables, patch format and SysEx protocol come from the **GT-5 FxFloorBoard** by Colin Willcocks, based on the FxFloorBoard by Uco Mesdag – licensed under the GNU GPL v2 or later.

Licensed under the GNU GPL v3. See [LICENSE](LICENSE). No warranty: use at your own risk.

BOSS and GT-5 are trademarks of Roland Corporation. This project is not affiliated with Roland.
