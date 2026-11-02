"""Set the GT-5's temporary patch on/off bytes 00-03 (block 00) to given values, one DT1, and read them back.
    python onbit.py 03 00 02 01
"""
import sys, time, queue
vals = [int(x, 16) for x in sys.argv[1:5]]
sys.argv = ['x']
import gt5_tester as t
mi = t.MidiIn(t.pick(t.input_names(), 'DOREMiDi', 'input')); mo = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))
body = [0x0B, 0, 0, 0] + vals
try:
    mo.send(bytes([0xF0, 0x41, 0, 0, 4, 0x12, *body, t.checksum(body), 0xF7]))
    time.sleep(0.8)
    mo.send(t.rq1(0, [0x0A, 0, 0, 0], 0x18)); s = time.time()
    while time.time() - s < 2:
        mi.poll()
        try: _, k, d = mi.queue.get(timeout=0.02)
        except queue.Empty: continue
        if k == 'sysex' and len(d) == 36:
            print('sent', t.hexs(vals), '| read back', t.hexs(d[10:14])); break
finally:
    mi.close(); mo.close()
