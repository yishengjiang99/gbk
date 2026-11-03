# "Velvet Hydraulics" - original slow-roll G-funk instrumental, D minor, 84 BPM (seeded generator)
import json,random,mido
random.seed(1103)
Q=480;X=120;BAR=1920
SW=30
TITLE="Velvet Hydraulics";BASE="velvet_hydraulics";BPM=84
SEC=[("Intro",1,4),("Verse 1",5,16),("Hook",21,8),("Verse 2",29,12),("Hook 2",41,8),("Bridge",49,4),("Hook 3",53,8),("Outro",61,4)]
LAST=64
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
# chord: (bass root, pad/EP voicing) -- D minor with dorian G13
C={'Dm9':(38,[53,57,60,64]),'G13':(43,[53,59,62,64]),'Gm9':(43,[53,57,58,62]),'Bbmaj9':(46,[57,60,62,65]),
   'C9':(36,[52,58,62,64]),'Fmaj9':(41,[55,57,60,64]),'A7sus':(45,[55,57,62,64]),'A7b9':(45,[55,58,61,64]),'Em7b5':(40,[55,58,62,64])}
VERSE=['Dm9','G13','Dm9','G13','Bbmaj9','C9','A7sus','A7b9']
HOOK=['Bbmaj9','Fmaj9','Gm9','Dm9','Bbmaj9','C9','A7sus','A7b9']
def chord(b):
  s,st=sec(b)
  if s.startswith("Hook"): return HOOK[(b-st)%8]
  if s=="Bridge": return ['Gm9','Gm9','Em7b5','A7b9'][b-st]
  if s=="Outro": return ['Dm9','G13','Dm9','Dm9'][b-st]
  if s=="Intro": return ['Dm9','G13','Bbmaj9','A7b9'][b-st]
  return VERSE[(b-st)%8]
tr={k:[] for k in("lead","ep","pad","gtr","glock","bass","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Voice Oohs pad: whole-bar chords, soft
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v=46 if s in("Intro","Outro","Bridge") else (58 if s.startswith("Hook") else 50)
  for p in vo: add("pad",b,0,BAR-40 if b<LAST else 1900,p,v,False)
# FM EP comping: 1, and-of-2 (short), 4-and push
EPR=[(0,3),(6,1),(11,2)]
for b in range(1,LAST):
  s,_=sec(b)
  if s=="Bridge": continue
  _,vo=C[chord(b)]
  for st,d in EPR:
    for p in vo: add("ep",b,st*X,d*X*0.9,p+12 if p<57 else p,(70 if st==0 else 60)+random.randint(-4,4))
# Clean guitar: sliding double-stop chops on 2 and 4 plus pickup 16ths (verses/hooks)
for b in range(5,LAST):
  s,_=sec(b)
  if s in("Outro","Bridge"): continue
  _,vo=C[chord(b)];top=sorted(vo)[-2:]
  for st in (4,12):
    for p in top: add("gtr",b,st*X,X*0.6,p+12,72+random.randint(-4,6))
  if b%2==0:
    for st,p in ((14,top[1]+12),(15,top[0]+12)): add("gtr",b,st*X,X*0.4,p,60)
# Glockenspiel sparkle in hooks: arpeggio of chord tones, upper octave
for b in range(1,LAST+1):
  s,_=sec(b)
  if not s.startswith("Hook"): continue
  _,vo=C[chord(b)]
  for i,st in enumerate((0,3,6,10)): add("glock",b,st*X,X*2,sorted(vo)[i%4]+24,58+(8 if i==0 else 0))
# Fretless bass: long root, octave pop, chromatic slide into next bar
BP=[[(0,5,0),(6,1,0),(7,2,12),(10,2,7),(12,3,0)],[(0,3,0),(3,3,0),(8,2,10),(10,2,7),(13,2,0)]]
for b in range(1,LAST+1):
  root,_=C[chord(b)];r=root;s,_=sec(b)
  if b==LAST: add("bass",b,0,1700,38,100);continue
  if s=="Intro":
    if b>=3: add("bass",b,0,X*12,r,86)
    continue
  for st,d,iv in BP[b%2]: add("bass",b,st*X,d*X*0.9,r+iv,random.randint(92,104) if st==0 else random.randint(76,90))
  nxt,_=C[chord(b+1)]
  if nxt!=root: add("bass",b,15*X,X*0.8,nxt-1 if nxt>r else nxt+1,82)
# Solo Vox lead (talkbox-style): legato phrases with scoops, D minor
SC=[62,64,65,67,69,70,72,74,76,77,79,81]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
R1=[(0,3),(3,3),(8,6)]
R2=[(2,4),(6,2),(8,2),(10,6)]
END=[(0,14)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i;_,vo=C[chord(b)]
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-2,0,3]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)));idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,2])));p=SC[idx]
      if p==prev: p=SC[max(0,SC.index(p)-1)]
      if d>=3 and st>=1 and random.random()<0.55:
        add("lead",b,st*X-60,50,p-1 if (p-1)%12 in [s%12 for s in SC] else p-2,vel-12,False)
      add("lead",b,st*X,d*X*0.95,p,vel+random.randint(-4,6),False)
      prev=p
phrase(3,2,4,74,62);phrase(13,8,6,72,74);phrase(21,8,11,77,86);phrase(33,8,6,74,78);phrase(41,8,11,79,90);phrase(53,8,23,77,92);phrase(61,3,27,74,68)
for i,p in enumerate([69,74,77]): add("lead",LAST,i*60,1600,p,66,False)
# Drums (Dance kit, ch10 prog 26): kick 36, snare 38, clap 39, rim 37, closed hat 42, open hat 46, shaker 70, crash 49
KK=[[0,7,10],[0,3,8,11]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,960,36,100);add("drums",b,0,960,49,80);continue
  if s=="Intro":
    for st in range(0,16,2): add("drums",b,st*X,X*0.5,70,40+b*5+(8 if st%4==0 else 0))
    if b==4:
      for st in (12,13,14,15): add("drums",b,st*X,X*0.6,38,60+st*2)
    continue
  thin=(s=="Bridge")
  for st in range(16):
    if st%2==0: add("drums",b,st*X,X*0.5,42,(70 if st%4==0 else 54)+random.randint(-6,6))
  if not thin:
    for st in range(1,16,2):
      if random.random()<0.5: add("drums",b,st*X,X*0.4,70,40+random.randint(-4,4))
  if b%4==0 and not thin: add("drums",b,10*X,X*1.5,46,60)
  if thin:
    add("drums",b,0,X,36,90);add("drums",b,12*X,X,37,66)
    continue
  for st in KK[b%2]: add("drums",b,st*X,X,36,100 if st==0 else 84)
  add("drums",b,4*X,X,38,92);add("drums",b,12*X,X,38,96)
  add("drums",b,4*X+10,X,39,70);add("drums",b,12*X+10,X,39,74)
  if random.random()<0.4: add("drums",b,7*X,X*0.5,37,44)
  if (b-st0)%8==7 and s!="Outro":
    for st in (13,14,15): add("drums",b,st*X,X*0.5,38,58+st*2)
  if b in(5,21,29,41,53,61): add("drums",b,0,960,49,78)
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
TRK={"lead":(0,85,"Solo Vox Lead"),"ep":(1,5,"FM Electric Piano"),"pad":(2,53,"Voice Oohs"),"gtr":(3,27,"Clean Guitar"),"glock":(4,9,"Glockenspiel"),"bass":(5,35,"Fretless Bass"),"drums":(9,26,"Dance Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Dm'),mido.MetaMessage('track_name',name=TITLE)]
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
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title(f'{TITLE} — D minor, {BPM} BPM, slow-roll G-funk');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1);ax.set_ylim(30,95)
plt.tight_layout();plt.savefig(BASE+'_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
