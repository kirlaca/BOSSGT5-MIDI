# GT-5 FxFloorBoard → Web MIDI port – felderítés

Dátum: 2026-10-22 · Állapot: **1–2. és 4–8. lépés kész** (pedál nélkül tesztelve); a 3. lépés (próba a pedállal) a
pedálra vár. Részletek: [`webmidi/README.md`](webmidi/README.md).

## Döntés

A Qt/C++ programot **újraírjuk JS-ben**, csak Web MIDI alkalmazásként – **Python nélkül** (a ME-5-nél volt Python
backend, itt nincs; a generátor és a tesztek is Node-ban vannak, függőség nélkül). Minta és design: a GT-3 editor
(`D:\BOSS_PEDALS\BOSSGT3\webmidi\`) – ugyanaz a fájlfelosztás, a GT-5 sajátosságaival.

## A mostani program (Qt/C++)

- ~180 fájl, Qt `widgets` + `xml`; MIDI: `midiIO.cpp` (RtMidi), SysEx: `SysxIO.cpp`, `MidiTable.cpp`.
- Paramétertábla: `midi.xml` (~2,6 MB) – **újrahasznosítva** a generátorral.
- Effekt blokkok: `stompbox_*.cpp` (FX1, CS, WAH, LOOP, OD, PRE, SPEAKER, EQ, FX2, DD, CE, TP, RV, NS, FV).
- `default.syx` (654 bájt), `system.syx` (1367 bájt), `packager/` alatt 226 `.syx` fájl (214 GT-5-ös, 873 patch).

## GT-3 → GT-5 különbségek (a kódból kiolvasva)

| | GT-3 | GT-5 |
|---|---|---|
| Model ID | `00 1B` | `00 04` |
| Patch | 23 blokk, 650 bájt | 6 blokk (`00`–`05`), 426 bájt |
| Temp patch | `0C 00` írás, `0B 00` olvasás | `0B 00` paraméterenként, `0A 00` egészben + olvasás |
| Patch memória | 35×4 user + 50×4 preset | 20×5 user + 30×5 preset, kijelzés csoport-bank-szám (`U1-1-1`) |
| Patch cím | `07 + slot/128`, preset új 128-as lapon | `07 + n/100`, `n % 100` (`MidiTable::patchRequest`) |
| Be/ki | bájt per effekt | **4 bit / bájt** a `00` blokk 00–07 bájtján (`stompBox.cpp`) |
| Lánc | 12 effekt, külön blokk | 15 effekt, a `00` blokk 08–16 bájtja |
| Assign target | kétbájtos kód | egy bájt (126 cél) + kihasználatlan bájt |
| System | 2 terület | 16 üzenet; custom OD/DS, custom preamp, 29 user harmónia-skála is |

## Észrevételek

- `globalVariables.h` system kérése `…02 00 00 05 7D F7` – a checksum (7D) a GT-3 változatból maradt, a helyes 79.
  A webes változat a helyeset küldi. **Pedálon ellenőrizendő**, hogy a GT-5 válaszol-e rá.
- A `midi.xml` SYN Octave Shift-je „01=-2”-t ír, a valódi patchekben 02 van – a generátor javítja (mint a GT-3-nál).
- A név blokk 12 bájt (a `midi.xml` 11-et ír le); régi fájlokban 11 bájtos is előfordul – betöltéskor elfogadjuk.
- 17 fájlban hibás a checksum (00 helyett 80, vagy eggyel eltér). A FloorBoard ezt nem nézi (a hibaüzenet ki van kommentezve),
  így a fájlbetöltés sem; a gépről érkező adatnál viszont ellenőrizzük.
- 12 fájl a `saved patches` alatt nem GT-5-ös (más model ID: GT-3 és egy régebbi formátum) – kihagyjuk.
- 13 patchben érvénytelen a lánc – ilyenkor az alap sorrendben jelenik meg (írás nélkül nem változik).
- Néhány név 0x16–0x1F kódokat tartalmaz (a GT-5 saját jelei?) – `·`-ként jelenik meg; 7E / 7F nyilak.
- A FloorBoard írás előtt figyelmeztet: „ENSURE BULK MODE IS SELECTED – Utility > Midi > Parameter > 11 times”.
  A Write párbeszédablak és az útmutató ezt tovább adja.

## Pedálon ellenőrizendő a munka elején

- [ ] Identity request (`00 00 00 00`, 1 bájt) válaszol-e, és melyik device ID-n.
- [ ] Temp olvasás `0A 00`-ról, élő szerkesztés `0B 00`-ra – hallatszik-e azonnal.
- [ ] Be/ki bit kapcsolása (teljes bájt küldése) helyesen kapcsolja-e a többi effektet a bájtban.
- [ ] System kérés a helyes checksummal (79) – válaszol-e, 1367 bájt jön-e.
- [ ] Write user patchbe: kell-e a bulk mód; 6 üzenet közt elég-e az 5 ms szünet.
- [ ] Device ID ↔ MIDI csatorna megfelelés a programváltáshoz.
- [ ] Assign target: tényleg egy bájt-e, és a második bájt értéke számít-e.
- [ ] Min > Max fordított irányt ad-e; Toggle mód.

## Haladás

### 2026-10-22 – 1–2. és 4–8. lépés (pedál nélkül)

- `tools/gen_gt5_params.mjs` (Node, saját minimális XML olvasóval) → `webmidi/gt5-params.js` (9 blokk, 511 patch-paraméter,
  407 system-paraméter, 126 assign cél, 105 értéktábla) és `webmidi/factory.js`. Blokkméretek a `default.syx`-ből.
- `webmidi/gt5.js` – protokoll és patch modell (be/ki bitek, lánc, név, targetek, system terület);
  `webmidi/midi.js` – Web MIDI (a GT-3-éból).
- Felület a GT-3 editor mintájára: `index.html`, `app.js`, `effects.js` (15 pedál, típusfüggő csoportok a `stompbox_*.cpp`
  szerint, FX2 Guitar Synth a `02` blokkba átnyúló paraméterekkel), `assign.js` (EXP, CTL, Assign 1–8; az Assign 8 a `03`
  blokk végén kezdődik és a `04`-ben folytatódik), `library.js` (250 patch), `system.js` (a GT-3-asnál több: custom OD/DS 1–2,
  custom preamp 1–2, 29 user harmónia-skála). Színek a géphez: indigó-ibolya + narancs felirat.
- Útmutatók: `webmidi/utmutato.html`, `webmidi/guide.html`.
- Tesztek: `tools/test_gt5.mjs` 34/34 (Qt képletek mind a 250 patchre, programváltás, `default.syx` bájtra azonos
  visszaírása, be/ki bitek, system dump, 214 valódi fájl visszakódolása), `tools/test_midi.mjs` 8/8 (szimulált GT-5).
- Böngészőben (fej nélküli Edge) végigkattintva mind a négy oldal, mobil szélesség is – JS hiba nélkül.

### 2026-10-22 este – első próba a pedállal (DOREMiDi interfész, Chrome/Edge)

- A pedál beállításai: RX ch 16, OMNI on, TX = RX, **Device ID 32** (SysEx-ben `1F`), PC OUT on.
- A számítógép → GT-5 irány működik; a GT-5 a programváltást a 16-os csatornán visszaküldi.
- **A FloorBoard egész-patch kérésére (`07 nn 00 00`, méret `00 00 05 0C`) a GT-5 nem válaszol, kiírja hogy
  „DATA SENDING…” és lefagy** – csak ki-bekapcsolás oldja. A kért tartomány átível a blokkok közti réseken.
- **A GT-5 saját BULK DUMP-ja hibátlanul megjön** (a DOREMiDi a 140 bájtos SysEx-et is átviszi), formátuma pontosan
  a mi modellünk: patchenként 6 üzenet `07 nn bb 00` címmel, 24 / 128 / 48 / 128 / 14 / 12 bájt. A dumpban vannak
  a `03`–`06` területek is (effekt-nevek listái, pl. „FEEDBACKER”) – ezeket a midi.xml nem írja le, figyelmen kívül hagyjuk.
- Változások: a szerkesztő mostantól **blokkonként** kér (6 kérés pontos mérettel), és ha az első sem kap választ,
  nem kérdez tovább; minden bejövő MIDI üzenet naplózva (kapcsolat ablak → MIDI log); a GT-5 kérés nélkül küldött
  bulk dumpját beveszi (patchek a helyükre, rendszeradat a System oldalra).
- Még ellenőrizendő: válaszol-e a GT-5 a blokkonkénti kérésre; az írás (Write) Bulk Load módban.
- 23:17 – a blokkonkénti kérésre **a GT-5 először válaszolt**: a `00` blokk (24 bájt, méret `00 00 00 18`) megjött,
  a `01` blokk 128 bájtos kérésére (`00 00 01 00`) viszont már nem, és újra beakadt. Ezért most minden kérés
  legfeljebb 64 bájt (patchenként 8 kérés), és a system terület is így, 25 darabban olvasódik (a darabok
  összefésülve, mentéskor a `system.syx`-szel bájtra azonos). Bármely elmaradt válasz után nincs több automatikus kérés.
- 23:24 / 23:28 (gyári reset után, Device ID 1-gyel is): a `00` blokkot a GT-5 helyesen küldi, a `01`-re adott
  válasza viszont **hibás**: a kétbájtos értékeket 8 bitesen adja (Delay Time 400 ms = `01 90`, 471 ms = `01 D7`),
  a `90` / `D7` státuszbájt a SysEx közepén megszakítja az üzenetet (a böngésző eldobja, a maradék
  `90 xx xx` / `D7 xx` üzenetekként jön). A válasz a `02` blokk adatait is tartalmazza – a GT-5 belső, 8 bites
  memóriaképét küldi. **Ez firmware-sajátosság, programból nem kerülhető meg.** A Qt FloorBoard csatlakozása is csak
  Device ID 1-gyel működik (`idRequestString` / `idReplyPatern` fixen `00`).
- **Döntés:** a beolvasás a GT-5 saját BULK DUMP-jával megy (UTILITY → MIDI → PARAMETER … BULK DUMP), amit a szerkesztő
  átvesz; adatkérés (RQ1) nem megy ki (`READ_BY_REQUEST = false` az `app.js`-ben, a kód megmaradt). A Read gombok
  ehhez adnak útmutatást.
- Következik: élő szerkesztés (DT1 a `0B 00` temp címre) és Write (Bulk Load mód?) kipróbálása – csak mentés után.

### 2026-10-23 – Python tesztelő (`tools/gt5_tester.py`, winmm közvetlenül, csomag nélkül)

- A DOREMiDi USB-bemenete a böngészős próbák után **beragadt** (semmi nem jött be, RtMidi-vel sem); kihúzás-visszadugás oldotta.
- Nyers winmm-mel is ugyanaz: a `00` blokk kérésére helyes válasz; a `01` blokk kérésére a válasz a `07 00 01 00` címmel
  a **`01` blokk utolsó 20 bájtjával** kezdődik, utána a `02` blokk jön, a Delay Time `03 10` helyett **`01 90`** (8 bites),
  a `90`-nél a Windows megszakítja a SysEx-et. → Az RQ1 válasz a GT-5 belső, 8 bites memóriaképe, más címzéssel. Végleges.
- **Teljes Bulk Dump a tesztelővel hibátlan:** 811 üzenet, 48 121 bájt, 71,7 s; rendszeradat, `03`–`06` listák,
  mind a 100 user patch (`07 00`–`07 63`), a temp patch (`0A 00`); 0 hibás checksum. Mentve: `gt5-bulk-dump.syx`.
  A gt5.js bájtra helyesen dekódolja (100 + 1 patch, system 16 chunk / 1367 bájt).
- Tehát a dump közbeni megszakadás a **böngésző / Web MIDI** oldalán van (Chrome WinMM bemenet), nem a kábelnél
  és nem a GT-5-nél. A szerkesztő a mentett teljes dump fájlt (rendszer + patchek) egyben be tudja tölteni.
- **Írás a memóriába:** normál módban a `07 nn` DT1-et a GT-5 figyelmen kívül hagyja. **BULK LOAD** oldalon („waiting”,
  magától indul) fogadja („receiving” → „idling”), és **EXIT-kor** (kb. 5 s ellenőrzés után) tárolja – így sikerült
  az U4-5-5 átnevezése és visszaállítása a mentésből.
- **Temp patch (élő szerkesztés, `0B 00`):** üzenetenként **egy paramétert** vesz át: a 11 betűs név egy üzenetben
  csak az első betűt írta át, betűnként küldve az egészet; az effekt be/ki bájtok (00–03) egy üzenetben is mentek
  (LED-ek és visszaolvasás), egy teljes blokkból csak az eleje. A kijelző a temp név változását nem mutatja, csak a
  villogó pontot (módosítva); a pedál WRITE gombja a temp-et menti (névvel együtt).
  → A szerkesztő a nevet és az effektláncot ezentúl bájtonként, külön üzenetben küldi. Teljes patch temp-be töltésére nem építünk.

### 2026-10-23 – a mérések alapján átépítve

- **Overflow-mérés:** egy paraméter (Master Level) 30 lépésben 100 / 50 / 20 ms-onként – egyszer sem „overflow”.
  A 354 különböző paraméteres sor (E3) 150 ms-onként is „overflow”-ba futott → a típusváltások / a sok különböző
  paraméter terheli, nem a sebesség. Menüben (BULK DUMP oldal) állva a temp-be küldés azonnal „overflow”.
- **Szerkesztő:** a teljes patch temp-be küldése (`Midi.sendTemp`) megszűnt; Revert / Init / fájlbetöltés után csak a
  változások mennek (`GT5.liveChanges`, legfeljebb 40, 60 ms-onként, assign rész nélkül). Write és Library → Write to
  GT-5: vezetett BULK LOAD → küldés → EXIT. Auto write kivéve. Az Assign oldal jelzi, hogy ott a változás csak
  kiírás után hat. A név és a lánc bájtonként megy.
- **Útmutatók** (`guide.html`, `utmutato.html`), README-k frissítve a mért viselkedéssel.
- Nyitott: a böngészős dumpfogadás elakadása (valószínűleg a DOREMiDi bemenet beragadása hosszú / hibás SysEx után –
  a Pythonos fogadásnál is előfordult egyszer); addig a teljes dumphoz a `gt5_tester.py receive` ajánlott.
- A teszteléskor az U4-5-5 a WRITE gomb miatt „SINGLE TEST” névvel került a memóriába – a felhasználó factory resettel
  állítja helyre (a reset előtti állapot: `gt5-bulk-dump.syx`).

### 2026-10-23 éjjel – teljes állapot-szinkron: elvetve

- Ötlet: minden állítás után a teljes patch-állapotot (12 típusváltó + 190 paraméter) lassan a temp-be küldeni, hogy a
  pedál WRITE gombja mindig a szerkesztő állapotát mentse.
- Egyenként minden stabil: típusváltás (+ utána 8 s paraméterfolyam), lánccsere, a teljes lánc újraküldése, egy paraméter
  20 ms-onként, a lista bármelyik ~25-ös szakasza és a két fele külön is (300 ms). (A kijelzőn látott „csík” egy effekt
  kijelzése volt, nem a MIDI puffer.)
- A teljes sorozat viszont (E4: 250 ms, E4b: 500 ms, és még egyszer 300 ms) **overflow-t, újraindulást, lefagyást**
  okozott, egyszer „Receive error”-t; a lefagyás után az U1-1-2 **memóriájában** megváltozott a lánc, és a `00` blokk
  17-es bájtja `C0` lett (szabálytalan) – a ki-be kapcsolás után is. → A felhasználó factory resetet csinált.
- **Döntés:** nincs teljes-állapot szinkron. Élőben csak a felhasználó állításai mennek (paraméterenként); Revert / Init /
  fájl után legfeljebb **10** változás, **300 ms**-onként (`LIVE_LIMIT`, `LIVE_GAP_MS` az app.js-ben), egyébként Bulk
  Load-os Write. A tesztelő `bisect_send.py`-ja életjelet figyel (a temp `00` blokk olvasása) – így a lefagyás helye mérhető.

### 2026-10-23 – effekt be/ki: SysEx helyett Assign + MIDI CC („élő kapcsolók”)

- **Be/ki SysEx-szel** (a `00` blokk 00–03 bitjei, `0B 00 00 0n`): a bitkiosztás helyes (OD-próba, visszaolvasás), de
  - a **kikapcsolás** élőben szól, a LED nem frissül;
  - a **bekapcsolás** hibás hangot ad („tiszta”, a Preamp torzítása is eltűnik), akkor is, ha az effekt betöltéskor be volt
    kapcsolva; típusváltás, lánccsere, paraméterek újraküldése nem javítja – csak patchváltás vagy WRITE + újratöltés.
    A Qt FloorBoard is így küldte, ott is hibás volt.
- **Assign + MIDI CC** (forrás CC#1–31 = 7 + CC, CC#64–95; cél az effekt On/Off kódja, Min 0, Max 1, Normal mód):
  élőben, ismételhetően kapcsol be és ki, **LED-del együtt**, és a bekapcsolt effekt hibátlanul szól (a Preamp torzítása is).
  Az Assign célja SysEx-szel élőben **nem** írható át (a 03/04 blokkot a temp nem veszi át) → az élő kapcsolókat egyszer,
  Bulk Load-dal kell a patchbe írni.
- **„LIVE SW TEST”** (U4-5-5, `tools/livesw_test.txt`, az U1-1-1 másolata): A1–A8 = CC#20–27 → OD, PreAmp, FX1, FX2, DELAY,
  CHORUS, REVERB, WAH. Mind a 8 be és ki rendben (hang + LED), a 03 és a 04 blokkba nyúló A5–A8 is.
- **Csak változásra reagál:** a CC kiinduló értéke patchbetöltéskor 0, így a betöltéskor bekapcsolt effekt (PRE, REV) a
  `0` küldésére nem kapcsolt ki; `127` → `0` után igen. → A szerkesztő kikapcsoláskor előbb `127`-et, utána `0`-t küld
  (bekapcsoláskor elég a `127`, a felesleges `0` → `127` sem árt).
- A CC-s kapcsolás a temp memóriában is megjelenik (visszaolvasva a be/ki bájtok az állapotnak megfelelők).
- **Ha Assign vezérli az effektet, a SysEx be/ki hatástalan:** a PRE bit SysEx-szel `00` lett (visszaolvasva), a Preamp
  mégis szólt, LED égett. Utána a CC továbbra is helyesen ki- és bekapcsolta (ép torzítással).
- **On/Off target-kódok:** FB 00, SG 05, Comp 06, Limit 08, Wah 0A, AutoWah 0D, Loop 12, OD 14, PreAmp 1A, SPKR 24,
  EQ 26, HARM 2C, FLANGER 35, PHASER 3B, SEQ 42, SDD 48, HU 4B, RM 52, VB 56, AC 5A, SYN 5E, DELAY 64, CHORUS 6C,
  TREM 70, REVERB 74, NS 78, MANUAL 7A, TUNER 7B. Az FX1 / FX2 / WAH célja a kiválasztott típustól függ.
- **Terv a szerkesztőbe:** (1) „élő kapcsolók” a patch szabad Assign-jaira (egyszeri Bulk Load-os Write); (2) a be/ki gomb
  CC-t küld, ha az effektnek van élő kapcsolója; (3) ha nincs: kikapcsolás SysEx-szel, bekapcsolásnál figyelmeztetés
  (WRITE + újratöltés kell).
- **Beépítve (2026-10-23):** a felhasználó döntése szerint az A3 FX1 helyett **EQ** (`26`), így a fix elrendezés
  Assign 1–8 = CC#20–27 → OD, PRE, EQ, FX2, DD, CE, RV, WAH; csak az FX2 és a WAH célja függ a típustól. Nincs külön
  „simple” üzemmód: mind a 15 pedál szerkeszthető, a be/ki pedig pedálonként a fentiek szerint megy (CC / SysEx-ki /
  Write-ra váró be). „Live pedals only” nézetszűrő. A Write (és a Library → Write to GT-5) beírja az élő kapcsolókat;
  saját Assign-okat (32 gyári user patch) csak rákérdezés után ír felül. `GT5.onTarget`, `liveSwitch`, `ownAssigns`,
  `setLiveSwitches`, `liveSwitchMessages`; tesztek 43/43.

### 2026-10-23 este – a böngészős dumpfogadás hibája megtalálva

- Tünet: a böngésző nem vette fel a Bulk Dumpot, pedig a MIDI logban minden üzenet megjelent.
- Ok (`midi.js`, `sendAndCollect`): ha a válasz (`stopWhen`) még az utolsó kérés kiküldése előtt jött – az auto-detect
  32 kérésénél a GT-5 már az elsőre válaszol –, a kiküldés utáni `restart` másodszor is lezárta a kérést, így a
  `requestsActive` −1 lett, és a `collectDump` ettől kezdve minden kérés nélkül érkező adatot eldobott. Valószínűleg ez
  volt a korábbi „hosszú dumpnál elakad” jelenség is.
- Javítás: a lezárás csak egyszer fut le, a `collectDump` csak `requestsActive > 0` esetén hallgat. Új szimulátoros eset:
  felismerés utáni TEMP dump (`tools/test_midi.mjs` 9/9).

### 2026-10-24 – paraméterezés SysEx-szel: a hiányzó Sound Change Request

- Előzmény: a `0B 00 bb oo` címre küldött paraméter csak akkor hatott, ha a pedál kijelzőjén épp ugyanaz a paraméter
  volt kiválasztva; különben a pedál figyelmen kívül hagyta, vagy elrontotta az effektutat. A `0A` terület egy
  paraméterrel semmit nem csinált.
- A kézikönyv (`docs/GT-5_OM.pdf`, 60. és 72. o.) csak Bulk Dump/Load-ot és CC 1–31/64–95 realtime vezérlést ír; a bájtszintű
  leírás külön dokumentum.
- Megszerezve: `docs/GT5 Midi implementation.pdf` (VGuitarForums, gumtown, 2019). Címtérképe egyezik a miénkkel
  (pl. OD Level `01 22`, effekt be/ki bitek `00 02–03`). Kulcsmondatok (3. o.):
  - „Bulk data can be received when the Bulk Load Ready function is accessed in Utility mode.”
  - „Individual data can be received at any time, but a packet of [F0…F7] must contain the complete value for one parameter.”
  - „Sound Change Request (SCR) applies only to the temporary area. … you must send data to the SCR address after
    sending the parameter data.”
  - 11. o.: `06 00` (a temp területen belül) = SOUND CHANGE REQUEST, adat 00–7F, „Handled only in the Temporary Area”.
  - A 12. o. régebbi számozással a temp területeket `08`/`09`-nek írja; a 2. o. térképe (`0A` bulk, `0B` individual) a mérvadó.
- A Qt FloorBoard SCR-t sosem küld (a forrásban nincs ilyen) – ezért nem működött rendesen a paraméterezés.
- **Mérés a pedálon** (OD be, Level 43, a kijelzőn nem az OD Level kiválasztva; `tools/param_test.py … scr`):
  - `0A 00 01 22 = 10` + SCR `0A 00 06 00 = 00`: **nincs hatás** (Level 43 marad, nincs módosítás-pont) – a bulk terület
    Bulk Load Ready nélkül nem fogad.
  - `0B 00 01 22 = 10` + SCR `0A 00 06 00 = 00`: **működik** – a hang nagyon halk lett, megjelent a módosítás-pont, a
    pedálon Level 10, az OD bekapcsolva maradt.
- WRITE a pedálon (U1-1-1): a pont eltűnik, a Level 10 tárolódik, a hang megmarad. Újabb küldés (`43` + SCR): hangosabb,
  pont megjelenik. EXIT a pedálon: nem csinál semmit – a pont, a hang és az érték marad, a módosítás mentésre vár.
- Effekt be/ki = egyetlen 4 bájtos paraméter (`00 00`–`00 03`, bájtonként 4 bit: `00nr` `tcdm` `espo` `lacs` –
  NS/RV, TR/CE/DD/MOD, EQ/SP/PRE/OD, LP/WAH/CS/FB). Olvasás `tools/read_temp.py 00 00 4`: `02 00 01 00` = NS és OD be.
- **PRE bekapcsolása SysEx-szel** (`0B 00 00 00 = 02 00 03 00` + SCR, alapállapot OD be / PRE ki): **rossz** – a PRE LED
  nem gyullad ki, PRE nem hallatszik, az OD kiesik a hangból (tiszta hang), pedig az OD LED világít. Visszaolvasva a temp
  `02 00 03 00`, vagyis a bit beíródott. Kétszer mérve: előtte RQ1-gyel és anélkül is ugyanez; egy magában küldött RQ1
  (`0A 00 00 00`, 4 bájt) nem változtat semmit. Nagyobb RQ1 (`01 10`, 32 bájt) válasza hibás (rossz checksum, közbe
  kevert `90 …` bájtok) – a temp nagyobb darabjainak kiolvasása nem megbízható.
  Feltevés: a GT-5 a patch betöltésekor osztja ki a DSP-t a bekapcsolt effekteknek; egy ki→be kapcsolás SysEx-szel ezt
  nem követi (egyezik a korábbi leletekkel: bekapcsolt effekt paramétere kiejti az effektet).
- **OD kikapcsolása SysEx-szel** (`02 00 00 00` + SCR): a pont megjelenik, de az OD LED és hang marad – **nincs hatás**.
  Tehát a be/ki bitek SysEx-szel csak a memóriát írják, a hangot nem (bekapcsolásnál ráadásul elrontják a láncot).
  A be/ki kapcsolás marad az Assign + CC úton.
- **OD Type = Turbo OD** (`0B 00 01 1E = 02` + SCR): **működik** – hallatszik, a kijelzőn Turbo OD, pont megjelenik.
  (SCR nélkül korábban Natural OD-ra esett vissza.)
- **Két paraméter egy SCR-rel** (Type = Blues, Drive = 100, a végén egy SCR; a tárolt Level ekkor 10): a kijelzőn Blues és
  Drive 100, de a hang nem lett torzabb (halk, kevésbé torz vagy tiszta) – a halk Level miatt nem egyértelmű.
- **Egyenként, SCR-rel** (alapállapotból: Level = 60, majd ráküldve Drive = 100): mindkettő **működik** – hangosabb, majd
  torzabb, a kijelzőn Drive 100 / Level 60.
- **Betöltéskor kikapcsolt effekt** (PRE): CC#21 (élő kapcsoló) → PRE be, majd PRE Volume `01 24` = 100, utána = 10, mindkettő
  SCR-rel: **működik** – hangosabb, majd halkabb, OD és PRE bekapcsolva marad, a kijelzőn Volume 10. (SCR nélkül ez
  korábban kiejtette az effektet.)
- CC élő kapcsoló: Assign Hold ON mellett a pedál patchváltás után is emlékszik az utolsó CC-értékre – ugyanaz az érték
  újra nem változás. Ezért kell előbb az ellentétes, majd a kívánt érték (a szerkesztő `liveSwitchMessages` így tesz).
- **Kikapcsolt effekt paramétere** (PRE ki, PRE Volume = 100 + SCR; tárolt 10): a PRE kikapcsolva marad, a hang nem
  változik, a pont megjelenik. Utána CC#21 0→127: a PRE bekapcsol, de **halk, a kijelzőn Volume 10** – a kikapcsolt
  effektnek küldött érték elveszett (vagy a CC-s bekapcsolás a tárolt értékeket tölti vissza – mérendő).
- Ellenőrzés U1-1-2-n (PRE kézzel kikapcsolva, tárolt Volume 20): Volume = 100 + SCR → PRE ki marad, hang változatlan,
  pont megjelenik; PRE kézzel be → kijelzőn 20, és egy ráküldött 20 + SCR nem változtat semmit (tehát a 20 szólt).
  Bekapcsolt PRE-re Volume = 100 + SCR → hangos, torz, kijelzőn 100. PRE kézzel ki, majd be → **a 100 megmarad**
  (hangerő, torzítás, kijelző), a pont is.
- **Szabály:** a kikapcsolt effektnek küldött paramétert a GT-5 eldobja (a pont mégis megjelenik); a bekapcsolt effekt
  módosításai ki-be kapcsolás után is megmaradnak. A szerkesztőnek CC-s bekapcsolás után újra kell küldenie az effekt
  módosított paramétereit.
- **Master Level** (`0B 00 02 2B = 15` + SCR, tárolt 52): **működik** – halkabb, kijelzőn 15, pont megjelenik.
- Következmény: a szerkesztő **minden paraméter után** SCR-t küld (a biztos út); be/ki kapcsolás CC + Assign. Ellenőrizendő: EXIT / WRITE a pedálon, be/ki bitek,
  típusváltás, kikapcsolt effekt paramétere, több paraméter egy SCR-rel.
- **Beépítve (2026-10-24):** `GT5.soundChange` / `withSoundChange`; az `edit()` minden paraméter után SCR-t küld (a lánc után
  is); a régi kerülőutak (`offMessages`, a „bekapcsolt effekt paraméterét nem küldjük” szabály, a CC melletti be/ki bit)
  kikerültek. `state.touched`: a betöltés óta szerkesztett paraméterek; élő kapcsolós bekapcsolás után az effekt ezek
  újra kimennek SCR-rel (`touchedMessages`). Revert / Init / fájl (`sendChanges`): minden üzenet után SCR. Az automatikus
  mentés ki marad (a felhasználó döntése; írni úgyis csak BULK LOAD-on lehet). Tesztek: 44/44, 9/9. Böngészőben próbálandó.

### 2026-10-24 este – böngészős próba, és ami közben kiderült

- System reset után a gyári U1-1-1 („TUBE STACK”: PRE, RV, NS be; OD ki, Level 40; PRE Volume 100).
- Az OD-t a pedálon **kézzel bekapcsolva** (betöltéskor ki volt), a szerkesztőből tekert OD Level: a log szerint minden
  paraméter után SCR ment ki, a pedál kijelzőjén megjelent az érték és a pont, de a **hang nem változott** (Write +
  patchváltás után szólt). Pythonból egyetlen pár (OD Level 70 + SCR): ugyanígy. Ugyanebben az állapotban a betöltéskor
  is bekapcsolt PRE Volume = 30 + SCR: **szintén nem szólt**.
- Patchváltás oda-vissza (friss betöltés, a pedálon semmi nem kapcsolva), PRE Volume = 30 + SCR: **szól** (halkabb, V:30).
- **Szabály:** ha a pedálon kézzel bekapcsolnak egy betöltéskor kikapcsolt effektet, utána az SCR az egész patchre
  hatástalan – az értékek beíródnak, de csak Write + újratöltés után szólnak. (CC-s élő kapcsolóval bekapcsolva nem
  ilyen – délután mérve. Betöltéskor bekapcsolt effekt kézi ki-be kapcsolása sem ilyen – U1-1-2-n mérve.)
- Az USB-MIDI interfész a hosszú délutáni forgalom után beragadt (a TEMP dump nem jött át); kihúzás-visszadugás után a
  100 patches dump rendben átjött.
- Böngészőből (friss betöltés, pedálon semmi nem kapcsolva): PRE Master / Volume tekerése **szól**.
- **PRE Type váltása:** a szerkesztő ◀ ▶ léptetése (08→0C, 3 s alatt, mind SCR-rel) → a hang **elnémul**. Pythonból
  egyetlen váltás (friss betöltés után) `01 23 = 0C` (Metal drive) + SCR → néma; `01 23 = 00` (JC-120) + SCR → néma.
  A kijelzőn a típus és a pont megjelenik. Utána PRE Volume = 100 + SCR: a hang **nem jön vissza**.
  → A PRE típusa élőben nem váltható (az OD Type délután igen). A többi típusválasztó (FX1/CS/WAH select, SP Type,
  FX2 select, RV Type, DD/CE/TP mód) mérendő.
- **RV Type** (U1-1-1, friss betöltés; Plate → Hall2, majd → Room 1, SCR-rel): a kijelzőn a típus és a pont, a hang
  **fehérzaj** lett.
- **OD Type újra** (U1-1-3 „FAT CRUNCH”, OD betöltéskor be, Crunch → Turbo OD + SCR): **néma**, a kijelzőn Turbo OD és
  pont. Délután ugyanez (U1-1-1, az akkor beírt élő kapcsolós Assign-táblával, a mostani system reset előtt) szólt.
  Különbség: (a) a délutáni patchben Assign 1–8 az effektek be/ki kapcsolóira mutatott; (b) a system reset óta más
  rendszerbeállítások (pl. Assign Hold). Délután a CC-vel bekapcsolt PRE paramétere is szólt, a kézzel bekapcsolt OD-é
  most nem – mindkét különbség ugyanarra mutathat.
- A felhasználó a pedálon az U1-1-3 PEDAL/ASSIGN részén **mindent kikapcsolt** (gyárilag EXP be → FV Level, CTL be →
  PHASER On/Off; Assign 1–8 ki), és WRITE-olta. Utána OD Type = Blues + SCR: **szól, rendben**.
  → Gyanú: bekapcsolt EXP / CTL (vagy Assign) mellett a típusváltás élőben elrontja a hangot. Melyik: mérendő.
- Teljes dump (`tools/u113-written.syx`) a gyárival összevetve: 98 patch bájtra azonos; U1-1-3-ban csak az (kikapcsolt)
  Assign 1 mezői mások, U1-1-1-ben néhány OD-érték. Friss betöltés után az U1-1-3 OD Type váltása **néma** – a tárolt
  adat nem magyarázza. A pedál OD menüjében állva: szintén néma.
- **A pedálon a PEDAL LED kikapcsolva** (WRITE nélkül; a temp `00 07` bájtja 03 → 00, vagyis EXP és CTL ki), utána
  OD Type = Turbo OD + SCR: **szól**. A 20:57-es siker előtt is ki volt kapcsolva. (A 21:13 / 21:15-ös sikerek EXP-pel,
  ill. EXP+CTL-lel közvetlenül egy WRITE után jöttek – ez még tisztázandó.)
- SysEx-szel kikapcsolva (`0B 00 00 04 = 00 00 00 00` + SCR): a temp `00 07` bájtja 00 lett (visszaolvasva), de a PEDAL
  LED világít, és utána az OD Type váltás **néma**. Csak a pedálon (PEDAL gomb) kikapcsolt EXP/CTL segít.
- EXIT a pedálon a SysEx-es kikapcsolás után: a LED marad, az OD Type váltás néma. Az EXIT nem számít.
- PEDAL LED a pedálon kikapcsolva (WRITE nélkül), U1-1-3 (tárolt PRE: Clean Twin): PRE Type = JC-120 + SCR – hallhatóan
  alig más (mindkettő tiszta); PRE Type = Metal 5150 + SCR: **szól, torzít**, kijelzőn Metal 5150.
- **Szabály:** a típusváltás (OD, PRE, és valószínűleg RV és a többi) élőben csak akkor szól, ha a pedálon a PEDAL LED
  (EXP/CTL, temp `00 07`) ki van kapcsolva. SysEx-szel kikapcsolva (a bájt 00, de a LED ég) nem elég, az EXIT sem
  számít. Az érték-paraméterek világító PEDAL LED mellett is szólnak.
- Próbált kerülőutak világító PEDAL LED mellett (U1-1-3, OD be, OD Type → Turbo OD): az expression pedál mozgatása nem
  hozza vissza a hangot; SCR `7F` értékkel sem szól; a pedálon tekert típusváltás viszont rendben szól.
- Élő kapcsolók beírva (szerkesztő Write, `00 04`–`07` = `0F 0F 00 03`): **Assign Hold mellett betöltéskor az OD ki
  van kapcsolva** (a megtartott CC#20 = 0 felülírja a patch be/ki bitjét) – a szerkesztőnek kezelnie kell. CC#20 0→127:
  OD be, Crunch szól; utána OD Type = Turbo OD + SCR: **néma**. Az élő kapcsolók tehát nem oldják meg.
- Kikapcsolt OD-nek küldött típus a memóriába íródik; utána CC-vel bekapcsolva az OD néma (Turbo OD a kijelzőn).
- **Csak a CTL kikapcsolva** a pedálon (EXP marad; temp `00 07` = 01), OD be CC-vel, OD Type = Turbo OD + SCR: **szól**.
  → A ludas a **CTL**. Az U1-1-3 CTL-je: target 3B (PHASER On/Off), Min 0, Max 1, **Mode 01 = Toggle**
  (`03 06`–`03 0D`: `3B 00 00 00 00 01 00 01`). Az élő kapcsolós Assign-ok (Normal mód) nem zavarnak.
- CTL Mode = Normal SysEx-szel (`03 0D = 00` + SCR): csak a pont jelenik meg; utána az OD Type váltás néma.
- **CTL Mode = Normal a pedálon** (CTL bekapcsolva marad, WRITE nélkül), OD be CC-vel, OD Type = Turbo OD + SCR: szól
  (kijelzőn Turbo; halkabb, kevésbé torz a Crunch-hoz képest), CC#20 → 0-ra a hang kitisztul – az OD tehát szólt.
  → **A Toggle módú CTL akadályozza az élő típusváltást.**
- Ellenpróba, A rész (CTL Normal a pedálon, OD be CC-vel, OD Type = Turbo OD + SCR): szól, a kijelzőn Turbo OD, de a
  hang **Natural OD** (a lista első típusa). A pedálon a kerékkel el- és visszaváltva valódi Turbo OD szól. Tehát a
  SysEx-es típusváltás Normal CTL mellett sem teljes: a pedál az alapértelmezett típust építi fel (mint SCR nélkül).
- Ugyanígy (CTL Normal), de a pedál kijelzője az OD **Type** soron áll: OD Type = Blues + SCR → a hang **Blues** (helyes),
  a kijelző viszont Turbo-n marad (nem frissül). Kijelző máshol: a kijelző frissül, de Natural OD szól.
- Utána (patchváltás nélkül): Turbo ×2 + SCR → Turbo látszik és szól; Blues ×2 → Blues látszik és szól; Turbo ×1 →
  Turbo látszik és szól. Tehát nem a dupla küldés számít: miután a pedálon egyszer kézzel váltottak típust (és/vagy a
  kijelző a Type soron állt), a SysEx-es típusváltás helyesen működik. Gyanú: betöltés után az első típusváltásnak
  a pedálon kell történnie (vagy a pedál valamilyen belső állapotát „élesíti”).
- Friss betöltés, CC-vel OD be, CTL Normal a pedálon: 1. SysEx-típusváltás (Turbo) → kijelző Turbo, **Natural OD** szól;
  2. SysEx-típusváltás (Blues), kézi beavatkozás nélkül → **Blues látszik és szól**. Betöltés után tehát csak az első
  SysEx-es típusváltás hibás, a többi helyes.
- Ugyanez **gyári Toggle CTL** mellett (friss betöltés, OD be CC-vel): 1. váltás (Turbo) → néma, Turbo látszik;
  2. váltás (Blues) → **Blues látszik és szól**. A CTL módja tehát csak azt dönti el, hogyan hibás az első váltás
  (néma vagy Natural OD); a második mindkét esetben helyes.
- Pontosítás (a felhasználó észrevétele): a sikeres „második váltások” előtt mindig belépett a pedál menüjébe és EXIT-tel
  kilépett. Friss betöltés után két váltás közvetlenül egymás után (menü nélkül): **néma**. A néma állapotban menübe
  lépés: néma marad; EXIT: néma marad; utána egy SysEx-váltás (Blues): **szól**. Tehát egy elrontott első váltás után
  a menüjárás + EXIT „élesít”, a puszta ismétlés nem.
- Friss betöltés, OD be CC-vel, csak EXIT (menü nélkül), 1. váltás: **néma**. Friss betöltés, OD menü + EXIT, 1. váltás:
  **Natural OD** szól (nem néma); utána menü nélkül 2. váltás (Blues): **Blues látszik és szól**.
  → Jelölt recept: patchválasztás után egyszer menü + EXIT a pedálon, és a szerkesztő az első típusváltást kétszer küldi.
- Az élő kapcsolós U1-1-3-ban a PEDAL LED kikapcsolása az Assign 1–8-at is kikapcsolja (`00 04`–`07` = 00), így a CC-vel
  bekapcsolt OD visszaesik a memória szerinti állapotra (ki) – a 22:30 körüli néma eredmények ezért érvénytelenek.
- **Tiszta próba** U1-2-1 „OD1+MS1959” (OD betöltéskor be, Vintage OD, Assign-ok ki, EXP+CTL be, CTL Toggle): PEDAL LED a
  pedálon ki (OD LED ég), friss betöltés után az **első** SysEx-váltás OD Type = Turbo OD + SCR → **Turbo látszik és szól**.
- **Ellenpróba** ugyanott, friss betöltés, PEDAL LED ég: OD Type = Turbo OD + SCR → **néma**, Turbo látszik.
- **Összegzés (tiszta mérések):** típusváltás SysEx + SCR-rel élőben akkor szól helyesen, ha a CTL nem működik (PEDAL LED
  ki, vagy csak a CTL kikapcsolva a pedálon). Toggle CTL mellett néma, Normal CTL mellett Natural OD szól. Az EXP nem
  zavar. SysEx-szel a CTL be/ki bitje és módja csak a memóriában változik, a hatás a pedálon kézzel állítva jön létre.

### Itt tartunk (2026-10-24, 22:40) – holnapi folytatás

- **A szerkesztő mostani állapota:** minden paraméter után SCR (érték-paraméterek: megbízható). A típusváltásokat is élőben
  küldi – működő CTL mellett ezek elnémítják / elrontják a hangot. Még nincs kezelve.
- **Kezelendő az élő kapcsolóknál:** Assign Hold mellett betöltéskor a megtartott CC-értékek felülírják az effektek
  patchbeli be/ki állapotát (U1-1-3: OD ki lett). A PEDAL LED kikapcsolása az élő kapcsolókat is kikapcsolja.
- **Kézi kapcsolás a pedálon:** betöltéskor kikapcsolt effekt kézi bekapcsolása után az SCR hatástalan az egész patchre.
- **Következő mérés:** U1-2-1-ben a pedálon CTL ki + egy Assign (Source = CTL PEDAL, Target = DELAY On/Off, Mode = Toggle,
  bekapcsolva), utána OD Type váltás SysEx + SCR. Ha szól → Write-kor a CTL feladata Assign-ra költözhet (egy élő kapcsoló
  helyére). Utána: RV / FX2 / SP / FX1 / CS / WAH típusválasztók és a lánc-sorrend ugyanígy.
- **A pedál állapota:** system reset után gyári patchek; U1-1-3-ba a szerkesztő beírta az élő kapcsolókat; U1-1-1 OD-értékei
  és U1-1-3 Assign 1-e eltér a gyáritól. Teljes dump 21:21-kor: `tools/u113-written.syx` (U1-1-3 még élő kapcsolók nélkül).
- Eszközök: `tools/param_test.py <0A|0B> <blokk> <offset> <érték | b1,b2,…> [scr]`, `tools/read_temp.py <blokk> <offset> <méret>`
  (a `00` blokk olvasása megbízható, a nagyobb olvasás nem), `tools/cc.py <cc> <érték>`.

### 2026-11-02 – összevetés a GT-3-mal és a GT-5 MIDI Implementationnel

A GT-3 editor közben elkészült (`D:\BOSS_PEDALS\BOSSGT3`, lásd az ottani felderítés „2026-11-01” szakaszát), és a
MIDI-működése több ponton eltér az itt mérttől. Összevetve a `docs/GT5 Midi implementation.pdf`-fel: **a GT-5
feltérképezése helyes, a különbség valódi** – két firmware-generáció (GT-5: 1996, GT-3: 1999, az utód).

**A dokumentum igazolja a GT-5 méréseit:**

| Téma | Dokumentum (GT-5) | GT-5 mérés |
|---|---|---|
| Temp patch | `0A` = bulk, `0B` = individual (write only) | ugyanez; a `0A` egy paraméterrel nem csinál semmit |
| SCR | `06 00`, minden paraméter után kötelező | SCR nélkül nem szól, vele szól |
| Egy üzenet | „egy paraméter teljes értéke” | a névből csak az első betű, a blokkból csak az eleje íródik be |
| Memóriaírás | csak Bulk Load Ready mellett | csak BULK LOAD, EXIT-kor tárol |
| Címek, táblák | OD Type `01 1E`, be/ki bitek, Assign célok (OD Type `15`, PRE Type `1B`, SP Type `25`), CTL Mode | mind egyezik |
| Handshake | „a gép nem használja” | nincs válasz |

A 11–12. oldal régi számozása (`08`/`09`, SCR `08 00 06 00`) a `0A`/`0B`-nek felel meg; a `0A 00 06 00` működik.

**Ahol a GT-3 tényleg másképp működik:**

| Téma | GT-5 | GT-3 |
|---|---|---|
| Élő írás | `0B 00` + SCR | `0C 00`, SCR nélkül |
| Be/ki SysEx-szel | ki: nem hat; be: elrontja a hangot | működik (LED + hang) |
| Típusváltás SysEx-szel | működő CTL mellett néma (Toggle) / Natural OD (Normal) | helyes (Turbo OD → Metal 2) |
| RQ1 | normál módban válaszol, 24 bájt felett hibás (8 bites) | csak BULK módban, mindig az egész patch |
| Kijelző | érték + módosítás-pont | nem követi a SysEx-et |
| Assign + CC, Assign Hold | működik, Hold megtartja az utolsó CC-t | ugyanígy |

Az RQ1 hibás válasza és a be/ki bitek élő viselkedése firmware-sajátosság (a dokumentum csak a formátumot írja le),
nem címzési tévedés. A két editor protokollja nem vehető át egymásból.

**Lyuk az összevetésben:** a GT-3 típusváltását az U35-4-en mértük, ott a CTL be volt kapcsolva (cél DD On/Off),
de **Normal** módban (`08 0B 0E` = `01 01 2F 00 00 00 01 00`) – a GT-5 Normal CTL mellett is hibázott, ez tehát valódi
különbség. **Toggle CTL** mellett a GT-3 nincs kipróbálva (a GT-3 U01-1-ében Toggle CTL van, ott mérhető).

**Amit a GT-3 tapasztalata ad a GT-5-nek:**

1. **Típusváltás Assign + CC-vel** – a GT-3-on hibátlanul, azonnal ment (érték × max / 127, lefelé kerekítve). A GT-5
   élő kapcsolóival csak be/ki-t mértünk. → **Következő GT-5 mérés:** OD Type (`15`) Assign + CC-vel, működő CTL mellett.
2. A hang alapján ítélni, nem a kijelzőről (a GT-3 reggeli „nincs hatás” mérési hiba volt; a GT-5-ös néma / fehérzaj /
   tiszta eredmények hallás alapján születtek, nem érintettek).
3. Közös: Write után programváltás; Assign Hold mellett betöltés után az élő értékeket újra kell küldeni; a pedál WRITE
   gombja a SysEx-es változtatásokat is menti.
