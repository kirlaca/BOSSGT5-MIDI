'use strict';

// Web MIDI access for the GT-5 editor - the browser-side replacement for
// midiIO.cpp (RtMidi). Taken over from the ME-5 editor (D:\BOSSME5\webmidi\midi.js)
// and adapted to the GT-5: 32 device IDs, 23-message patches, paced sends.
//
// SysEx needs explicit permission: requestMIDIAccess({ sysex: true }) makes the
// browser ask the user once. Supported in Chrome/Edge/Opera (desktop and
// Android) and in Firefox; not in Safari / iOS.

const Midi = (() => {
  const DEFAULT_TIMEOUT_MS = 300;
  // midiIO.cpp sleeps 5 ms after every message. Web MIDI queues sends, so the
  // gap is scheduled with timestamps instead: the time the bytes take on the
  // 31250 baud wire (320 us per byte) plus that pause.
  const WIRE_MS_PER_BYTE = 0.32;
  const GAP_MS = 5;
  const BULK_GAP_MS = 80;  // with the wire time, about the GT-5's own bulk dump pace
  // Pause after the GT-5 answered, before the next request. Asked straight after
  // its answer, a real GT-5 sent nothing more and stayed on "DATA SENDING..." -
  // it seems to need a moment to come back. Not tuned yet: may be shorter.
  const REQUEST_PAUSE_MS = 600;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  let access = null;

  // A log of what went out and came in, for the connection dialog (the GT-5 is
  // slow and old - when something doesn't work, this shows what really happened).
  const LOG_SIZE = 5000;  // a full bulk dump is ~1500 messages
  const log = [];
  const logListeners = new Set();
  let logTimer = null;
  function addLog(dir, bytes, port = '') {
    const hex = GT5.hexBytes(bytes.slice(0, 40)) + (bytes.length > 40 ? ` … (${bytes.length} bytes)` : '');
    const t = new Date().toTimeString().slice(0, 8);
    log.push(`${t} ${dir} ${hex}${port ? `  [${port}]` : ''}`);
    if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
    // Redrawn at most 5 times a second: a dump brings thousands of lines.
    if (!logTimer) logTimer = setTimeout(() => { logTimer = null; for (const fn of logListeners) fn(); }, 200);
  }
  const onLog = fn => logListeners.add(fn);
  const logText = (last = log.length) => log.slice(-last).join('\n');

  async function init() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('This browser has no Web MIDI - use Chrome or Edge (Safari and iOS do not support it).');
    }
    if (!access) {
      try {
        access = await navigator.requestMIDIAccess({ sysex: true });
        monitorInputs();
      } catch (e) {
        throw new Error(`MIDI access denied (${e.name}). Allow "MIDI devices" / SysEx for this page in the site settings.`);
      }
    }
    return access;
  }

  const outputs = () => [...access.outputs.values()];
  const inputs = () => [...access.inputs.values()];
  const byName = (ports, name) => ports.find(p => p.name === name);

  // Called with no arguments when ports come and go (interface plugged in or out).
  function onPortsChanged(handler) {
    if (access) {
      access.onstatechange = e => {
        if (e.port?.type === 'input') addLog('·', [], `${e.port.name}: ${e.port.state}, ${e.port.connection}`);
        monitorInputs();
        handler();
      };
    }
  }

  // Every input is watched from the start, so the log shows anything that comes
  // in - also a program change from a GT-5 footswitch, which proves the
  // GT-5 MIDI OUT -> interface IN cable works. Clock (F8) and active sensing
  // (FE) are only counted, they would flood the log.
  const monitored = new WeakSet();
  let realtime = 0;

  // SysEx that comes in while no request waits for it - a Bulk Dump started on
  // the GT-5 itself. Handed to the listeners in one piece once it stops coming.
  let requestsActive = 0;
  // The GT-5 pauses about a second between the parts of a dump (system, lists,
  // patches), so the dump counts as over only after a longer silence.
  const DUMP_END_MS = 3000;
  const unsolicited = { bytes: [], timer: null };
  const dumpListeners = new Set();
  const onDump = fn => dumpListeners.add(fn);
  const dumpProgressListeners = new Set();
  const onDumpProgress = fn => dumpProgressListeners.add(fn);
  function collectDump(data) {
    if (requestsActive > 0) return;
    for (const b of data) unsolicited.bytes.push(b);
    for (const fn of dumpProgressListeners) fn(unsolicited.bytes.length);
    clearTimeout(unsolicited.timer);
    unsolicited.timer = setTimeout(() => {
      const bytes = Uint8Array.from(unsolicited.bytes);
      unsolicited.bytes = [];
      for (const fn of dumpListeners) fn(bytes);
    }, DUMP_END_MS);
  }
  function monitorInputs() {
    for (const inp of access.inputs.values()) {
      if (monitored.has(inp)) {
        // Back after a replug or a sleep: the port may have closed meanwhile.
        if (inp.state === 'connected' && inp.connection !== 'open') openInput(inp);
        continue;
      }
      monitored.add(inp);
      // onmidimessage opens the port by itself and keeps it open; requests add their own listeners next to it.
      inp.onmidimessage = e => {
        if (e.data[0] === 0xF8 || e.data[0] === 0xFE) {
          if (realtime++ === 0) addLog('←', e.data, `${inp.name} - clock / active sensing, shown once`);
          return;
        }
        addLog('←', e.data, inp.name);
        if (e.data[0] === 0xF0 || e.data[0] < 0x80) collectDump(e.data);
      };
      openInput(inp);
    }
  }

  function openInput(inp) {
    inp.open().then(
      () => addLog('·', [], `listening on ${inp.name} (${inp.state}, ${inp.connection})`),
      e => addLog('!', [], `${inp.name} - could not open: ${e.name} - is another program or browser tab using it?`),
    );
  }

  function findPorts({ output, input }) {
    const out = byName(outputs(), output);
    if (!out) throw new Error(`output port not found: ${output}`);
    const inp = input ? byName(inputs(), input) : null;
    if (input && !inp) throw new Error(`input port not found: ${input}`);
    return { out, inp };
  }

  // Send messages one after the other with the GT-5's breathing gap between them.
  // Resolves when the last one should be on the wire.
  function sendPaced(out, messages, gapMs = GAP_MS) {
    let t = performance.now();
    for (const m of messages) {
      out.send(m, t);
      addLog('→', m, out.name);
      t += m.length * WIRE_MS_PER_BYTE + gapMs;
    }
    return new Promise(resolve => setTimeout(resolve, Math.max(0, t - performance.now())));
  }

  // Fire-and-forget send (program change, live edits, patch writes). gapMs: the
  // pause after each message - bigger for the GT-5's slow bulk load and for runs
  // of live changes it has to work through.
  function send(outputName, messages, { gapMs = GAP_MS } = {}) {
    const { out } = findPorts({ output: outputName });
    return sendPaced(out, messages instanceof Uint8Array ? [messages] : messages, gapMs);
  }

  // Send `messages` to `out` and collect the SysEx that arrives on `ins` until
  // nothing new has come for timeoutMs (the wait restarts on every reply), or
  // until stopWhen(bytesSoFar) says enough. Before the first reply the wait is
  // firstTimeoutMs: the GT-5 takes its time to start answering (midiIO.cpp waits
  // up to 2 s for a patch). Channel messages and realtime bytes are dropped.
  async function sendAndCollect(out, ins, messages, { timeoutMs = DEFAULT_TIMEOUT_MS, firstTimeoutMs = timeoutMs, stopWhen } = {}) {
    await out.open();
    // An input another program holds open can't be opened on Windows - listen on the rest.
    const opened = await Promise.allSettled(ins.map(i => i.open()));
    ins = ins.filter((_, k) => opened[k].status === 'fulfilled');
    if (!ins.length) throw new Error('could not open any MIDI input - is another program using it?');
    const received = new Map(ins.map(i => [i, []]));
    requestsActive++;
    return new Promise(resolve => {
      let timer;
      let done = false;
      // Only once: a reply can end it (stopWhen) before the last request is out,
      // and the restart after sending would finish it again - requestsActive went
      // to -1 and every bulk dump after it was dropped.
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        requestsActive--;
        for (const i of ins) i.removeEventListener('midimessage', handlers.get(i));
        resolve(received);
      };
      let replied = false;
      const restart = () => {
        if (done) return;
        clearTimeout(timer);
        timer = setTimeout(finish, replied ? timeoutMs : firstTimeoutMs);
      };
      // Web MIDI hands over whole SysEx messages; a long one may still come in
      // pieces on some systems, so continuation bytes (< 0x80) are kept too.
      const handlers = new Map(ins.map(i => [i, e => {
        const first = e.data[0];
        if (first !== 0xF0 && first >= 0x80) return;
        const bytes = received.get(i);
        for (const b of e.data) bytes.push(b);
        replied = true;
        if (stopWhen && stopWhen(bytes)) finish(); else restart();
      }]));
      for (const i of ins) i.addEventListener('midimessage', handlers.get(i));
      sendPaced(out, messages).then(restart);
      restart();
    });
  }

  async function request(conn, messages, options) {
    const { out, inp } = findPorts(conn);
    if (!inp) throw new Error('no input port selected - SysEx replies need one');
    return (await sendAndCollect(out, [inp], [].concat(messages), options)).get(inp);
  }

  // Find the port pair and device ID the GT-5 answers on. It only answers SysEx
  // addressed to its own device ID, so the identity request goes out with all
  // 32, and the reply's device ID says which one it is.
  // Listens on every input at once: one wait per output, not per output x input pair.
  async function detectGt5() {
    const requests = Array.from({ length: GT5.DEVICE_IDS }, (_, dev) => GT5.identityRequest(dev));
    for (const out of outputs()) {
      let replies;
      try {
        replies = await sendAndCollect(out, inputs(), requests, {
          firstTimeoutMs: 1500,
          stopWhen: b => GT5.replyDevice(b) !== null,
        });
      } catch {
        continue; // port busy (e.g. held by another program) or vanished
      }
      for (const [inp, bytes] of replies) {
        const dev = GT5.replyDevice(bytes);
        if (dev !== null) return { output: out.name, input: inp.name, dev };
      }
    }
    return null;
  }

  // The complete GT-5 DT1 messages in `bytes`.
  const dt1s = bytes => GT5.splitSysex(bytes).filter(GT5.isGt5Dt1);

  // One patch (null = the temporary patch) -> GT5.decodePatch result.
  // Asks up to 3 times, like midiIO.cpp, when the reply doesn't come complete.
  async function readPatch(conn, n = null) {
    // Block by block (GT5.blockRequests), one answer awaited before the next ask,
    // so a GT-5 that doesn't answer gets exactly one request and no more.
    const messages = [];
    for (const req of GT5.blockRequests(conn.dev, n)) {
      if (messages.length) await pause(REQUEST_PAUSE_MS);
      const bytes = await request(conn, req, {
        firstTimeoutMs: 2500,
        timeoutMs: 400,
        stopWhen: b => b[b.length - 1] === 0xF7 && dt1s(b).length >= 1,
      });
      const got = dt1s(bytes);
      if (!got.length) {
        const e = new Error(`no patch data came back from the GT-5 (block ${GT5.hex(req[8])} offset ${GT5.hex(req[9])}, ${bytes.length} bytes) - see the MIDI log in the connection dialog`);
        e.noReply = true;  // stop asking: a GT-5 that misses one request may be stuck
        throw e;
      }
      messages.push(...got);
    }
    const result = GT5.decodePatch(messages);
    if (result.missing.length) throw new Error(`the GT-5 did not send blocks ${result.missing.map(GT5.hex).join(' ')} (${messages.length} messages came)`);
    return result;
  }

  // The raw system-area dump (all DT1 messages the GT-5 sends back).
  async function readSystem(conn) {
    // Piece by piece (GT5.systemRequests): the FloorBoard's one big request would
    // most likely hang the GT-5 like its patch request does.
    const messages = [];
    for (const req of GT5.systemRequests(conn.dev)) {
      if (messages.length) await pause(REQUEST_PAUSE_MS);
      const bytes = await request(conn, req, {
        firstTimeoutMs: 2500,
        timeoutMs: 400,
        stopWhen: b => b[b.length - 1] === 0xF7 && dt1s(b).length >= 1,
      });
      const got = dt1s(bytes);
      if (!got.length) {
        throw new Error(`the GT-5 sent no system data for ${GT5.hexBytes(req.slice(6, 10))} (${messages.length} pieces came before)`);
      }
      messages.push(...got);
    }
    return messages;
  }

  // Store a patch into user memory n (0-99).
  // The GT-5 has to be on its BULK LOAD page ("waiting") to take it, and stores it
  // when that page is left with EXIT. Paced like its own bulk dump (~90 ms a message).
  function writePatch(conn, patch, n) {
    if (!GT5.isUser(n)) throw new Error(`${GT5.patchLabel(n)} is a preset - only user patches can be written`);
    return send(conn.output, GT5.encodePatch(patch, { to: n, dev: conn.dev }), { gapMs: BULK_GAP_MS });
  }

  const selectPatch = (conn, n, channel = 0) => send(conn.output, GT5.programChange(n, channel));

  return {
    init, outputs, inputs, onPortsChanged, send, detectGt5, onLog, logText, onDump, onDumpProgress,
    readPatch, readSystem, writePatch, selectPatch,
  };
})();
