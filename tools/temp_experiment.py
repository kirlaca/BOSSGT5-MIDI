"""What does the GT-5's temporary patch take in? Sends a known patch into it one
way or another, then compares with a TEMP bulk dump taken afterwards.

    python tools/temp_experiment.py send --method block0B   (or block0A, param0B)
    (on the GT-5: BULK DUMP -> TEMP, received with: gt5_tester.py receive --file temp.syx)
    python tools/temp_experiment.py compare temp.syx

The patch sent is U1-1-1 from gt5-bulk-dump.syx with the name "TEMP TEST".
Nothing here writes to the patch memory.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gt5_tester as t  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.path.join(BASE, 'gt5-bulk-dump.syx')
NAME = b'TEMP TEST  '
BLOCK_NAMES = {0: 'on/off + chain', 1: 'effects', 2: 'effects 2', 3: 'EXP/CTL/assign', 4: 'assign 8', 5: 'name'}


def messages(path):
    raw = open(path, 'rb').read()
    out, s = [], 0
    while s < len(raw):
        e = raw.index(0xF7, s)
        out.append(raw[s:e + 1])
        s = e + 1
    return out


def patch_blocks(msgs, a1, a2):
    """{block: data bytes} of the patch at address a1 a2."""
    return {m[8]: bytes(m[10:-2]) for m in msgs if len(m) > 12 and m[6] == a1 and m[7] == a2}


def expected():
    blocks = dict(patch_blocks(messages(DUMP), 0x07, 0x00))
    blocks[5] = NAME + blocks[5][len(NAME):]
    return blocks


def dt1(address, data):
    body = list(address) + list(data)
    return bytes([0xF0, 0x41, 0, 0, 4, 0x12, *body, t.checksum(body), 0xF7])


def cmd_send(args):
    blocks = expected()
    if args.method == 'sync':
        # From tools/sync_list.mjs: types first, each followed by a longer pause.
        lines = [l.split(' ', 1) for l in open(args.list, encoding='utf-8').read().splitlines() if l.strip()]
        out = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))
        try:
            start = time.time()
            for k, (kind, hexs) in enumerate(lines):
                out.send(bytes.fromhex(hexs.replace(' ', '')))
                time.sleep(args.type_gap if kind == 'T' else args.gap)
                if k % 25 == 0:
                    print(f'  {time.time() - start:5.1f}s  {k}/{len(lines)}')
            print(f'sync: {len(lines)} messages sent in {time.time() - start:.1f} s')
        finally:
            out.close()
        return
    if args.method == 'param0B':
        msgs = [dt1([0x0B, 0, b, k], [v]) for b, data in sorted(blocks.items()) for k, v in enumerate(data)]
    else:
        area = 0x0B if args.method == 'block0B' else 0x0A
        msgs = [dt1([area, 0, b, 0], data) for b, data in sorted(blocks.items())]
    out = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))
    try:
        start = time.time()
        for m in msgs:
            out.send(m)
            time.sleep(args.gap)
        print(f'{args.method}: {len(msgs)} messages sent in {time.time() - start:.1f} s')
    finally:
        out.close()


def cmd_compare(args):
    got_msgs = messages(args.file)
    got = patch_blocks(got_msgs, 0x0A, 0x00)
    if not got:
        sys.exit('no temp patch (0A 00) in that file')
    want = expected()
    # What the pedal held before (U4-5-5, AUTO RING): only bytes that differ from it prove anything.
    base = patch_blocks(messages(DUMP), 0x07, 0x63)
    total_same = total = proof = proof_took = 0
    for b in sorted(want):
        w, g, o = want[b], got.get(b, b''), base.get(b, b'')
        same = [k for k in range(len(w)) if k < len(g) and g[k] == w[k]]
        diff = [k for k in range(len(w)) if not (k < len(g) and g[k] == w[k])]
        telling = [k for k in range(len(w)) if k < len(o) and o[k] != w[k]]
        took = [k for k in telling if k in same]
        total_same += len(same)
        total += len(w)
        proof += len(telling)
        proof_took += len(took)
        print(f'block {b:02X} ({BLOCK_NAMES[b]}): {len(same)}/{len(w)} bytes as sent, '
              f'{len(took)}/{len(telling)} of those that differ from AUTO RING'
              + (f'; not as sent at {", ".join(f"{k:02X}" for k in diff[:16])}{" …" if len(diff) > 16 else ""}' if diff else ''))
    print(f'name in the temp patch: {got.get(5, b"")[:11].decode("ascii", "replace")!r}')
    print(f'total: {total_same}/{total} bytes as sent; {proof_took}/{proof} of the telling ones')


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('send')
    s.add_argument('--method', choices=['block0B', 'block0A', 'param0B', 'sync'], required=True)
    s.add_argument('--gap', type=float, default=0.09, help='seconds between messages (default 0.09)')
    s.add_argument('--type-gap', type=float, default=1.0, help='sync: seconds after a type switch (default 1)')
    s.add_argument('--list', default='sync_u111.txt', help='sync: the list from sync_list.mjs')
    s.set_defaults(func=cmd_send)
    c = sub.add_parser('compare')
    c.add_argument('file')
    c.set_defaults(func=cmd_compare)
    args = p.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
