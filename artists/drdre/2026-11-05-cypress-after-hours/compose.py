# "Cypress After Hours" - original late-night jazz-hop instrumental, C minor, 86 BPM
import json,random,mido
random.seed(1105)
Q=480;X=120;BAR=1920
SW=25
TITLE="Cypress After Hours";BASE="cypress_after_hours";BPM=86
SEC=[("Intro",1,4),("Verse 1",5,16),("Hook",21,8),("Verse 2",29,12),("Hook 2",41,8),("Bridge",49,4),("Hook 3",53,8),("Outro",61,4)]
LAST=64
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
# C minor family voicings (bass MIDI, chord tones mid register)
C={'Cm9':(36,[48,51,55,62]),'Fm9':(41,[48,53,56,60]),'Abmaj7':(44,[51,55,58,63]),'G7':(43,[50,53,59,62]),
   'Dbmaj7':(37,[49,53,56,60]),'Bb6':(46,[53,57,60,62]),'Ebmaj7':(39,[51,55,58,62]),'G7sus':(43,[50,53,58,60]),
   'Dm7b5':(38,[48,53,56,59])}
VERSE=['Cm9','Fm9','Abmaj7','G7','Cm9','Fm9','Dbmaj7','G7']
HOOK=['Abmaj7','Bb6','Cm9','Ebmaj7','Abmaj7','Bb6','G7sus','G7']
def chord(b):
  s,st=sec(b)
  if s.startswith("Hook"): return HOOK[(b-st)%8]
  if s=="Bridge": return ['Fm9','Fm9','Dm7b5','G7'][b-st]
  if s=="Outro": return ['Cm9','Fm9','Abmaj7','Cm9'][b-st]
  if s=="Intro": return ['Cm9','Fm9','Abmaj7','G7'][b-st]
  return VERSE[(b-st)%8]
tr={k:[] for k in("lead","piano","pad","bass","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Halo Pad: soft whole-bar chords
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v=40 if s in("Intro","Outro","Bridge") else (52 if s.startswith("Hook") else 46)
  for p in vo: add("pad",b,0,BAR-40 if b<LAST else 1900,p,v,False)
# Acoustic Grand Piano: dusty jazz-hop comps (1, and-of-2, 4)
EPR=[(0,3),(6,1),(12,2)]
for b in range(1,LAST):
  s,_=sec(b)
  if s=="Bridge":
    # thinned: just sparse downbeats
    _,vo=C[chord(b)]
    for p in vo[:3]: add("piano",b,0,X*6,p,48+random.randint(-3,3),False)
    continue
  _,vo=C[chord(b)]
  for st,d in EPR:
    for p in vo: add("piano",b,st*X,d*X*0.85,p,(66 if st==0 else 54)+random.randint(-4,4))
  # occasional upper color tone on and-of-3 in hooks
  if s.startswith("Hook") and b%2==0:
    add("piano",b,10*X,X*1.5,sorted(vo)[-1]+12,50+random.randint(-3,3))
# Picked Bass: walking-ish jazz-hop roots with octave pops
BP=[[(0,4,0),(6,2,0),(8,2,12),(12,3,0)],[(0,3,0),(4,2,7),(8,2,0),(12,2,12),(14,1,0)]]
for b in range(1,LAST+1):
  root,_=C[chord(b)];r=root;s,_=sec(b)
  if b==LAST: add("bass",b,0,1700,36,96);continue
  if s=="Intro":
    if b>=2: add("bass",b,0,X*10,r,80)
    continue
  if s=="Bridge":
    add("bass",b,0,X*10,r,78);add("bass",b,12*X,X*3,r+12 if r+12<=48 else r,62)
    continue
  for st,d,iv in BP[b%2]: add("bass",b,st*X,d*X*0.9,r+iv,random.randint(88,100) if st==0 else random.randint(72,86))
  nxt,_=C[chord(b+1)]
  if nxt!=root: add("bass",b,15*X,X*0.75,nxt-1 if nxt>r else nxt+1,76)
# Muted Trumpet lead: lyrical C minor phrases (jazz-hop, not G-funk)
SC=[60,62,63,65,67,68,70,72,74,75,77,79]  # C natural minor / bluesy
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
R1=[(0,2),(3,1),(4,2),(8,4)]
R2=[(2,2),(4,1),(6,2),(10,4)]
END=[(0,10)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i;_,vo=C[chord(b)]
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-2,0,2]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)));idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,2])));p=SC[idx]
      if p==prev: p=SC[max(0,SC.index(p)-1)]
      # soft scoop into longer notes
      if d>=3 and st>=1 and random.random()<0.4:
        scoop=p-1 if (p-1)%12 in [s%12 for s in SC] else p-2
        add("lead",b,st*X-40,35,scoop,vel-14,False)
      add("lead",b,st*X,d*X*0.92,p,vel+random.randint(-4,5),False)
      prev=p
# sparse intro tease, verse lines, hook peaks, bridge rest (thinned), final hook+outro
phrase(3,2,11,67,58)
phrase(7,8,19,65,70)
phrase(21,8,31,72,82)
phrase(31,8,19,67,74)
phrase(41,8,31,74,86)
# bridge: almost silent lead (one soft call)
phrase(51,2,41,63,54)
phrase(53,8,47,72,90)
phrase(61,3,53,67,64)
for i,p in enumerate([63,67,72]): add("lead",LAST,i*80,1500,p,60,False)
# Standard Kit drums: dusty swung 16ths — kick 36, snare 38, rim 37, closed 42, open 46, ride 51, shaker 70, crash 49
KK=[[0,7,10],[0,3,8,11]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,960,36,96);add("drums",b,0,960,49,72);continue
  if s=="Intro":
    for st in range(0,16,2): add("drums",b,st*X,X*0.5,42,36+b*4+(6 if st%4==0 else 0))
    if b>=3:
      add("drums",b,0,X,36,78);add("drums",b,8*X,X,36,70)
    if b==4:
      for st in (12,13,14,15): add("drums",b,st*X,X*0.55,38,55+st*2)
    continue
  thin=(s=="Bridge")
  # closed hats on even 16ths with swing feel via SW on odd
  for st in range(16):
    if st%2==0: add("drums",b,st*X,X*0.45,42,(62 if st%4==0 else 48)+random.randint(-5,5))
  if not thin:
    for st in range(1,16,2):
      if random.random()<0.45: add("drums",b,st*X,X*0.35,70,34+random.randint(-3,4))
  if b%4==0 and not thin: add("drums",b,10*X,X*1.4,46,54)
  if thin:
    add("drums",b,0,X,36,82);add("drums",b,8*X,X,36,70);add("drums",b,12*X,X,37,58)
    for st in (0,4,8,12): add("drums",b,st*X,X*0.5,42,40)
    continue
  for st in KK[b%2]: add("drums",b,st*X,X,36,96 if st==0 else 78)
  add("drums",b,4*X,X,38,88);add("drums",b,12*X,X,38,92)
  if random.random()<0.35: add("drums",b,7*X,X*0.45,37,40)
  if (b-st0)%8==7 and s!="Outro":
    for st in (13,14,15): add("drums",b,st*X,X*0.45,38,52+st*2)
  if b in(5,21,29,41,53,61): add("drums",b,0,960,49,70)
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
# GM: muted trumpet 59, acoustic grand 0, halo pad 94, picked bass 34, standard kit 0 bank 0
TRK={"lead":(0,59,"Muted Trumpet"),"piano":(1,0,"Acoustic Grand Piano"),"pad":(2,94,"Halo Pad"),"bass":(5,34,"Picked Bass"),"drums":(9,0,"Standard Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Cm'),mido.MetaMessage('track_name',name=TITLE)]
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
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title(f'{TITLE} — C minor, {BPM} BPM, late-night jazz-hop');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1);ax.set_ylim(30,95)
plt.tight_layout();plt.savefig(BASE+'_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
