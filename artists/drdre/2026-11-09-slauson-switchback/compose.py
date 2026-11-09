# "Slauson Switchback" - original West Coast G-funk bounce, G minor, 98 BPM, harmonica lead
import json,random,mido
random.seed(1109)
Q=480;X=120;BAR=1920;SW=18
TITLE="Slauson Switchback";BASE="slauson_switchback";BPM=98
SEC=[("Intro",1,4),("Verse 1",5,16),("Hook",21,8),("Verse 2",29,12),("Hook 2",41,8),("Break",49,4),("Hook 3",53,8),("Outro",61,4)]
LAST=64
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
# G minor palette (bass root, mid voicing)
C={'Gm9':(43,[58,62,65,69]),'Cm9':(48,[58,63,67,70]),'Ebmaj7':(39,[58,62,67,70]),
   'D7#9':(38,[54,60,65,66]),'D7':(38,[54,57,60,62]),'Bbmaj7':(46,[57,62,65,69]),'Fsus':(41,[60,63,65,70]),'Am7b5':(45,[57,60,63,67])}
VERSE=['Gm9','Gm9','Cm9','Cm9','Gm9','Gm9','Ebmaj7','D7#9']
HOOK=['Ebmaj7','Cm9','Gm9','Gm9','Ebmaj7','Cm9','Am7b5','D7']
def chord(b):
  s,st=sec(b)
  if s.startswith("Hook"): return HOOK[(b-st)%8]
  if s=="Break": return ['Bbmaj7','Fsus','Ebmaj7','D7'][b-st]
  if s=="Outro": return ['Gm9','Cm9','Ebmaj7','Gm9'][b-st]
  if s=="Intro": return ['Gm9','Cm9','Ebmaj7','D7#9'][b-st]
  return VERSE[(b-st)%8]
tr={k:[] for k in("harp","gtr","bass","str","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Synth Strings 1 (50): held chords, fuller on hooks
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v=40 if s in("Intro","Outro","Break") else (54 if s.startswith("Hook") else 44)
  for p in vo: add("str",b,0,BAR-40 if b<LAST else 1800,p,v,False)
# Jazz Guitar (26): muted 16th chops on offbeats, high voicing
CH=[[2,6,10,14],[2,6,7,10,14],[2,6,10,13,14],[3,6,10,14]]
for b in range(1,LAST):
  s,_=sec(b);_,vo=C[chord(b)]
  top=[p+12 if p<62 else p for p in vo[1:4]]
  if s=="Intro" and b<3: continue
  if s=="Break":
    for p in top: add("gtr",b,0,X*3,p,48,False)
    continue
  pat=CH[b%4]
  for st in pat:
    for p in top: add("gtr",b,st*X,X*0.38,p,(60 if st%4==2 else 50)+random.randint(-4,4))
# Slap Bass 1 (36): bouncy G-funk line, octaves + fifth + approach
BP=[[(0,2,0),(3,1,0),(4,1,12),(6,2,0),(10,1,7),(11,1,10),(12,2,12)],
    [(0,3,0),(3,1,12),(6,1,0),(8,2,7),(11,1,0),(12,1,12),(14,1,10)],
    [(0,2,0),(2,1,12),(4,2,0),(7,1,7),(8,2,0),(10,1,12),(13,2,7)],
    [(0,3,0),(4,1,12),(5,1,0),(8,3,0),(12,1,10),(13,1,12),(14,1,7)]]
for b in range(1,LAST+1):
  root,_=C[chord(b)];r=root if root<=45 else root-12;s,_=sec(b)
  if b==LAST: add("bass",b,0,1600,r,96);continue
  if s=="Intro":
    if b<3: continue
    add("bass",b,0,X*6,r,82);add("bass",b,8*X,X*3,r+12,70);add("bass",b,12*X,X*3,r+7,66);continue
  if s=="Break":
    add("bass",b,0,X*7,r,80);add("bass",b,12*X,X*2,r+12,64);continue
  for st,d,iv in BP[b%4]:
    add("bass",b,st*X,d*X*0.8,r+iv,random.randint(94,106) if st==0 else random.randint(72,88))
  nxt,_=C[chord(b+1)];nr=nxt if nxt<=45 else nxt-12
  if nr!=r and random.random()<0.6: add("bass",b,15*X,X*0.7,nr-1 if nr>r else nr+1,78)
# Harmonica (22): bluesy G minor pentatonic + blue note, grace slides, call/response
SC=[55,58,60,61,62,65,67,70,72,73,74,77,79,82]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
RH=[[(0,1),(1,2),(4,1),(6,4)],[(2,1),(4,1),(6,1),(8,5)],[(0,3),(4,1),(5,1),(6,2),(10,3)],[(8,1),(10,1),(12,4)],[(0,6),(8,1),(10,2)]]
def phrase(b0,n,seed,base,vel,density=1.0):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i;_,vo=C[chord(b)]
    if random.random()>density: continue
    if i%4==3: continue  # breathing bar
    rh=RH[(seed+i)%len(RH)]
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-3,0,3]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)))
        idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,1,0])))
        p=SC[idx]
      if p==prev: p=SC[max(0,min(len(SC)-1,SC.index(p)+random.choice([-1,1])))]
      if d>=3 and st>=1 and p-1 not in (prev,):  # slide-up grace into long notes
        add("harp",b,st*X-40,36,p-1,vel-14,False)
      add("harp",b,st*X,d*X*0.92,p,vel+random.randint(-5,5),False)
      prev=p
phrase(3,2,13,67,58,0.8)
phrase(7,6,17,70,70,0.7)
phrase(15,5,29,72,72,0.7)
phrase(21,8,31,74,82,0.95)
phrase(31,8,37,70,74,0.7)
phrase(41,8,43,77,86,0.95)
phrase(50,2,47,67,60,0.6)
phrase(53,8,53,74,90,0.95)
phrase(61,3,61,70,64,0.7)
for i,p in enumerate([62,67,70]): add("harp",LAST,i*80,1400,p,62,False)
# Power Kit (16): kick 36, snare 38, clap 39, closed 42, open 46, tamb 54, crash 49
KK=[[0,7,10],[0,3,8,10],[0,6,10,11],[0,7,9,14]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,960,36,96);add("drums",b,0,960,49,72);continue
  if s=="Intro":
    for st in range(0,16,2): add("drums",b,st*X,X*0.4,42,34+b*6)
    if b>=3: add("drums",b,0,X,36,80);add("drums",b,12*X,X,39,60)
    if b==4:
      for st in (12,13,14,15): add("drums",b,st*X,X*0.5,38,56+st*2)
    continue
  if s=="Break":
    add("drums",b,0,X,36,82)
    for st in (2,6,10,14): add("drums",b,st*X,X*0.4,42,44)
    add("drums",b,12*X,X,39,62);continue
  for st in range(16):
    if st%2==0: add("drums",b,st*X,X*0.35,42,(62 if st%4==0 else 46)+random.randint(-4,4))
    elif random.random()<0.25: add("drums",b,st*X,X*0.3,42,30)
  for st in (4,12): add("drums",b,st*X,X*0.5,54,40)
  if b%2==0: add("drums",b,14*X,X*1.4,46,52)
  for st in KK[b%4]: add("drums",b,st*X,X,36,100 if st==0 else 80)
  add("drums",b,4*X,X,38,92);add("drums",b,12*X,X,38,96);add("drums",b,12*X,X,39,70)
  if (b-st0)%8==7 and s!="Outro":
    for st in (13,14,15): add("drums",b,st*X,X*0.4,38,54+st*2)
  if b in(5,21,29,41,53,61): add("drums",b,0,960,49,72)
# remove same-pitch overlaps
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]));keep=[]
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
TRK={"harp":(0,22,"Harmonica"),"gtr":(1,26,"Jazz Guitar"),"bass":(2,36,"Slap Bass 1"),"str":(3,50,"Synth Strings 1"),"drums":(9,16,"Power Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Gm'),mido.MetaMessage('track_name',name=TITLE)]
for k,(ch,prog,nm) in TRK.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
  t.append(mido.Message('program_change',channel=ch,program=prog));ev=[]
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
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title(f'{TITLE} — G minor, {BPM} BPM, West Coast G-funk bounce');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1);ax.set_ylim(30,95)
plt.tight_layout();plt.savefig(BASE+'_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
