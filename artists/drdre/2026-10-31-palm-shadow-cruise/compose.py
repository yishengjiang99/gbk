# "Palm Shadow Cruise" - original West Coast G-funk instrumental, B minor, 94 BPM (seeded generator)
import json,random,mido
random.seed(1031)
Q=480;X=120;BAR=1920
SW=22
TITLE="Palm Shadow Cruise";BASE="palm_shadow_cruise";BPM=94
SEC=[("Intro",1,4),("Verse 1",5,16),("Hook",21,8),("Break",29,4),("Verse 2",33,8),("Hook 2",41,8),("Outro",49,4)]
LAST=52
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n
# chord: (bass root, pad/clav voicing)  -- B minor
C={'Bm9':(35,[62,66,69,73]),'Em9':(40,[62,66,67,71]),'Gmaj7':(43,[62,66,67,71]),'F#7':(42,[61,64,66,70]),
   'A6':(45,[61,64,66,69]),'Dmaj7':(38,[61,62,66,69]),'F#7sus':(42,[61,64,66,71]),'Em7':(40,[59,62,64,67])}
VERSE=['Bm9','Bm9','Em9','Em9','Gmaj7','Gmaj7','F#7sus','F#7']
HOOK=['Gmaj7','A6','Dmaj7','Bm9','Em7','A6','F#7sus','F#7']
def chord(b):
  s=sec(b)
  if s.startswith("Hook"): return HOOK[(b-SEC[[x[0] for x in SEC].index(s)][1])%8]
  if s=="Break": return ['Em9','Em9','F#7sus','F#7'][b-29]
  if s=="Outro": return ['Bm9','Em9','F#7','Bm9'][b-49]
  return VERSE[(b-1)%8]
tr={k:[] for k in("lead","clav","pad","bass","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Pad (warm pad) everywhere except break, sustained chords
for b in range(1,LAST+1):
  s=sec(b)
  if s=="Break": continue
  _,vo=C[chord(b)]
  for p in vo[:3]+([vo[3]] if s.startswith("Hook") else []): add("pad",b,0,BAR-40,p,54 if s in("Intro","Outro") else 62,False)
# Clavinet: funky muted 16th chops on offbeats
CP=[[2,6,7,10,14],[3,6,10,11,14],[2,6,10,13,14],[2,5,6,10,14,15]]
for b in range(5,LAST):
  s=sec(b);_,vo=C[chord(b)]
  if s=="Outro": continue
  pat=CP[(b-1)%4]
  for st in pat:
    for i,p in enumerate(vo[1:]): add("clav",b,st*X+i*4,X*0.55,p,random.randint(58,74)+(8 if st in(6,14) else 0))
# Bass: G-funk synth bass, long root then syncopated octave pops and approach notes
BP=[[(0,5,0),(6,1,12),(7,2,0),(10,2,0),(13,1,10),(14,2,12)],[(0,3,0),(3,1,0),(6,2,7),(8,4,0),(12,1,12),(14,2,-2)]]
for b in range(1,LAST+1):
  root,_=C[chord(b)];r=root if root<41 else root-12;s=sec(b)
  if s=="Intro" and b<3: continue
  if b==LAST: add("bass",b,0,1700,35,104);continue
  if s=="Intro": add("bass",b,0,BAR*0.45,r,90);add("bass",b,10*X,X*5,r+7 if b==3 else r,80);continue
  for st,d,iv in BP[b%2]: add("bass",b,st*X,d*X*0.9,r+iv,random.randint(92,104) if st==0 else random.randint(76,90))
# Lead (square lead "whistle"): high sparse melody built from two original motifs, B minor pentatonic + 9ths
SC=[71,73,74,76,78,81,83,85,86,88,90]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
M1=[(0,6),(6,2),(8,8)]
M2=[(2,2),(4,2),(6,4),(12,4)]
END=[(0,12)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i;_,vo=C[chord(b)]
    rh=END if i==n-1 else (M1 if i%2==0 else M2)
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-2,0,3]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)));idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,2,-1])));p=SC[idx]
      if p==prev: p=SC[min(len(SC)-1,SC.index(p)+1)]
      add("lead",b,st*X,d*X*0.96,p,vel+random.randint(-4,6),False);prev=p
phrase(13,8,7,83,78);phrase(21,8,11,86,90);phrase(37,4,13,81,80);phrase(41,8,11,88,94);phrase(49,3,17,83,74)
for i,p in enumerate([74,78,83]): add("lead",LAST,i*60,1600,p,72,False)
# Drums (808/909 kit, ch10): kick 36, snare 38, clap 39, closed hat 42, open hat 46, crash 49, shaker 70
KK=[[0,3,8,10],[0,7,10]]
for b in range(1,LAST+1):
  s=sec(b)
  if b==LAST: add("drums",b,0,960,36,104);add("drums",b,0,960,49,84);continue
  if s=="Intro":
    for st in range(0,16,2): add("drums",b,st*X,X*0.5,42,50+random.randint(-4,4)+(b*3))
    if b==4:
      for st in (8,10,12,13,14,15): add("drums",b,st*X,X*0.6,38,60+st*2)
    continue
  brk=(s=="Break")
  for st in range(16):
    if st%2==0 or (not brk and random.random()<0.3): add("drums",b,st*X,X*0.5,42,(76 if st%4==0 else 60)+random.randint(-6,6))
  if b%2==0 and not brk: add("drums",b,6*X,X*1.5,46,66)
  for st in KK[b%2]: add("drums",b,st*X,X,36,100 if st==0 else 84)
  if not brk or b>=31:
    add("drums",b,4*X,X,38,92);add("drums",b,12*X,X,38,96)
    add("drums",b,4*X+6,X,39,70);add("drums",b,12*X+6,X,39,74)
  if s.startswith("Hook"):
    for st in (1,3,5,7,9,11,13,15): add("drums",b,st*X,X*0.5,70,44)
  if b in(5,21,33,41,49): add("drums",b,0,960,49,80)
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
TRK={"lead":(0,80,"Square Lead"),"clav":(1,7,"Clavinet"),"pad":(2,89,"Warm Pad"),"bass":(3,38,"Synth Bass"),"drums":(9,25,"808/909 Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Bm'),mido.MetaMessage('track_name',name=TITLE)]
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
for n,s,l in SEC: ax.axvline(s,color='k',ls='--',lw=.8);ax.text(s+.1,95,n)
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title(f'{TITLE} — B minor, {BPM} BPM, West Coast G-funk');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1)
plt.tight_layout();plt.savefig(BASE+'_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
