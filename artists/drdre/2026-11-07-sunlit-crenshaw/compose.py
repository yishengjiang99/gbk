# "Sunlit Crenshaw" - original sunny neo-soul / quiet-storm hip-hop instrumental, D major, 82 BPM
import json,random,mido
random.seed(1107)
Q=480;X=120;BAR=1920
SW=22
TITLE="Sunlit Crenshaw";BASE="sunlit_crenshaw";BPM=82
SEC=[("Intro",1,4),("Verse 1",5,16),("Hook",21,8),("Verse 2",29,12),("Hook 2",41,8),("Bridge",49,4),("Hook 3",53,8),("Outro",61,4)]
LAST=64
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
# D major family voicings (bass MIDI, mid-register chord tones)
# Dmaj9: D F# A C# E ; Gmaj7: G B D F# ; Bm7: B D F# A ; A7sus/A7: A D E G / A C# E G
# Em9: E G B D F# ; F#m7: F# A C# E
C={'Dmaj9':(38,[50,54,57,61,64]),'Gmaj7':(43,[55,59,62,66]),'Bm7':(35,[50,54,57,59]),
   'A7sus':(45,[57,62,64,67]),'A7':(45,[57,61,64,67]),'Em9':(40,[52,55,59,62,66]),
   'F#m7':(42,[54,57,61,64]),'Dmaj7':(38,[50,54,57,61])}
VERSE=['Dmaj9','Gmaj7','Bm7','A7sus','Dmaj9','Em9','F#m7','A7']
HOOK=['Gmaj7','Dmaj9','Em9','A7','Gmaj7','Bm7','Em9','A7']
def chord(b):
  s,st=sec(b)
  if s.startswith("Hook"): return HOOK[(b-st)%8]
  if s=="Bridge": return ['Em9','F#m7','Gmaj7','A7sus'][b-st]
  if s=="Outro": return ['Dmaj9','Gmaj7','Em9','Dmaj7'][b-st]
  if s=="Intro": return ['Dmaj9','Gmaj7','Bm7','A7sus'][b-st]
  return VERSE[(b-st)%8]
tr={k:[] for k in("wurli","bass","sax","pad","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Warm Pad (Pad 2 warm, prog 89): soft held chords
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v=38 if s in("Intro","Outro","Bridge") else (48 if s.startswith("Hook") else 42)
  tones=vo[:4]
  for p in tones: add("pad",b,0,BAR-50 if b<LAST else 1800,p,v,False)
# Wurlitzer / EP2 (prog 5): soft syncopated neo-soul stabs
# pattern: soft stab on 1, ghost on and-of-2, punch on 3-and / 4
WURLI=[(0,2),(6,1),(10,1.5),(14,1)]
WURLI2=[(0,1.5),(4,1),(8,2),(13,1.2)]
for b in range(1,LAST):
  s,_=sec(b)
  _,vo=C[chord(b)]
  # keep mid register for EP
  vo=[p if p>=50 else p+12 for p in vo[:4]]
  if s=="Bridge":
    for p in vo[:3]: add("wurli",b,0,X*5,p,44+random.randint(-2,2),False)
    if b%2==0:
      for p in vo[1:3]: add("wurli",b,10*X,X*2,p,40+random.randint(-2,2))
    continue
  if s=="Intro":
    pat=[(0,3),(8,2)] if b<=2 else WURLI
    for st,d in pat:
      for p in vo[:3]: add("wurli",b,st*X,d*X*0.8,p,(52 if st==0 else 42)+random.randint(-3,3))
    continue
  pat=WURLI if b%2==0 else WURLI2
  for st,d in pat:
    for p in vo: add("wurli",b,st*X,d*X*0.75,p,(62 if st==0 else 48)+random.randint(-4,4))
  # occasional upper color on hooks
  if s.startswith("Hook") and b%2==1:
    add("wurli",b,11*X,X*1.2,sorted(vo)[-1]+12,46+random.randint(-2,3))
# Finger Bass (33): warm pocket, root-fifth with occasional octave
BP=[[(0,5,0),(8,3,7),(12,3,0)],[(0,4,0),(6,2,0),(8,3,12),(12,3,0)],
    [(0,3,0),(4,2,7),(8,4,0),(14,1.5,12)],[(0,5,0),(10,2,0),(12,3,7)]]
for b in range(1,LAST+1):
  root,_=C[chord(b)];r=root;s,_=sec(b)
  if b==LAST:
    add("bass",b,0,1600,r,90);continue
  if s=="Intro":
    if b==1: continue
    add("bass",b,0,X*10,r,76)
    if b>=3: add("bass",b,12*X,X*3,r+7 if r+7<=50 else r,60)
    continue
  if s=="Bridge":
    add("bass",b,0,X*10,r,74)
    add("bass",b,12*X,X*3,r+12 if r+12<=50 else r,58)
    continue
  for st,d,iv in BP[b%4]:
    pitch=r+iv
    if pitch>52: pitch=r
    add("bass",b,st*X,d*X*0.88,pitch,random.randint(86,98) if st==0 else random.randint(70,84))
  # soft approach into next chord
  if b<LAST:
    nxt,_=C[chord(b+1)]
    if nxt!=root and random.random()<0.55:
      approach=nxt-1 if nxt>r else nxt+1
      add("bass",b,15*X,X*0.7,approach,72)
# Soft Alto Sax (65): short melodic hooks / answers (not long bebop)
# D major scale + sweet extensions: D E F# G A B C# (+9ths)
SC=[62,64,66,67,69,71,73,74,76,78,79,81,83]  # D major mid-high
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
# short call/answer motifs — 2-4 notes, rests between
CALLS=[
  [(0,2),(3,1),(4,3)],           # short rise-settle
  [(2,1),(4,2),(8,3)],           # delayed entrance
  [(0,1.5),(2,1),(4,1),(6,4)],   # gentle cascade into hold
  [(4,2),(7,1),(8,4)],           # mid-bar answer
  [(0,3),(6,1),(8,2)],           # sunny open
]
def phrase(b0,n,seed,base,vel,density=1.0):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i;s,_=sec(b);_,vo=C[chord(b)]
    if random.random()>density: continue
    # leave space every other bar sometimes
    if i%3==2 and random.random()<0.4: continue
    rh=CALLS[(seed+i)%len(CALLS)]
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-2,0,2]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)))
        idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,2,0])))
        p=SC[idx]
      if p==prev: p=SC[max(0,min(len(SC)-1,SC.index(p)+random.choice([-1,1])))]
      add("sax",b,st*X,d*X*0.9,p,vel+random.randint(-5,5),False)
      prev=p
# sparse intro tease
phrase(3,2,11,69,56,0.7)
# verse 1 answers
phrase(7,6,19,66,68,0.55)
phrase(15,4,23,71,70,0.6)
# hook melodic peak
phrase(21,8,31,74,78,0.85)
# verse 2
phrase(31,8,37,69,72,0.55)
# hook 2
phrase(41,8,41,76,82,0.85)
# bridge: one soft call
phrase(50,2,47,64,52,0.5)
# hook 3 peak + outro fade
phrase(53,8,53,74,86,0.9)
phrase(61,3,59,69,62,0.6)
for i,p in enumerate([66,69,74]): add("sax",LAST,i*90,1400,p,58,False)
# Standard Kit: dusty lightly-swung 16ths — kick 36, snare 38, rim 37, closed 42, open 46, shaker 70, crash 49
KK=[[0,6,10],[0,3,8,11],[0,7,10],[0,6,9,11]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST:
    add("drums",b,0,960,36,92);add("drums",b,0,960,49,68);continue
  if s=="Intro":
    for st in range(0,16,2): add("drums",b,st*X,X*0.45,42,32+b*5+(5 if st%4==0 else 0))
    if b>=2:
      add("drums",b,0,X,36,72)
      if b>=3: add("drums",b,8*X,X,36,64)
    if b==4:
      for st in (12,13,14,15): add("drums",b,st*X,X*0.5,38,50+st*2)
    continue
  thin=(s=="Bridge")
  if thin:
    add("drums",b,0,X,36,78);add("drums",b,8*X,X,36,66)
    for st in (0,4,8,12): add("drums",b,st*X,X*0.45,42,38)
    add("drums",b,12*X,X,37,52)
    continue
  # closed hats on even 16ths
  for st in range(16):
    if st%2==0: add("drums",b,st*X,X*0.4,42,(58 if st%4==0 else 44)+random.randint(-4,4))
  # light shaker on offbeats
  for st in range(1,16,2):
    if random.random()<0.4: add("drums",b,st*X,X*0.3,70,32+random.randint(-2,4))
  if b%4==0: add("drums",b,10*X,X*1.3,46,50)
  for st in KK[b%4]: add("drums",b,st*X,X,36,94 if st==0 else 74)
  add("drums",b,4*X,X,38,84);add("drums",b,12*X,X,38,88)
  if random.random()<0.3: add("drums",b,7*X,X*0.4,37,38)
  if (b-st0)%8==7 and s!="Outro":
    for st in (13,14,15): add("drums",b,st*X,X*0.4,38,48+st*2)
  if b in(5,21,29,41,53,61): add("drums",b,0,960,49,66)
# remove same-pitch overlaps (per track)
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  keep=[]
  for n in N:
    if keep and keep[-1]["pitch"]==n["pitch"]:
      a=keep[-1]
      if n["tick"]-a["tick"]<30: continue
      if a["tick"]+a["duration"]>n["tick"]: a["duration"]=max(20,n["tick"]-a["tick"]-8)
    keep.append(n)
  tr[k]=sorted(keep,key=lambda n:(n["tick"],n["pitch"]))
for k,N in tr.items():
  by={}
  for n in N: by.setdefault(n["pitch"],[]).append(n)
  for p,L in by.items():
    L.sort(key=lambda n:n["tick"])
    for a,c in zip(L,L[1:]): assert a["tick"]+a["duration"]<=c["tick"],(k,p,a,c)
json.dump(tr,open("plan.json","w"))
# GM: EP2/Wurlitzer 5, Finger Bass 33, Alto Sax 65, Pad 2 (warm) 89, Standard Kit 0
TRK={"wurli":(0,5,"Electric Piano 2"),"bass":(1,33,"Finger Bass"),"sax":(2,65,"Alto Sax"),"pad":(3,89,"Pad 2 (warm)"),"drums":(9,0,"Standard Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='D'),mido.MetaMessage('track_name',name=TITLE)]
for k,(ch,prog,nm) in TRK.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
  t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(BASE+".mid")
import matplotlib;matplotlib.use('Agg');import matplotlib.pyplot as plt
fig,ax=plt.subplots(figsize=(22,9));cols=plt.cm.tab10.colors
for i,(k,(ch,prog,nm)) in enumerate(TRK.items()):
  for n in tr[k]: ax.broken_barh([(n['tick']/BAR+1,n['duration']/BAR)],(n['pitch']-.4,.8),color=cols[i])
  ax.plot([],[],color=cols[i],lw=6,label=f"{nm} (ch{ch+1}, GM {prog})")
for n,s,l in SEC: ax.axvline(s,color='k',ls='--',lw=.8);ax.text(s+.1,93,n)
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title(f'{TITLE} — D major, {BPM} BPM, sunny neo-soul / quiet-storm');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1);ax.set_ylim(30,95)
plt.tight_layout();plt.savefig(BASE+'_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
