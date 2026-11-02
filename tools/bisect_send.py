"""Send messages [a, b) of a sync list (tools/sync_list.mjs) to the GT-5, and check it
is still alive every few messages: a read of the temporary patch's block 00 (the one
request the GT-5 answers correctly, and it changes nothing). Stops at the first
missing answer and says after which message the GT-5 stopped answering.

    python tools/bisect_send.py <a> <b> [--gap 0.3] [--check 10] [--types] [--list sync_u111.txt]

--types sends the type switches (T lines) first, 1 s apart; a and b count the P lines.
"""
import argparse
import queue
import sys
import time

import gt5_tester as t

p = argparse.ArgumentParser()
p.add_argument('a', type=int)
p.add_argument('b', type=int)
p.add_argument('--gap', type=float, default=0.3)
p.add_argument('--check', type=int, default=10, help='check the GT-5 is alive every N messages (0: never)')
p.add_argument('--types', action='store_true', help='send the type switches first')
p.add_argument('--list', default='sync_u111.txt')
args = p.parse_args()

rows = [l.split(' ', 1) for l in open(args.list, encoding='utf-8').read().splitlines() if l.strip()]
params = [h for k, h in rows if k == 'P'][args.a:args.b]
types = [h for k, h in rows if k == 'T'] if args.types else []

mi = t.MidiIn(t.pick(t.input_names(), 'DOREMiDi', 'input'))
mo = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))


def alive():
    """True when the GT-5 answers a read of its temporary patch's block 00 within 2 s."""
    mi.poll()
    while not mi.queue.empty():
        mi.queue.get()
    mo.send(t.rq1(0, [0x0A, 0, 0, 0], 0x18))
    start = time.time()
    while time.time() - start < 2.0:
        mi.poll()
        try:
            _, kind, data = mi.queue.get(timeout=0.02)
        except queue.Empty:
            continue
        if kind == 'sysex' and len(data) == 36 and data[6] == 0x0A:
            return True
    return False


try:
    if not alive():
        sys.exit('The GT-5 does not answer before anything was sent - switch it off and on, replug the interface.')
    print('GT-5 alive - sending')
    start = time.time()
    sent = 0
    for kind, items, gap in (('type', types, 1.0), ('param', params, args.gap)):
        for k, h in enumerate(items):
            m = bytes.fromhex(h.replace(' ', ''))
            mo.send(m)
            sent += 1
            label = f'{kind} #{k + (args.a if kind == "param" else 0)}  {m[8]:02X} {m[9]:02X} = {" ".join(f"{x:02X}" for x in m[10:-2])}'
            time.sleep(gap)
            if args.check and sent % args.check == 0:
                if not alive():
                    print(f'{time.time() - start:6.1f}s  NO ANSWER after {label} - the GT-5 stopped here (or just before)')
                    sys.exit(1)
                print(f'{time.time() - start:6.1f}s  alive after {label}')
    print(f'{time.time() - start:6.1f}s  done, {sent} messages; alive at the end: {alive()}')
finally:
    mi.close()
    mo.close()
