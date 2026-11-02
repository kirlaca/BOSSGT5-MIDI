"""Read bytes of the GT-5's temporary patch (RQ1 to 0A 00 bb oo).

    python read_temp.py <block hex> <offset hex> <size>
    python read_temp.py 00 00 4      (effect on/off: 4 bytes, 4 bits each)
"""
import sys

import gt5_tester as t

block, offset = (int(x, 16) for x in sys.argv[1:3])
size = int(sys.argv[3])
midi_in = t.MidiIn(t.pick(t.input_names(), 'DOREMiDi', 'input'))
out = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))
try:
    m = t.rq1(0x00, (0x0A, 0x00, block, offset), size)
    out.send(m)
    print('->', t.hexs(m))
    t.collect(midi_in, 2, quiet_after=0.3)
finally:
    out.close()
    midi_in.close()
