# Satellite Lullaby — Nova Drift. C# minor, 84 BPM, 4/4, 56 bars.
import mido, random, sys
V = sys.argv[1] if len(sys.argv) > 1 else "v1"
BPM, PPQ = 84, 480; BAR = 4*PPQ; NB = 56
rnd = random.Random(1103)
def T(bar, beat=0.0): return int((bar-1)*BAR + beat*PPQ)

# chords: (bass root midi, pad voicing, arp tones)
C = {
 "C#m9":  (37, [56,59,63,64,68], [61,64,68,71,75]),
 "Amaj9": (33, [56,59,61,64,68], [57,61,64,68,71]),
 "Emaj7": (40, [56,59,63,64,68], [64,68,71,75,76]),
 "Badd9": (35, [54,59,61,63,66], [59,63,66,71,73]),
 "F#m9":  (42, [57,61,64,66,68], [54,57,61,64,68]),
 "Dmaj7#11":(38,[57,61,62,66,68],[62,66,69,73,68]),
 "G#7sus":(44, [54,56,61,63,66], [56,61,63,66,68]),
 "G#7":   (44, [54,56,60,63,66], [56,60,63,66,68]),
}
A = ["C#m9","Amaj9","Emaj7","Badd9"]
D = ["Amaj9","F#m9","Dmaj7#11","G#7sus"]
def chord(b):
    if 29 <= b <= 40:
        if b == 40: return "G#7"
        return D[(b-29) % 4]
    if b == 56: return "C#m9"
    return A[(b-1) % 4]

tracks = {}  # name -> (ch, prog, events)
def track(name, ch, prog, vol, pan, rev, cho=0, bank=0):
    ev = []
    if bank: ev.append((0, mido.Message("control_change", channel=ch, control=0, value=bank)))
    ev += [(0, mido.Message("program_change", channel=ch, program=prog)),
           (0, mido.Message("control_change", channel=ch, control=7, value=vol)),
           (0, mido.Message("control_change", channel=ch, control=10, value=pan)),
           (0, mido.Message("control_change", channel=ch, control=91, value=rev)),
           (0, mido.Message("control_change", channel=ch, control=93, value=cho))]
    tracks[name] = (ch, ev)
def note(name, tick, dur, p, vel, hum=0):
    ch, ev = tracks[name]
    if hum: tick = max(0, tick + rnd.randint(-hum, hum)); vel += rnd.randint(-4, 4)
    vel = max(1, min(127, int(vel)))
    ev.append((tick, mido.Message("note_on", channel=ch, note=p, velocity=vel)))
    ev.append((tick+max(10, dur), mido.Message("note_off", channel=ch, note=p, velocity=0)))
def ramp(name, b0, b1, v0, v1, cc=11, step=0.25):
    ch, ev = tracks[name]; n = int((b1-b0)/step)
    for i in range(n+1):
        t = b0 + i*step; v = v0 + (v1-v0)*i/max(1, n)
        ev.append((T(1)+int((t-1)*BAR), mido.Message("control_change", channel=ch, control=cc, value=int(max(0, min(127, v))))))

track("Pad",       0, 89, 100, 40, 90, 40)    # warm pad
track("SpaceVoice",1, 91, 84, 92, 110, 30)   # space voice
track("Arp",       2, 80, 76, 50, 70, 20)    # square lead arp
track("Echo",      3, 80, 58, 96, 100, 0)    # dotted-8th echo of the arp
track("Bass",      4, 38, 76, 64, 20, 0)     # synth bass
track("MusicBox",  5, 10, 88, 76, 100, 0)    # lullaby bells
track("Lead",      6, 82, 86, 58, 80, 30)    # calliope lead
track("Drums",     9, 25, 84, 64, 40, 0)     # TR-808 kit

# --- pads
for b in range(1, NB+1):
    root, pad, arp = C[chord(b)]
    pv = 72 if b <= 12 else (60 + 3*min(b-29, 6) - 2*max(0, b-35) if 29 <= b <= 40 else 66)
    for i,p in enumerate(pad): note("Pad", T(b), BAR-20, p+(12 if i>=3 else 0), pv)
    if b >= 29 or b <= 12: 
        for p in pad[1:4]: note("SpaceVoice", T(b), BAR-20, p+12, 60)
        if b >= 41: note("SpaceVoice", T(b), BAR-20, pad[-1]+12, 52)
# pad expression arc: swell in, hold, Dark Side dip, Earthrise, fade to floor
ramp("Pad", 1, 13, 88, 112); ramp("Pad", 13, 29, 100, 112); ramp("Pad", 29, 35, 92, 108); ramp("Pad", 35, 41, 108, 96)
ramp("Pad", 41, 51, 120, 124); ramp("Pad", 51, 57, 124, 60)
ramp("SpaceVoice", 1, 13, 50, 90); ramp("SpaceVoice", 29, 35, 50, 110); ramp("SpaceVoice", 35, 41, 110, 80); ramp("SpaceVoice", 41, 51, 110, 120); ramp("SpaceVoice", 51, 57, 120, 55)

# --- arp
def arp_bar(b, vel, sub):
    _, _, tones = C[chord(b)]
    pat = [0,1,2,3,4,3,2,1] if sub == 8 else [0,2,1,3,2,4,3,1,0,2,4,3,2,1,3,4]
    step = BAR//len(pat) if sub == 16 else BAR//8
    pat = pat if sub == 16 else pat[:8]
    for i, k in enumerate(pat):
        acc = 1.0 if i % 4 == 0 else 0.82
        note("Arp", T(b)+i*step, int(step*0.7), tones[k], vel*acc, hum=6)
        note("Echo", T(b)+i*step+int(PPQ*0.75), int(step*0.6), tones[k], vel*acc*0.7)
for b in range(9, 13): arp_bar(b, 54+(b-9)*5, 8)
for b in range(13, 29): arp_bar(b, 70 if b < 21 else 82, 16)
for b in range(29, 41): arp_bar(b, 60, 8)
for b in range(41, 56): arp_bar(b, 92, 16)
ramp("Arp", 51, 56, 110, 50); ramp("Echo", 51, 57, 110, 40)

# --- bass: octave pulse 8ths, Dark Side long tones
for b in range(13, NB+1):
    root = C[chord(b)][0]
    if 29 <= b <= 40 or b == 56:
        note("Bass", T(b), BAR-60, root, 84); continue
    for i in range(8):
        p = root + (12 if i in (3, 7) else 0)
        note("Bass", T(b, i*0.5), PPQ//2-40, p, 92 if i % 2 == 0 else 76, hum=4)
ramp("Bass", 51, 56, 110, 60)

# --- lullaby motif (music box), written over the 4-chord loop
MOTIF = [  # (bar offset, beat, dur beats, pitch)
 (0,0,1,68),(0,1,1,71),(0,2,2,73),
 (1,0,1.5,73),(1,1.5,.5,71),(1,2,2,68),
 (2,0,1,71),(2,1,1,68),(2,2,1,66),(2,3,1,64),
 (3,0,3,66),(3,3,1,63)]
MOTIF2 = [
 (0,0,1,68),(0,1,1,71),(0,2,1,73),(0,3,1,75),
 (1,0,2,76),(1,2,1,73),(1,3,1,71),
 (2,0,1.5,71),(2,1.5,.5,68),(2,2,2,64),
 (3,0,2,66),(3,2,1,68),(3,3,1,63)]
DARK = [  # Dark Side, over A F#m D G#
 (0,0,2,73),(0,2,2,68),(1,0,1,69),(1,1,1,68),(1,2,2,66),
 (2,0,3,69),(2,3,1,68),(3,0,4,68)]
def play(name, b0, m, vel, octv=0, hum=8):
    for bo, bt, d, p in m:
        note(name, T(b0+bo, bt), int(d*PPQ*0.95), p+octv, vel, hum=hum)
play("MusicBox", 5, MOTIF, 66, 12); play("MusicBox", 9, MOTIF2, 72, 12)
play("MusicBox", 29, DARK, 74, 12); play("MusicBox", 33, DARK, 70, 12); play("MusicBox", 37, DARK[:5], 66, 12)
# lead (calliope) carries the motif in Low Orbit and an octave up in Earthrise
play("Lead", 21, MOTIF, 84); play("Lead", 25, MOTIF2, 88)
play("Lead", 41, MOTIF, 90, 12); play("Lead", 45, MOTIF2, 94, 12); play("Lead", 49, MOTIF, 88, 12)
play("MusicBox", 49, MOTIF, 64, 12); play("MusicBox", 53, MOTIF2[:8], 56, 12)
ramp("Lead", 21, 29, 100, 100); ramp("Lead", 41, 49, 124, 124); ramp("Lead", 49, 55, 124, 76)

# --- drums (808): hats in Low Orbit, kick/snare from bar 17; Dark Side heartbeat; Earthrise full
K, S, CL, CH, OH = 36, 38, 39, 42, 46
def drum_bar(b, full=True, vel=1.0):
    for i in range(16):
        if i % 2 == 0 or full: note("Drums", T(b)+i*BAR//16, 60, CH, (70 if i % 4 == 2 else 52)*vel, hum=5)
    if not full: return
    for t in (0, 2.5): note("Drums", T(b, t), 120, K, 84*vel)
    for t in (1, 3): note("Drums", T(b, t), 120, S, 90*vel); note("Drums", T(b, t), 120, CL, 70*vel)
    note("Drums", T(b, 3.5), 120, OH, 50*vel)
for b in range(13, 17): drum_bar(b, full=False, vel=0.6+0.1*(b-13))
for b in range(17, 29): drum_bar(b)
for b in range(29, 40): note("Drums", T(b), 200, K, 50); note("Drums", T(b, 0.75), 200, K, 36)
for i in range(16): note("Drums", T(40)+i*BAR//16, 60, CH, 30+i*4)   # riser into Earthrise
for b in range(41, 56): drum_bar(b, vel=1.0 if b < 52 else 1.0-(b-51)*0.15)
for cb in (41, 49): note("Drums", T(cb), 600, 49, 90)  # crashes on Earthrise

mf = mido.MidiFile(ticks_per_beat=PPQ)
meta = mido.MidiTrack(); mf.tracks.append(meta)
meta += [mido.MetaMessage("track_name", name="Satellite Lullaby", time=0), mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(BPM), time=0),
         mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0), mido.MetaMessage("key_signature", key="C#m", time=0)]
for name, (ch, ev) in tracks.items():
    tr = mido.MidiTrack(); tr.append(mido.MetaMessage("track_name", name=name, time=0))
    ev.sort(key=lambda e: (e[0], 0 if e[1].type == "note_off" else 1)); last = 0
    for t, m in ev: tr.append(m.copy(time=t-last)); last = t
    mf.tracks.append(tr)
mf.save(f"{V}.mid"); print("saved", V, mf.length)
