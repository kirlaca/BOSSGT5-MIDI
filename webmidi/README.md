# GT-5 Editor – Web MIDI változat

A Qt-s GT-5 FxFloorBoard böngészős átirata, **backend és Python nélkül**: a böngésző a
[Web MIDI API](https://developer.mozilla.org/docs/Web/API/Web_MIDI_API)-n keresztül közvetlenül
beszél a MIDI interfésszel. Felépítés és design: a GT-3 editor (`D:\BOSS_PEDALS\BOSSGT3\webmidi\`),
az pedig a ME-5 editorból jött. A teljes terv és napló: [`../WEBMIDI_FELDERITES.md`](../WEBMIDI_FELDERITES.md).

## Állapot

- [x] 1. `midi.xml` → `gt5-params.js` generátor (Node)
- [x] 2. Protokoll réteg (`gt5.js`) + Web MIDI réteg (`midi.js`)
- [ ] 3. Próba a pedállal
- [x] 4–5. Effektek oldal (pedál nélkül kész)
- [x] 6. EXP / CTL / Assign oldal, FX Chain átrendezés (pedál nélkül kész)
- [x] 7. Library és System oldal (custom OD/DS, custom preamp, harmónia-skálák is)
- [x] 8. Útmutatók: `utmutato.html` (magyar), `guide.html` (angol) – a pedálos próba után frissíteni kell

## Fájlok

| Fájl | Mi ez | Qt megfelelő |
|---|---|---|
| `gt5-params.js` | **generált** – minden patch- és system-paraméter, értéktáblák, assign célok | `midi.xml` + `MidiTable.cpp` |
| `factory.js` | **generált** – `default.syx` (init patch) és `system.syx` base64-ben | `:default.syx`, `:system.syx` |
| `gt5.js` | SysEx üzenetek, patch modell, be/ki bitek, értékek és feliratok, fájl be/ki | `SysxIO.cpp`, `MidiTable.cpp`, `sysxWriter.cpp`, `stompBox.cpp` |
| `midi.js` | Web MIDI: portok, GT-5 felismerés, patch olvasás/írás, programváltás | `midiIO.cpp` (RtMidi) |
| `effects.js` | effekt blokkonként: pedál szín, típus paraméter, típusonként a paramétercsoportok | `stompbox_*.cpp` szerkesztőoldalai |
| `assign.js` | EXP / CTL / Assign oldal | `menuPage_assign.cpp`, `customControlTarget.cpp` |
| `library.js` | Library oldal: mind a 250 patch listában, olvasás / írás / másolás / init / mentés | `bankTreeList.cpp`, `bulkLoadDialog.cpp`, `bulkSaveDialog.cpp` |
| `system.js` | System oldal: tuner, kimenet, globális EQ, vezérlők, MIDI, manual, custom OD/DS + preamp, user harmónia-skálák | `menuPage_system.cpp` |
| `app.js` | a felület: kijelző, patch térkép, FX Chain, pedálok, részletes panel, Write / fájlok / kapcsolat | `floorBoard.cpp`, `floorBoardDisplay.cpp`, `editWindow.cpp` … |
| `utmutato.html`, `guide.html`, `pages.css` | használati útmutató magyarul és angolul | `GT-5EditorManual_E.htm` |
| `ask.js`, `style.css`, `index.html` | párbeszédablakok, stílus (a GT-3 editoréból, GT-5 színekkel: indigó + narancs) | |

A generált fájlokat kézzel nem szerkesztjük; újragenerálás (a projekt gyökeréből):

```
node tools/gen_gt5_params.mjs
```

## Indítás

Nyisd meg az `index.html`-t Chrome-ban vagy Edge-ben. Ha `file://`-ról nem kér MIDI engedélyt:
`node tools/serve.mjs`, és a `http://localhost:8000/` cím.

## Protokoll röviden

- Fejléc `F0 41 <dev> 00 04 <cmd>` (model ID `00 04`), 4 bájtos cím, Roland checksum (cím + adat).
- Patch = blokkonként egy DT1 üzenet, cím `<terület> <terület> <blokk> 00`, 6 üzenet / 426 bájt:
  - `00` be/ki bitek (00–07) és effektlánc (08–16, 15 effekt kód), `01` effektek (128 bájt), `02` az `01` folytatása
    (Synth vége, DD, CE, TP, RV, Master, NS, FV), `03`–`04` EXP / CTL / Assign 1–8, `05` név (12 bájt, 11 látszik).
  - `0A 00` – temp patch egészben (bulk küldés, és innen olvassuk vissza: RQ1 méret `00 00 05 0C`)
  - `0B 00` – temp patch paraméterenként (élő szerkesztés: `0B 00 <blokk> <offset> <érték>`); a fájlok is ezzel a címmel készülnek
  - `07 nn` / `08 nn` / `09 nn` – patch nn % 100: U1-1-1 … U4-5-5 (0–99), presetek P1-1-1 … P6-5-5 (100–249)
- **Be/ki kapcsolók**: nem bájtonként, hanem 4 bit / bájt a `00` blokkban (`stompBox.cpp`):
  `03`: FX1 1, CS 2, WAH 4, LOOP 8 · `02`: OD 1, PRE 2, SP 4, EQ 8 · `01`: FX2 1, DD 2, CE 4, TP 8 · `00`: RV 1, NS 2 ·
  `07`: EXP 1, CTL 2 · `05`: Assign 1–4 · `04`: Assign 5–8. Kapcsoláskor a teljes bájt megy ki.
- Assign target: **egy bájt** (126 cél, a Qt is így olvassa), utána egy kihasználatlan bájt; Min / Max kétbájtos (7-7 bit).
  A be/ki célok a FloorBoard virtuális `19`-es címére mutatnak (Off/On tábla).
- System dump 1367 bájt, 16 üzenet: Tuner `00 00 00`, Global `01 00 00`, System `01 01 00`, MIDI `01 02 00` (+ programtábla
  `01 02 10`–`15`), harmónia-skálák `01 03 00`–`02`, custom OD/DS `01 04 00`, custom preamp `01 05 00`, Manual `02 00 00`.
- Patchváltás: `B0 00 <n/100>`, `B0 20 00`, `C0 <n%100>`.
- A 17–19. blokk (patch leírás, szerző, jegyzet) csak a FloorBoard fájljaiban létezik, `F0 00 00 00 1B …` fejléccel;
  a pedálra soha nem megy ki.

## Ami a valódi GT-5-en kiderült (2026. október)

| | Eredmény | A szerkesztőben |
|---|---|---|
| Olvasás kéréssel (RQ1) | csak a `00` blokk helyes; a többire a belső, 8 bites memóriaképét küldi más címzéssel, a teljes-patch kérésre beakad („DATA SENDING”) | `READ_BY_REQUEST = false` (app.js); a Read gombok a Bulk Dumphoz adnak útmutatót |
| Bulk Dump (a gépen indítva) | hibátlan: 811 üzenet / 48 kB / 72 s, rendszer + listák + 100 patch + temp | `receiveDump`; teljes dumpfájl is betölthető; hosszú dump a böngészőben elakadhat → `tools/gt5_tester.py receive` |
| Élő szerkesztés (`0B 00`) | üzenetenként **egy paramétert** vesz át (a név betűnként, a lánc slotonként); egy paraméter 20 ms-onként is bírja | `edit`/`setOn`/`setPatchName`/`setChain` így küld |
| **Sound Change Request** (`0A 00 06 00`, „GT5 Midi implementation.pdf”) | a `0B 00`-ra küldött paraméter **csak utána szól** – bármit mutat a kijelző; nélküle csak a kijelzőn épp kiválasztott paramétert vette át. Típus, Master Level, CC-vel később bekapcsolt effekt paramétere is működik. A `0A 00` (bulk) terület BULK LOAD nélkül semmit nem vesz át. A Qt FloorBoard SCR-t nem küld | `GT5.soundChange` / `withSoundChange`: minden paraméter és a lánc után (`queueSend(…, {soundChange: true})`, `sendChanges`) |
| Kikapcsolt effekt paramétere | a GT-5 eldobja (a pont mégis megjelenik); a bekapcsolt effekt módosítása ki-be kapcsolás után is megmarad | élő kapcsolós bekapcsolás után a szerkesztett paraméterei újra kimennek (`state.touched`, `touchedMessages`) |
| EXIT / WRITE a GT-5-ön szerkesztés után | az EXIT nem dob el semmit; a WRITE a küldött értékeket menti | – |
| Sok változás egyszerre (pl. teljes patch, ~350 üzenet) | „overflow”, a sor közepe elvész; EXP/CTL/assign a temp-ben nem változik | `GT5.liveChanges` + legfeljebb 40 üzenet, 60 ms-onként (Revert, Init, fájl) |
| Írás a memóriába (`07 nn`) | normál módban figyelmen kívül hagyja; **BULK LOAD** („waiting”) oldalon fogadja, **EXIT**-re (~5 s) tárol | Write / Write to GT-5: `askBulkLoad` → küldés (80 ms/üzenet) → `askExit`; auto write kikapcsolva |
| Handshake (RQD) | nem válaszol | – |
| Effekt be/ki SysEx-szel (be/ki bitek) | a kikapcsolás szól (LED nem frissül); a **bekapcsolás hibás hangot ad** a patch újratöltéséig – SCR-rel is; élő kapcsolós effekten a bit semmit nem tesz | élő kapcsoló nélkül a bekapcsolás a Write-ra vár (`state.pendingOn`, villogó LED) |
| Effekt be/ki Assign + MIDI CC | élőben, LED-del, mindkét irányban hibátlan; csak **változásra** reagál (patchbetöltés után a CC 0); ha Assign vezérli az effektet, a SysEx-bit hatástalan | „élő kapcsolók”: Assign 1–8 = CC#20–27 → OD, PRE, EQ, FX2, DD, CE, RV, WAH (`GT5.setLiveSwitches`, Write-kor); kapcsolás: ellentétes érték, majd a kívánt (`GT5.liveSwitchMessages`) |

## Tesztek (pedál nélkül)

```
node tools/test_gt5.mjs    # protokoll: a Qt képletei, default.syx, system.syx, 214 valódi patch-fájl
node tools/test_midi.mjs   # midi.js egy szimulált GT-5 ellen (felismerés, olvasás, írás, system)
```
