"""Send one parameter to the GT-5's temporary patch - to compare its two temp areas.

    python param_test.py <area 0A|0B> <block hex> <offset hex> <value> [scr]
    python param_test.py 0B 01 22 10 scr   (OD Level = 10 through the individual temp area, then SCR)
    python param_test.py 0B 00 00 02,00,03,00 scr   (effect on/off, all 4 bytes in one packet)

0B 00 = "Temporary Buffer (Individual)", what the editor uses; 0A 00 = "Temporary Buffer
(Bulk)" (midi.xml). With "scr" a Sound Change Request (0A 00 06 00 = 00) follows the
parameter: the GT-5 MIDI Implementation says bulk temp data takes effect only after it.
Nothing here writes to the patch memory.
"""
import sys
import time

import gt5_tester as t


def dt1(body):
    return bytes([0xF0, 0x41, 0x00, 0x00, 0x04, 0x12, *body, t.checksum(body), 0xF7])


area, block, offset = (int(x, 16) for x in sys.argv[1:4])
# One value, or several bytes of one multi-byte parameter: 02,00,03,00 (hex when comma-separated).
values = [int(v, 16) for v in sys.argv[4].split(',')] if ',' in sys.argv[4] else [int(sys.argv[4])]
msgs = [dt1([area, 0x00, block, offset, *values])]
if 'scr' in sys.argv[5:]:
    msgs.append(dt1([0x0A, 0x00, 0x06, 0x00, 0x00]))
out = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))
try:
    for m in msgs:
        out.send(m)
        print(time.strftime('%H:%M:%S'), '->', t.hexs(m))
        time.sleep(0.03)
finally:
    out.close()
