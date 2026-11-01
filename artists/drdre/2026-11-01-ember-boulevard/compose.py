# "Ember Boulevard" - original lowrider G-funk instrumental, E minor (dorian color), 90 BPM (seeded generator)
import json,random,mido
random.seed(1101)
Q=480;X=120;BAR=1920
SW=26
TITLE="Ember Boulevard";BASE="ember_boulevard";BPM=90
SEC=[("Intro",1,4),("Verse 1",5,12),("Hook",17,8),("Verse 2",25,12),("Hook 2",37,8),("Bridge",45,4),("Hook 3",49,8),("Outro",57,4)]
LAST=60
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
# chord: (bass root, organ voicing) -- E minor with dorian A13
C={'Em9':(40,[55,59,62,66]),'A13':(45,[55,61,64,66]),'Cmaj9':(36,[59,62,64,67]),'D6':(38,[57,59,62,66]),
   'Bm7':(35,[57,59,62,66]),'B7':(35,[57,59,63,66]),'B7sus':(35,[57,59,64,66]),'G6':(43,[55,59,62,64]),'Am9':(45,[55,59,60,64])}
VERSE=['Em9','A13','Em9','A13','Cmaj9','D6','Bm7','B7']
HOOK=['Cmaj9','D6','Em9','G6','Am9','D6','B7sus','B7']
def chord(b):
  s,st=sec(b)
  if s.startswith("Hook"): return HOOK[(b-st)%8]
  if s=="Bridge": return ['Am9','Am9','B7sus','B7'][b-st]
  if s=="Outro": return ['Em9','A13','Em9','Em9'][b-st]
  if s=="Intro": return ['Em9','A13','Em9','B7'][b-st]
  return VERSE[(b-st)%8]
tr={k:[] for k in("lead","organ","gtr","brass","bass","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Organ: held chord on 1 for 2.5 beats, re-strike on the "and" of 3
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v=50 if s in("Intro","Outro") else (64 if s.startswith("Hook") else 58)
  if b==LAST:
    for p in vo: add("organ",b,0,1800,p,50,False)
    continue
  for p in vo: add("organ",b,0,X*10-30,p,v,False); add("organ",b,X*10,X*6-30,p,v-6,False)
# Muted guitar: wah-style 16th licks on chord tones, answering the lead
GP=[[(4,64),(5,0),(7,1),(11,2),(12,1)],[(2,1),(3,2),(6,0),(10,1),(14,2),(15,1)],[(4,0),(6,1),(7,2),(12,0),(13,1)],[(1,2),(2,1),(6,2),(9,0),(10,1),(14,0)]]
for b in range(5,LAST):
  s,_=sec(b)
  if s=="Outro": continue
  _,vo=C[chord(b)];tones=[p+0 for p in vo[1:]]
  for st,ix in GP[(b-1)%4]:
    p=tones[ix%3] if ix<64 else tones[0]
    add("gtr",b,st*X,X*0.45,p,random.randint(62,78)+(6 if st%4==2 else 0))
# Synth brass stabs in hooks: and-of-2 and beat 4
for b in range(1,LAST+1):
  s,_=sec(b)
  if not s.startswith("Hook"): continue
  _,vo=C[chord(b)]
  for st,d in ((6,X*1.5),(12,X*2)):
    for p in vo[1:]: add("brass",b,st*X,d,p+12,82 if st==6 else 76)
# Bass: Moog-style synth bass 2, long root, chromatic approach into next bar
BP=[[(0,4,0),(5,1,0),(6,2,12),(9,1,7),(10,3,0)],[(0,3,0),(3,2,0),(7,1,10),(8,3,7),(12,2,0)]]
for b in range(1,LAST+1):
  root,_=C[chord(b)];r=root;s,_=sec(b)
  if b==LAST: add("bass",b,0,1700,40,104);continue
  if s=="Intro":
    if b>=3: add("bass",b,0,X*7,r,88);add("bass",b,8*X,X*6,r,80)
    continue
  for st,d,iv in BP[b%2]: add("bass",b,st*X,d*X*0.9,r+iv,random.randint(94,106) if st==0 else random.randint(78,92))
  nxt,_=C[chord(b+1)]
  if nxt!=root: add("bass",b,15*X,X*0.8,nxt-1 if nxt>r else nxt+1,84)
# Lead (saw lead "whine"): long notes with whole-step grace scoops, E minor pentatonic + 9 + dorian 6
SC=[64,66,67,69,71,73,74,76,78,79,81,83]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
R1=[(0,4),(4,4),(10,6)]
R2=[(2,6),(8,2),(10,2),(12,4)]
END=[(0,14)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i;_,vo=C[chord(b)]
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-3,0,2]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)));idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,1])));p=SC[idx]
      if p==prev: p=SC[max(0,SC.index(p)-1)]
      if d>=4 and st>=1 and random.random()<0.6:
        add("lead",b,st*X-50,40,p-2,vel-10,False)  # scoop
        add("lead",b,st*X,d*X*0.95,p,vel+random.randint(-4,6),False)
      else: add("lead",b,st*X,d*X*0.95,p,vel+random.randint(-4,6),False)
      prev=p
phrase(1,4,3,76,66);phrase(9,8,5,76,76);phrase(17,8,9,79,88);phrase(29,8,5,74,78);phrase(37,8,9,81,92);phrase(49,8,21,79,94);phrase(57,3,25,76,70)
for i,p in enumerate([71,76,79]): add("lead",LAST,i*60,1600,p,70,False)
# Drums (Electronic kit, ch10): kick 36, elec snare 40, clap 39, closed hat 42, pedal hat 44, open hat 46, crash 49, tambourine 54
KK=[[0,6,9],[0,3,10,11]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,960,36,104);add("drums",b,0,960,49,84);continue
  if s=="Intro":
    for st in range(0,16,4): add("drums",b,st*X,X*0.5,44,48+b*4)
    if b==4:
      for st in (12,13,14,15): add("drums",b,st*X,X*0.6,40,64+st*2)
    continue
  thin=(s=="Bridge")
  for st in range(16):
    if st%2==0: add("drums",b,st*X,X*0.5,42,(74 if st%4==0 else 58)+random.randint(-6,6))
    elif not thin and random.random()<0.35: add("drums",b,st*X,X*0.4,42,44+random.randint(-4,4))
  if b%4==3 and not thin: add("drums",b,14*X,X*1.5,46,64)
  if thin:
    add("drums",b,0,X,36,92);add("drums",b,12*X,X,39,70)
    continue
  for st in KK[b%2]: add("drums",b,st*X,X,36,102 if st==0 else 86)
  add("drums",b,4*X,X,40,94);add("drums",b,12*X,X,40,98)
  add("drums",b,4*X+8,X,39,64);add("drums",b,12*X+8,X,39,68)
  if s.startswith("Hook"):
    add("drums",b,4*X,X,54,58);add("drums",b,12*X,X,54,62)
  if (b-st0)%8==7 and s!="Outro":
    for st in (13,14,15): add("drums",b,st*X,X*0.5,40,60+st*2)
  if b in(5,17,25,37,49,57): add("drums",b,0,960,49,80)
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
TRK={"lead":(0,81,"Saw Lead"),"organ":(1,16,"Tonewheel Organ"),"gtr":(2,28,"Muted Guitar"),"brass":(3,62,"Synth Brass"),"bass":(4,39,"Synth Bass 2"),"drums":(9,24,"Electronic Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Em'),mido.MetaMessage('track_name',name=TITLE)]
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
for n,s,l in SEC: ax.axvline(s,color='k',ls='--',lw=.8);ax.text(s+.1,97,n)
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title(f'{TITLE} — E minor, {BPM} BPM, lowrider G-funk');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1)
plt.tight_layout();plt.savefig(BASE+'_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
