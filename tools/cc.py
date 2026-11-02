"""Send one MIDI CC on channel 1:  python cc.py <number> <value>"""
import sys, time
n, v = int(sys.argv[1]), int(sys.argv[2])
sys.argv = ['x']
import gt5_tester as t
mo = t.MidiOut(t.pick(t.output_names(), 'DOREMiDi', 'output'))
try:
    mo.send(bytes([0xB0, n, v])); print(time.strftime('%H:%M:%S'), f'-> CC#{n} = {v}')
finally:
    mo.close()
