"""GT-5 MIDI tester - talks to the GT-5 without the browser (Web MIDI), straight
through the Windows MIDI API (winmm.dll, like RtMidi in the Qt FloorBoard).
No packages to install: plain Python 3 on Windows.

Built step by step:
    1. ports, connect      - list the MIDI ports; identity request, show the reply
    2. (next) patch change
    3. (next) SysEx data: requests and bulk dumps

    python tools/gt5_tester.py ports
    python tools/gt5_tester.py connect --in DOREMiDi --out DOREMiDi --dev 1

--in / --out take a port number (from "ports") or part of its name.
--dev is the GT-5's device ID as its display shows it (1-32).
"""

import argparse
import ctypes
import queue
import sys
import time
from ctypes import wintypes

winmm = ctypes.WinDLL('winmm')

# Consoles with an old code page can't print → ← …: show a stand-in instead of stopping.
sys.stdout.reconfigure(errors='replace')

# ---------------------------------------------------------------- winmm declarations

MAXPNAMELEN = 32
CALLBACK_FUNCTION = 0x00030000
MIM_OPEN, MIM_CLOSE, MIM_DATA, MIM_LONGDATA, MIM_ERROR, MIM_LONGERROR = 0x3C1, 0x3C2, 0x3C3, 0x3C4, 0x3C5, 0x3C6
MIM_MOREDATA = 0x3CC
MHDR_DONE = 0x00000001


class MIDIINCAPSW(ctypes.Structure):
    _fields_ = [('wMid', wintypes.WORD), ('wPid', wintypes.WORD), ('vDriverVersion', wintypes.UINT),
                ('szPname', wintypes.WCHAR * MAXPNAMELEN), ('dwSupport', wintypes.DWORD)]


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [('wMid', wintypes.WORD), ('wPid', wintypes.WORD), ('vDriverVersion', wintypes.UINT),
                ('szPname', wintypes.WCHAR * MAXPNAMELEN), ('wTechnology', wintypes.WORD),
                ('wVoices', wintypes.WORD), ('wNotes', wintypes.WORD), ('wChannelMask', wintypes.WORD),
                ('dwSupport', wintypes.DWORD)]


class MIDIHDR(ctypes.Structure):
    pass


MIDIHDR._fields_ = [('lpData', ctypes.c_void_p), ('dwBufferLength', wintypes.DWORD),
                    ('dwBytesRecorded', wintypes.DWORD), ('dwUser', ctypes.c_size_t),
                    ('dwFlags', wintypes.DWORD), ('lpNext', ctypes.POINTER(MIDIHDR)),
                    ('reserved', ctypes.c_size_t), ('dwOffset', wintypes.DWORD),
                    ('dwReserved', ctypes.c_size_t * 8)]

MIDIINPROC = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, wintypes.UINT, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_size_t)

HMIDI = ctypes.c_void_p


def check(result, what):
    if result != 0:
        text = ctypes.create_unicode_buffer(256)
        winmm.midiInGetErrorTextW(result, text, 256)
        raise RuntimeError(f'{what} failed: error {result} ({text.value})')


def input_names():
    names = []
    for i in range(winmm.midiInGetNumDevs()):
        caps = MIDIINCAPSW()
        check(winmm.midiInGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)), 'midiInGetDevCaps')
        names.append(caps.szPname)
    return names


def output_names():
    names = []
    for i in range(winmm.midiOutGetNumDevs()):
        caps = MIDIOUTCAPSW()
        check(winmm.midiOutGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)), 'midiOutGetDevCaps')
        names.append(caps.szPname)
    return names


def pick(names, wanted, kind):
    """A port by number or by part of its name."""
    if wanted is None:
        if len(names) == 1:
            return 0
        sys.exit(f'more than one MIDI {kind} port - choose one with --{kind[:3]} (see "ports")')
    if wanted.isdigit():
        n = int(wanted)
        if n < len(names):
            return n
        sys.exit(f'no MIDI {kind} port {n}')
    hits = [i for i, name in enumerate(names) if wanted.lower() in name.lower()]
    if len(hits) != 1:
        sys.exit(f'{len(hits)} MIDI {kind} ports match "{wanted}": {names}')
    return hits[0]


# ---------------------------------------------------------------- MIDI in / out

class MidiIn:
    """An input port. Everything that arrives is queued as (time, kind, bytes):
    kind 'short' (channel messages), 'sysex' (one buffer of SysEx), or an error kind."""

    BUFFERS = 32       # SysEx buffers kept with the driver; plenty for a fast bulk dump
    BUFFER_SIZE = 4096

    def __init__(self, port):
        self.queue = queue.Queue()
        self.events = queue.Queue()   # raw callback events, handled on the main thread
        self.handle = HMIDI()
        self.callback = MIDIINPROC(self._callback)  # kept referenced while open
        check(winmm.midiInOpen(ctypes.byref(self.handle), port, self.callback, 0, CALLBACK_FUNCTION), 'midiInOpen')
        self.headers = []
        for _ in range(self.BUFFERS):
            buf = ctypes.create_string_buffer(self.BUFFER_SIZE)
            hdr = MIDIHDR()
            hdr.lpData = ctypes.cast(buf, ctypes.c_void_p)
            hdr.dwBufferLength = self.BUFFER_SIZE
            check(winmm.midiInPrepareHeader(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr)), 'midiInPrepareHeader')
            check(winmm.midiInAddBuffer(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr)), 'midiInAddBuffer')
            self.headers.append((buf, hdr))
        self.by_address = {ctypes.addressof(hdr): (buf, hdr) for buf, hdr in self.headers}
        self.closing = False
        check(winmm.midiInStart(self.handle), 'midiInStart')

    def _callback(self, handle, msg, instance, param1, param2):
        # Runs on a winmm thread: only hand over, no MIDI calls here (the docs forbid them).
        self.events.put((time.time(), msg, param1))

    def poll(self):
        """Turn the raw callback events into queue items; give SysEx buffers back to the driver."""
        while True:
            try:
                t, msg, param1 = self.events.get_nowait()
            except queue.Empty:
                return
            if msg in (MIM_DATA, MIM_MOREDATA, MIM_ERROR):
                status = param1 & 0xFF
                length = 1 if status >= 0xF8 else 2 if (status & 0xF0) in (0xC0, 0xD0) or status in (0xF1, 0xF3) else 3
                data = bytes([(param1 >> (8 * i)) & 0xFF for i in range(length)])
                self.queue.put((t, 'short' if msg != MIM_ERROR else 'BAD SHORT', data))
            elif msg in (MIM_LONGDATA, MIM_LONGERROR):
                buf, hdr = self.by_address[param1]
                data = bytes(buf.raw[:hdr.dwBytesRecorded])
                if data:
                    self.queue.put((t, 'sysex' if msg == MIM_LONGDATA else 'BAD SYSEX', data))
                if not self.closing:
                    winmm.midiInAddBuffer(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr))

    def close(self):
        self.closing = True
        winmm.midiInStop(self.handle)
        winmm.midiInReset(self.handle)   # hands every buffer back
        time.sleep(0.05)
        self.poll()
        for _, hdr in self.headers:
            winmm.midiInUnprepareHeader(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr))
        winmm.midiInClose(self.handle)


class MidiOut:
    def __init__(self, port):
        self.handle = HMIDI()
        check(winmm.midiOutOpen(ctypes.byref(self.handle), port, 0, 0, 0), 'midiOutOpen')

    def send(self, data):
        data = bytes(data)
        if data[0] == 0xF0:
            buf = ctypes.create_string_buffer(data, len(data))
            hdr = MIDIHDR()
            hdr.lpData = ctypes.cast(buf, ctypes.c_void_p)
            hdr.dwBufferLength = len(data)
            check(winmm.midiOutPrepareHeader(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr)), 'midiOutPrepareHeader')
            check(winmm.midiOutLongMsg(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr)), 'midiOutLongMsg')
            while not hdr.dwFlags & MHDR_DONE:
                time.sleep(0.001)
            winmm.midiOutUnprepareHeader(self.handle, ctypes.byref(hdr), ctypes.sizeof(hdr))
        else:
            word = 0
            for i, b in enumerate(data[:3]):
                word |= b << (8 * i)
            check(winmm.midiOutShortMsg(self.handle, word), 'midiOutShortMsg')

    def close(self):
        winmm.midiOutReset(self.handle)
        winmm.midiOutClose(self.handle)


# ---------------------------------------------------------------- GT-5 messages

ROLAND, MODEL = 0x41, (0x00, 0x04)
RQ1, DT1 = 0x11, 0x12


def checksum(body):
    return (128 - sum(body) % 128) % 128


def rq1(dev, address, size):
    body = list(address) + [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F]
    return bytes([0xF0, ROLAND, dev, *MODEL, RQ1, *body, checksum(body), 0xF7])


def hexs(data):
    return ' '.join(f'{b:02X}' for b in data)


def describe(kind, data):
    """One received item as a line; SysEx from a GT-5 gets its address and a checksum check."""
    line = f'{kind:9} {hexs(data[:48])}{f" … ({len(data)} bytes)" if len(data) > 48 else ""}'
    if kind == 'sysex' and len(data) >= 12 and data[1] == ROLAND and tuple(data[3:5]) == MODEL:
        cmd = {RQ1: 'RQ1', DT1: 'DT1'}.get(data[5], f'cmd {data[5]:02X}')
        body = data[6:-2]
        ok = checksum(body) == data[-2] and data[-1] == 0xF7
        bad = [i for i, b in enumerate(data[1:-1], 1) if b >= 0x80]
        line += (f'\n          GT-5 {cmd} dev {data[2] + 1} address {hexs(data[6:10])}, {len(data) - 12} data bytes, '
                 f'checksum {"ok" if ok else "WRONG"}' + (f', bytes >= 80 inside at {bad[:8]}' if bad else ''))
    return line


def collect(midi_in, seconds, quiet_after=None):
    """Print what arrives for `seconds` (or until nothing has come for quiet_after seconds)."""
    start = time.time()
    last = start
    count = 0
    while time.time() - start < seconds:
        midi_in.poll()
        try:
            t, kind, data = midi_in.queue.get(timeout=0.02)
        except queue.Empty:
            if quiet_after and count and time.time() - last > quiet_after:
                break
            continue
        count += 1
        last = t
        print(f'{t - start:7.3f}s ← {describe(kind, data)}')
    return count


# ---------------------------------------------------------------- commands

def cmd_ports(args):
    print('MIDI inputs (from the GT-5):')
    for i, name in enumerate(input_names()):
        print(f'  {i}: {name}')
    print('MIDI outputs (to the GT-5):')
    for i, name in enumerate(output_names()):
        print(f'  {i}: {name}')


def open_ports(args):
    i = pick(input_names(), args.inp, 'input')
    o = pick(output_names(), args.out, 'output')
    print(f'in:  {i}: {input_names()[i]}\nout: {o}: {output_names()[o]}')
    return MidiIn(i), MidiOut(o)


def cmd_listen(args):
    """Only listen: proves the input works (switch patches on the GT-5 - it sends a program change)."""
    i = pick(input_names(), args.inp, 'input')
    print(f'in: {i}: {input_names()[i]} - listening for {args.seconds:g} s, Ctrl+C stops')
    midi_in = MidiIn(i)
    try:
        n = collect(midi_in, args.seconds)
        print(f'\n{n} message(s).')
    except KeyboardInterrupt:
        print('\nstopped')
    finally:
        midi_in.close()


def cmd_receive(args):
    """Step 3: take in a Bulk Dump started on the GT-5 and save it; report what came and whether it broke off."""
    i = pick(input_names(), args.inp, 'input')
    print(f'in: {i}: {input_names()[i]} - start the BULK DUMP on the GT-5 now '
          f'(ends {args.quiet:g} s after the last byte, at most {args.seconds:g} s)')
    midi_in = MidiIn(i)
    raw = bytearray()
    messages = []
    problems = []
    start = time.time()
    first = last = None
    try:
        while time.time() - start < args.seconds:
            midi_in.poll()
            try:
                t, kind, data = midi_in.queue.get(timeout=0.02)
            except queue.Empty:
                if last and time.time() - last > args.quiet:
                    break
                continue
            first = first or t
            last = t
            if kind == 'sysex':
                raw += data
                messages.append(data)
                if len(messages) % 50 == 0:
                    print(f'  {t - first:6.1f}s  {len(messages)} messages, {len(raw) / 1024:.1f} kB')
            elif kind not in ('short',) or data[0] < 0xF8:
                problems.append((t - (first or t), kind, data))
    except KeyboardInterrupt:
        print('stopped')
    finally:
        midi_in.close()
    if not messages:
        print('Nothing came.')
        return
    print(f'\n{len(messages)} SysEx messages, {len(raw)} bytes in {last - first:.1f} s')
    areas = {}
    bad_checksums = 0
    for m in messages:
        if len(m) >= 12 and m[0] == 0xF0 and m[-1] == 0xF7 and m[1] == ROLAND and tuple(m[3:5]) == MODEL:
            areas.setdefault(m[6], set()).add(m[7])
            if checksum(m[6:-2]) != m[-2]:
                bad_checksums += 1
        else:
            problems.append((0, 'not a whole GT-5 message', m[:16]))
    for a in sorted(areas):
        print(f'  area {a:02X}: {len(areas[a])} sub-addresses' + (f' (patches 0-{max(areas[a])})' if a >= 7 else ''))
    print(f'  checksums wrong: {bad_checksums}')
    if problems:
        print(f'  other / broken items: {len(problems)} - first ones:')
        for t, kind, data in problems[:10]:
            print(f'    {kind} {hexs(data[:24])}')
    with open(args.file, 'wb') as f:
        f.write(raw)
    print(f'saved: {args.file}')


RQD, DAT, ACK, EOD, ERR, RJC = 0x41, 0x42, 0x43, 0x45, 0x4E, 0x4F
HANDSHAKE = {0x40: 'WSD', RQD: 'RQD', DAT: 'DAT', ACK: 'ACK', EOD: 'EOD', ERR: 'ERR', RJC: 'RJC'}


def cmd_handshake(args):
    """Roland handshake transfer: RQD asks for data, the unit answers with DAT packets and waits
    for an ACK after each, EOD ends it. Older Roland units dump this way on request - whether the
    GT-5 does is what this finds out."""
    dev = args.dev - 1
    address = [int(x, 16) for x in args.address.split()]
    size = args.size
    body = address + [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F]
    msg = bytes([0xF0, ROLAND, dev, *MODEL, RQD, *body, checksum(body), 0xF7])
    ack = bytes([0xF0, ROLAND, dev, *MODEL, ACK, 0xF7])
    midi_in, midi_out = open_ports(args)
    start = time.time()
    try:
        print(f'\n-> RQD {args.address}, {size} bytes: {hexs(msg)}')
        midi_out.send(msg)
        last = time.time()
        packets = 0
        while time.time() - last < args.wait:
            midi_in.poll()
            try:
                t, kind, data = midi_in.queue.get(timeout=0.02)
            except queue.Empty:
                continue
            last = t
            print(f'{t - start:7.3f}s <- {describe(kind, data)}')
            if kind == 'sysex' and len(data) >= 7 and data[1] == ROLAND and tuple(data[3:5]) == MODEL:
                cmd = data[5]
                print(f'          handshake: {HANDSHAKE.get(cmd, f"cmd {cmd:02X}")}')
                if cmd == DAT:
                    packets += 1
                    if packets >= args.max_packets:
                        print('          (max packets reached - stopping without ACK)')
                        break
                    midi_out.send(ack)
                    print(f'          -> ACK {hexs(ack)}')
                elif cmd in (EOD, ERR, RJC):
                    if cmd == EOD:
                        midi_out.send(ack)
                        print(f'          -> ACK (end) {hexs(ack)}')
                    break
        print(f'\n{packets} DAT packet(s).')
    finally:
        midi_in.close()
        midi_out.close()


def cmd_connect(args):
    """Step 1: the FloorBoard's identity request - read 1 byte at 00 00 00 00 (the tuner pitch).
    --ask patch reads the first block of U1-1-1 instead (24 bytes at 07 00 00 00), which a real
    GT-5 answered in the browser."""
    dev = args.dev - 1
    midi_in, midi_out = open_ports(args)
    try:
        if args.ask == 'patch':
            msg = rq1(dev, [0x07, 0x00, 0x00, 0x00], 0x18)
            print(f'\n→ U1-1-1 block 00 request, device ID {args.dev}: {hexs(msg)}')
        else:
            msg = rq1(dev, [0, 0, 0, 0], 1)
            print(f'\n→ identity request, device ID {args.dev}: {hexs(msg)}')
        midi_out.send(msg)
        n = collect(midi_in, args.wait, quiet_after=0.5)
        if not n:
            print(f'\nNo answer in {args.wait} s. Check the device ID (GT-5: UTILITY → MIDI), the cables, '
                  'and that no other program (browser tab, FloorBoard) has the ports open.')
        else:
            print(f'\n{n} message(s) came back. A "GT-5 DT1 … address 00 00 00 00, 1 data bytes, checksum ok" '
                  'line means the GT-5 answers: data byte 05 = tuner 440 Hz.')
    finally:
        midi_in.close()
        midi_out.close()


def main():
    parser = argparse.ArgumentParser(description='GT-5 MIDI tester (Windows, no browser).')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('ports', help='list the MIDI ports').set_defaults(func=cmd_ports)
    p = sub.add_parser('connect', help='step 1: identity request, show the reply')
    p.add_argument('--in', dest='inp', help='input port: number or part of the name')
    p.add_argument('--out', help='output port: number or part of the name')
    p.add_argument('--dev', type=int, default=1, choices=range(1, 33), metavar='1-32',
                   help="the GT-5's device ID, as on its display (default 1)")
    p.add_argument('--wait', type=float, default=3.0, help='seconds to wait for the answer (default 3)')
    p.add_argument('--ask', choices=['id', 'patch'], default='id',
                   help='id: 1 byte at 00 00 00 00 (default); patch: block 00 of U1-1-1')
    p.set_defaults(func=cmd_connect)
    p = sub.add_parser('listen', help='show everything that comes in')
    p.add_argument('--in', dest='inp', help='input port: number or part of the name')
    p.add_argument('--seconds', type=float, default=30.0, help='how long (default 30)')
    p.set_defaults(func=cmd_listen)
    p = sub.add_parser('receive', help='step 3: take in a Bulk Dump from the GT-5 and save it')
    p.add_argument('--in', dest='inp', help='input port: number or part of the name')
    p.add_argument('--file', default='gt5-bulk-dump.syx', help='where to save it (default gt5-bulk-dump.syx)')
    p.add_argument('--seconds', type=float, default=300.0, help='wait at most this long (default 300)')
    p.add_argument('--quiet', type=float, default=5.0, help='done after this many seconds without data (default 5)')
    p.set_defaults(func=cmd_receive)
    p = sub.add_parser('handshake', help='try the Roland handshake transfer (RQD -> DAT / ACK)')
    p.add_argument('--in', dest='inp', help='input port: number or part of the name')
    p.add_argument('--out', help='output port: number or part of the name')
    p.add_argument('--dev', type=int, default=1, choices=range(1, 33), metavar='1-32')
    p.add_argument('--address', default='07 00 00 00', help='4 hex bytes (default: U1-1-1 block 00)')
    p.add_argument('--size', type=int, default=24, help='bytes to ask for (default 24)')
    p.add_argument('--wait', type=float, default=3.0, help='seconds of silence that end it (default 3)')
    p.add_argument('--max-packets', type=int, default=20, help='stop after this many DAT packets (default 20)')
    p.set_defaults(func=cmd_handshake)
    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
