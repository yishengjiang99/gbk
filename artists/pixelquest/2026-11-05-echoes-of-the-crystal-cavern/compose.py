import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;E=240;S16=120;BAR=1920;BPM=112;SLUG="echoes_of_the_crystal_cavern"
tr={k:[] for k in("lead","arp","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(d),pitch=p,velocity=max(1,min(127,int(v)))))
# A Dorian: A B C D E F# G — Am Bm C D Em F#dim G
Am=(33,[57,60,64,69]);Bm=(35,[59,62,66,71]);C=(36,[60,64,67,72]);D=(38,[62,66,69,74])
Em=(40,[64,67,71,76]);G=(43,[55,59,62,67]);Fsm=(42,[54,57,61,66])
# Melodies in eighths; pitch 0 = rest. Glassy, mysterious, crystalline leaps.
# A motif: A5-C6-B5-E5 | F#5-A5-G5-E5 | D6-C6-B5-A5 | G5-F#5-E5 (hold) — Dorian F# flash
INTRO=[
  [(0,4),(81,2),(0,2)],                 # high A5 peek
  [(0,2),(76,2),(78,2),(0,2)],           # E5 F#5
  [(81,2),(83,2),(81,2),(78,2)],         # A5 B5 A5 F#5
  [(76,4),(0,2),(74,2)],                 # E5 ... D5
]
MA=[
  [(81,2),(84,2),(83,2),(76,2)],         # A5 C6 B5 E5
  [(78,2),(81,2),(79,2),(76,2)],         # F#5 A5 G5 E5
  [(86,2),(84,2),(83,2),(81,2)],         # D6 C6 B5 A5
  [(79,2),(78,2),(76,4)],               # G5 F#5 E5
  [(81,2),(83,1),(84,1),(86,2),(84,2)], # A5 B5 C6 D6 C6
  [(83,2),(81,2),(78,2),(76,2)],         # B5 A5 F#5 E5
  [(74,2),(76,2),(78,2),(81,2)],         # D5 E5 F#5 A5
  [(79,4),(78,2),(76,2)],               # G5 F#5 E5 — lands for Am
]
MA2=MA[:6]+[
  [(86,2),(88,2),(86,2),(83,2)],         # D6 E6 D6 B5 climb
  [(81,4),(0,2),(78,2)],                 # A5 rest F#5 — open end into B
]
MB=[
  [(84,3),(83,1),(81,2),(79,2)],         # C6 B5 A5 G5
  [(78,2),(81,2),(86,3),(84,1)],         # F#5 A5 D6 C6  (Dorian bright)
  [(83,2),(81,2),(78,2),(76,2)],         # B5 A5 F#5 E5
  [(74,2),(78,2),(81,4)],               # D5 F#5 A5
  [(88,2),(86,2),(84,2),(83,2)],         # E6 D6 C6 B5
  [(81,2),(83,2),(84,2),(86,2)],         # A5 B5 C6 D6
  [(88,3),(86,1),(84,2),(81,2)],         # E6 D6 C6 A5
  [(83,4),(78,2),(76,2)],               # B5 F#5 E5 — pull to whisper
]
# Whisper: quieter, sparse long tones — icicles dripping
MW=[
  [(81,6),(0,2)],
  [(78,4),(76,4)],
  [(84,6),(0,2)],
  [(83,4),(81,4)],
  [(86,4),(84,2),(83,2)],
  [(81,6),(0,2)],
  [(78,2),(76,2),(74,2),(78,2)],
  [(76,4),(0,2),(74,2)],                 # soft landing toward Am (A loop)
]
CI=[Am,Em,Am,D];CA=[Am,Bm,C,D,Am,Em,D,Am];CA2=CA[:6]+[G,D];CB=[C,D,Bm,Em,C,D,G,Em];CW=[Am,Em,C,G,D,Am,Bm,Em]
form=[("Intro",INTRO,CI,0.4),("A",MA,CA,0.7),("A2",MA2,CA2,0.75),("B",MB,CB,0.9),("Whisper",MW,CW,0.45),("A loop",MA,CA,0.8)]
bar=0;sections=[]
for name,mel,ch,en in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=en))
  intro=name=="Intro";whisper=name=="Whisper"
  for i,(root,tones) in enumerate(ch):
    t0=bar*BAR;t=t0;last=i==len(ch)-1
    for p,l in mel[i]:
      if p:
        acc=(t-t0)%960==0
        base=(96 if acc else 84)+(10 if name=="B" else 0)-(16 if whisper else 0)-(12 if intro else 0)+(2 if V>=2 and name in("A","A2","A loop") else 0)
        # slightly longer glassy sustain on longer notes
        dur=l*E*(0.78 if l==1 else 0.92)
        add("lead",t,dur,p,base)
      t+=l*E
    # sparkling 16th arps high register — softer in intro/whisper
    # pattern: up through chord + octave shimmer
    hi=[x+12 for x in tones]
    pat=[0,1,2,3,2,1,2,3]
    for s in range(16):
      if intro and (i<2 or s%2): continue
      if whisper and (s%4 if V<2 else s%2): continue  # sparse; v2 denser 8ths
      v=(48 if s%4==0 else 34)-(12 if intro else 0)-(16 if whisper else 0)+(6 if V>=2 and name=="B" else 0)+(4 if name in("A2","B") else 0)
      # v2: quieter arp under whisper, brighter in B
      if V>=2 and whisper: v=max(18,v-8)
      if V>=2 and name=="B": v=min(60,v+4)
      add("arp",t0+s*S16,S16*0.5,hi[pat[s%8]],v)
    # soft triangle-ish bass: half notes / dotted feel, not driving 8ths
    if whisper:
      add("bass",t0,BAR*0.9,root,70 if V<2 else 62)
    elif intro:
      add("bass",t0,BAR*0.7,root,78-(8 if i<2 else 0))
      if i>=2: add("bass",t0+2*Q,BAR*0.35,root+7,70)
    else:
      # root on 1, fifth or octave on 3; gentle 8th fill on offbeats in B/A2
      bv=(96 if V<2 else 90)+(8 if name=="B" else 0)
      add("bass",t0,Q*1.6,root,bv)
      add("bass",t0+2*Q,Q*1.5,root+(12 if i%2==0 else 7),(86 if V<2 else 82)+(6 if name=="B" else 0))
      if V>=2 and name in("A2","B") and not last:
        add("bass",t0+3*Q+E,E*0.7,root+12,72)
      # seam fix: hold root through end of A / A loop last bar so loop into A isn't empty
      if V>=2 and last and name in("A","A loop"):
        add("bass",t0+3*Q,Q*0.95,root,78)
        for s in range(12,16):
          add("drums",t0+s*S16,40,42,26)
    # sparse noise percussion: soft hats, occasional tom rolls — NOT a boss battle
    if intro:
      for b in range(4):
        if i>=1: add("drums",t0+b*Q,60,42,28+i*4)  # soft closed hat
      if last:
        for s,p in zip(range(8,16),(47,45,47,45,43,41,38,38)):
          add("drums",t0+s*S16,80,p,36+s*2)
    elif whisper:
      add("drums",t0,100,36,50 if V<2 else 42)  # soft kick on 1
      for b in (1,3): add("drums",t0+b*Q,50,42,22)
      if last:
        for s,p in zip(range(12,16),(47,45,43,41)):
          add("drums",t0+s*S16,70,p,30+s)
    else:
      # soft kick 1 & 3, light snare on 2 & 4, soft 8th hats
      for tk in (0,2*Q): add("drums",t0+tk,100,36,72 if tk==0 else 58)
      for b in (1,3): add("drums",t0+b*Q,80,38,48 if V<2 else (40 if name!="B" else 56))
      for s in range(0,16,2):
        add("drums",t0+s*S16,40,42,(30 if s%4==0 else 22)+(4 if name=="B" else 0))
      if last:
        # soft tom roll into next section
        for s,p in zip(range(10,16),(47,45,47,43,41,38)):
          add("drums",t0+s*S16,70,p,(40+s) if V<2 else (32+s))
      if i==0 and name in("A","A2","A loop"):
        add("drums",t0,500,49,28 if V<2 else 18)  # very soft crash — avoid seam cliff
      if i==0 and name=="B":
        add("drums",t0,700,49,46 if V<2 else 40)
    bar+=1
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if a["tick"]==c["tick"]: c["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[k]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
json.dump(dict(tracks=tr,sections=sections,bars=bar,bpm=BPM),open("plan.json","w"))
mix=json.load(open("mix.json"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Am'),mido.MetaMessage('track_name',name='Echoes of the Crystal Cavern')]
for nm,k,ch,prog,vol,pan in mix:
  if k not in tr: continue
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,round(mf.length,2))
