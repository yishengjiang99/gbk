# Nova Drift - Glasswing Sunrise (local GBK-project composer; deterministic)
import json, random, sys, mido
V = int(sys.argv[1]) if len(sys.argv) > 1 else 1
random.seed(26102026)
PPQ=480; BAR=PPQ*4; BPM=76; BARS=52
def T(bar, beat=0.0): return int((bar-1)*BAR + beat*PPQ)
tracks=[]; notes=[]; ccs=[]; programs=[]; nid=[0]
def track(name, ch, prog, vol, pan, rev, cho=0, role="harmony"):
    tid=f"trk_nd26_{len(tracks)}"
    tracks.append({"id":tid,"name":name,"channel":ch,"color":"#7e57c2","visible":True,
        "mix":{"volume":vol,"pan":pan,"expression":127,"mute":False,"solo":False},"role":role})
    if ch!=9: programs.append({"id":f"pg_{len(programs)}","trackId":tid,"channel":ch,"tick":0,"program":prog,"bankMsb":0,"bankLsb":0})
    for c,v in ((7,vol),(10,pan),(91,rev),(93,cho)): cc(tid,ch,c,0,v)
    return (tid,ch)
def cc(tid,ch,c,tick,v):
    ccs.append({"id":f"cc_{len(ccs)}","trackId":tid,"channel":ch,"controller":c,"tick":int(tick),"value":int(max(0,min(127,v)))})
def note(tr,tick,dur,p,vel):
    nid[0]+=1; notes.append({"id":f"n_{nid[0]}","trackId":tr[0],"channel":tr[1],"tick":int(tick),"duration":int(dur),"pitch":int(p),"velocity":int(max(1,min(127,vel)))})
def ramp(tr,c,b0,b1,v0,v1,step=0.5):
    n=int((b1-b0)*4/step)
    for i in range(n+1):
        x=i/n; s=x*x*(3-2*x); cc(tr[0],tr[1],c,T(b0)+i*step*PPQ,v0+(v1-v0)*s)

# Eb major. Chords as (root midi bass, pad voicing)
Eb,Cm,Ab,Bb,Fm,Gm = 39,36,44,46,41,43
PROG_A=[("Ebmaj9",Eb,[55,58,62,65,70]),("Cm9",Cm,[55,58,62,63,67]),("Abmaj7#11",Ab,[56,60,62,63,67]),("Bbsus4",Bb,[53,58,63,65,70])]
PROG_C=[("Abmaj9",Ab,[55,58,60,63,67]),("Fm9",Fm,[56,60,63,65,67]),("Cm7",Cm,[55,58,60,63,67]),("Gm7/Bb",Bb,[53,58,62,65,70])]
def chord(bar):
    prog = PROG_C if 29<=bar<=40 else PROG_A
    return prog[(bar-1)%4]

pad   = track("Warm Pad",0,89,96,40,118,60)
halo  = track("Halo Pad",1,94,84,88,122,80)
arp   = track("Saw Arp",2,81,70,76,96,40,"accompaniment")
echo  = track("Arp Echo",3,81,52,40,110,40,"accompaniment")
bass  = track("Synth Bass",4,38,92,64,30,0,"bass")
lead  = track("Glass Lead",5,98 if V>=2 else 81,80,58,112,50,"melody")
drums = track("Drums",9,0,78,64,50,0,"percussion")

# --- pads: whole-bar sustained, slight overlap ---
for b in range(1,BARS+1):
    name,root,voi=chord(b)
    for p in voi: note(pad,T(b),BAR+60,p,(66 if V>=2 else 58) if b<13 else (72 if V>=2 and b>=41 else 64))
    if b>=5 and not (b>=49):  # halo high octave shimmer
        for p in (voi[1]+12,voi[3]+12): note(halo,T(b),BAR+60,p,50)
    if b>=49:
        for p in (voi[1]+12,voi[3]+12): note(halo,T(b),BAR+60,p,44)
# pad expression: swell in, dip in Glasswing, fade out
ramp(pad,11,1,12,64 if V>=2 else 30,110); ramp(pad,11,49,53,110,0 if V<3 else 30,1)
ramp(halo,11,5,13,0,95); ramp(halo,11,29,33,95,70); ramp(halo,11,41,44,70,105); ramp(halo,11,49,53,105,0 if V<3 else 35,1)

if V>=3:
    vox = track("Voice Pad",6,91,90,64,124,70)
    for b in range(41,53):
        name,root,voi=chord(b)
        for p in (voi[0]+12,voi[2]+12,voi[4]): note(vox,T(b),BAR+60,p,70)
    ramp(vox,11,41,43,30,115); ramp(vox,11,49,53,115,30,1)
# --- arpeggio: 16ths, up-down over chord tones, with dotted-8th echo track ---
def arp_bar(b, vel, dense=True):
    name,root,voi=chord(b)
    tones=sorted(set([voi[0]+12,voi[1]+12,voi[2]+12,voi[3]+12,voi[4]+12 if V>=2 else voi[0]+24]))
    pat=tones+tones[-2:0:-1]
    step=0.25 if dense else 0.5
    n=int(4/step)
    for i in range(n):
        p=pat[i%len(pat)]
        acc = 1.0 if i%4==0 else 0.8
        note(arp,T(b,i*step),step*PPQ*0.8,p,vel*acc)
        if V>=2: note(echo,T(b,i*step+0.75),step*PPQ*0.7,p,vel*acc*0.55)
for b in range(9,13): arp_bar(b,40+(b-9)*5,dense=False)
for b in range(13,29): arp_bar(b,72)
for b in range(29,41): arp_bar(b,52, dense=(V<2 or b>=37))
for b in range(41,53): arp_bar(b,(84 if V>=2 else 78) if b<49 else 78-(b-48)*12)
if V>=2:
    ramp(arp,11,9,13,40,110); ramp(arp,11,49,53,110,10,1)
    ramp(echo,11,9,13,40,110); ramp(echo,11,49,53,110,10,1)

# --- bass: 8ths synthwave pulse in Glide/Sunrise, long notes elsewhere ---
for b in range(1,BARS+1):
    name,root,voi=chord(b)
    if b<9: continue
    if 13<=b<=28 or 41<=b<=50:
        for i in range(8):
            p = root+12 if (V>=2 and i in (3,7)) else root
            note(bass,T(b,i*0.5),PPQ*0.42,p,(88 if i%2==0 else 70))
    else:
        note(bass,T(b),BAR-40,root,70)
ramp(bass,11,49,53,120,0,1) if V>=2 else None

# --- drums (GM): kick 36, snare 38/clap 39, closed hat 42, open hat 46, crash 49 ---
def drum_bar(b, full=True):
    for beat in (0,2): note(drums,T(b,beat),120,36,96)
    if V>=2 and b%2==0: note(drums,T(b,3.5),120,36,70)
    for beat in (1,3): note(drums,T(b,beat),120,38 if not V>=2 else 39,84); 
    if V>=2:
        for beat in (1,3): note(drums,T(b,beat),120,38,60)
    for i in range(8): note(drums,T(b,i*0.5),60,42,(58 if i%2 else 40) if full else 34)
    if V>=2 and b%4==0: note(drums,T(b,3.5),200,46,52)
for b in range(13,29): drum_bar(b, full=b>=17)
for b in range(41,51): drum_bar(b)
note(drums,T(13),900,49,78); note(drums,T(41),900,49,88)
if V>=2:
    # soft riser hat on the bar before each drop
    for i in range(8): note(drums,T(12,2+i*0.25),40,42,20+i*6)
    for i in range(8): note(drums,T(40,2+i*0.25),40,42,20+i*6)
ramp(drums,11,49,51,120,40,1)

# --- lead melody (Eb major pentatonic-ish, motif + answer), bars 21-28 and 41-48 (+ intro bells v2) ---
motif=[(0,1.5,70),(1.5,0.5,67),(2,2,65)]          # Bb G F
answer=[(0,1,63),(1,1,65),(2,1,67),(3,1,70)]      # Eb F G Bb
lift=[(0,1.5,72),(1.5,0.5,70),(2,2,74)]           # C Bb D (lydian lift)
home=[(0,3,70),(3,1,67)]
phrase=[motif,answer,lift,home]
def melody(b0, vel, octave=0):
    for k in range(8):
        frag=phrase[k%4] if k<4 else [(o,d,p+(2 if (k==6 and p==74) else 0)) for o,d,p in phrase[k%4]]
        for o,d,p in frag: note(lead,T(b0+k,o),d*PPQ*0.95,p+octave,vel+random.randint(-6,6))
melody(21,70); melody(41,82,12 if V>=2 else 0)
if V>=2:
    # sparse glass bells over First Light
    for b,o,p in ((3,0,82),(4,2,79),(5,0,77),(7,0,82),(8,2,84),(9,0,86),(11,1,82)):
        note(lead,T(b,o),PPQ*2,p,46)
    # glasswing: answered fragment, high and quiet
    for k,b in enumerate((31,33,35,37)):
        for o,d,p in phrase[k%4]: note(lead,T(b,o),d*PPQ,p+12,48)
    ramp(lead,11,49,53,120,20,1)

endTick=T(BARS+1)
proj={"schemaVersion":1,"id":"prj_nd26_glasswing","revision":V,"name":"Glasswing Sunrise","ppq":PPQ,"format":1,
 "tracks":tracks,"notes":sorted(notes,key=lambda n:(n["tick"],n["pitch"])),"ccs":sorted(ccs,key=lambda c:c["tick"]),"pitchBends":[],"channelPressure":[],"polyPressure":[],
 "programs":programs,"tempos":[{"tick":0,"microPerQuarter":round(60_000_000/BPM)}],"timeSigs":[{"tick":0,"numerator":4,"denominator":4}],
 "raw":[],"endTick":endTick,"selection":{"trackIds":[],"startTick":0,"endTick":0,"noteIds":[]},"loop":{"enabled":False,"startTick":0,"endTick":0},
 "meta":{"key":"Eb major","style":"ambient","sections":[{"name":"First Light","startBar":1,"bars":12,"energy":0.2},{"name":"Glide","startBar":13,"bars":16,"energy":0.65},{"name":"Glasswing","startBar":29,"bars":12,"energy":0.4},{"name":"Sunrise","startBar":41,"bars":12,"energy":0.85}]}}
json.dump(proj,open(f"project_v{V}.json","w"))
# MIDI
mf=mido.MidiFile(ticks_per_beat=PPQ); t0=mido.MidiTrack(); mf.tracks.append(t0)
t0.append(mido.MetaMessage("set_tempo",tempo=round(60_000_000/BPM))); t0.append(mido.MetaMessage("time_signature",numerator=4,denominator=4))
t0.append(mido.MetaMessage("key_signature",key="Eb")); t0.append(mido.MetaMessage("track_name",name="Glasswing Sunrise"))
for tr in tracks:
    ev=[]; tid,ch=tr["id"],tr["channel"]
    for p in programs:
        if p["trackId"]==tid: ev.append((0,0,mido.Message("program_change",channel=ch,program=p["program"])))
    for c in ccs:
        if c["trackId"]==tid: ev.append((c["tick"],1,mido.Message("control_change",channel=ch,control=c["controller"],value=c["value"])))
    for n in notes:
        if n["trackId"]==tid:
            ev.append((n["tick"],3,mido.Message("note_on",channel=ch,note=n["pitch"],velocity=n["velocity"])))
            ev.append((n["tick"]+n["duration"],2,mido.Message("note_off",channel=ch,note=n["pitch"],velocity=0)))
    ev.sort(key=lambda e:(e[0],e[1])); mt=mido.MidiTrack(); mt.append(mido.MetaMessage("track_name",name=tr["name"])); last=0
    for t,_,m in ev: mt.append(m.copy(time=t-last)); last=t
    mf.tracks.append(mt)
mf.save(f"glasswing_v{V}.mid")
print("notes",len(notes),"ccs",len(ccs),"bars",BARS,"sec",BARS*4*60/BPM)
