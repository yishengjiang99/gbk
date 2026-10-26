# "Brick Dust Sermon" - original boom-bap hip-hop beat, F minor, 88 BPM (seeded generator)
import json,random,mido
random.seed(1026)
Q=480;X=120;BAR=1920  # X = 16th note
SW=28                 # swing offset for off-beat 16ths
SEC=[("Intro",1,4),("Verse 1",5,16),("Hook",21,8),("Verse 2",29,16),("Hook 2",45,8),("Outro",53,4)]
LAST=56
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n
# chord: (bass root, rhodes voicing)
C={'Fm9':(41,[56,60,63,67]),'Dbmaj9':(37,[53,56,60,63]),'Bbm9':(46,[56,60,61,65]),'C7#9':(36,[52,58,63,64]),
   'Ebadd9':(39,[55,58,63,65]),'Cm7':(36,[55,58,63]),'Abmaj7':(44,[55,60,63,67]),'Gb6':(42,[54,58,61,63]),'Gm7b5':(43,[53,58,61,65])}
VERSE=['Fm9','Fm9','Dbmaj9','C7#9','Fm9','Bbm9','Dbmaj9','C7#9']
HOOK=['Dbmaj9','Ebadd9','Cm7','Fm9','Bbm9','Gb6','Gm7b5','C7#9']
def chord(b):
  s=sec(b)
  if s.startswith("Hook"): return HOOK[(b-21)%8]
  if s=="Outro": return ['Dbmaj9','C7#9','Fm9','Fm9'][b-53]
  return VERSE[(b-1)%8]
tr={k:[] for k in("keys","bass","vibes","strings","drums")}
def add(k,bar,tick,dur,p,v):
  t=int(tick); 
  if (t//X)%2==1: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Rhodes: lazy stabs, rolled slightly
KP=[[(0,6),(7,3),(10,5)],[(0,4),(6,2),(11,5)],[(0,8),(10,2),(14,2)],[(2,6),(10,6)]]
for b in range(1,LAST+1):
  _,vo=C[chord(b)];s=sec(b)
  if b==LAST:
    for i,p in enumerate(vo+[72]): add("keys",b,i*30,1800,p,70)
    continue
  pat=KP[(b-1)%4] if not s.startswith("Hook") else [(0,14)]
  for st,d in pat:
    for i,p in enumerate(vo): add("keys",b,st*X+i*8+random.randint(0,6),d*X*0.92,p,random.randint(52,66))
# Bass (finger electric): syncopated boom-bap line
BP=[[(0,3,0),(3,1,0),(6,2,12),(10,2,0),(14,2,7)],[(0,4,0),(7,1,0),(8,3,0),(12,2,10),(14,2,7)]]
for b in range(5,LAST+1):
  root,_=C[chord(b)];r=root if root<44 else root-12
  if b==LAST: add("bass",b,0,1600,29,100);continue
  if sec(b)=="Outro" and b==55: add("bass",b,0,1600,r,96);continue
  for st,d,iv in BP[b%2]: add("bass",b,st*X,d*X*0.9,r+iv,random.randint(84,96) if st==0 else random.randint(70,86))
# Vibraphone: hook melody (motif + answer), sparse verse fills. F minor pentatonic-ish
SC=[60,63,65,67,68,70,72,75,77,79,80,82,84]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
MOT=[(0,2),(2,2),(4,4),(10,2),(12,4)]
ANS=[(0,3),(3,1),(4,2),(6,2),(8,8)]
def hook(b0,seed,base):
  random.seed(seed);p=base;prev=None
  for i in range(8):
    b=b0+i;_,vo=C[chord(b)];rh=MOT if i%2==0 else ANS
    if i==7: rh=[(0,4),(4,4),(8,8)]
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-3,0,2]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)));idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,1])));p=SC[idx]
      if p==prev: p=SC[max(0,SC.index(p)-1)]
      add("vibes",b,st*X,d*X*0.95,p,random.randint(74,92)+(6 if j==0 else 0));prev=p
hook(21,5,75);hook(45,5,77)
random.seed(31)
for b in range(5,53):
  if sec(b).startswith("Verse") and b%4==0:
    _,vo=C[chord(b)];p=near(72,vo)
    for k,st in enumerate((8,10,12)): add("vibes",b,st*X,X*1.8,SC[max(0,SC.index(p)-k)],random.randint(60,72))
for i,p in enumerate([65,68,72]): add("vibes",LAST,i*40,1700,p,70)
# Strings: long pad in hooks and intro/outro
for b in range(1,LAST+1):
  s=sec(b)
  if not(s.startswith("Hook") or s in("Intro","Outro")): continue
  _,vo=C[chord(b)]
  for p in sorted(set([vo[0]-12+12,vo[1],vo[-1]])): add("strings",b,0,BAR-30,p,58 if s=="Intro" else 66)
# Drums (GM kit): kick 36, snare 38, closed hat 42, open hat 46, crash 49, rim 37, tambourine 54
KK=[[0,7,10],[0,3,8,11]]
for b in range(1,LAST+1):
  s=sec(b)
  if b==LAST: add("drums",b,0,960,36,100);add("drums",b,0,960,49,86);continue
  if s=="Intro":
    if b>=3:
      for st in range(0,16,2): add("drums",b,st*X,X*0.5,42,52+random.randint(-4,4))
    if b==4: add("drums",b,12*X,X,38,70);add("drums",b,14*X,X,38,84)
    continue
  for st in range(16):
    if st%2==0 or random.random()<0.35: add("drums",b,st*X,X*0.5,42,(74 if st%4==0 else 58)+random.randint(-6,6))
  if b%4==0: add("drums",b,14*X,X*1.5,46,70)
  for st in KK[(b+1)%2]: add("drums",b,st*X,X,36,90 if st==0 else 76)
  add("drums",b,4*X,X,38,88);add("drums",b,12*X,X,38,92)
  if random.random()<0.4: add("drums",b,15*X,X*0.5,38,46)
  if s.startswith("Hook"):
    for st in (2,6,10,14): add("drums",b,st*X,X,54,48)
  if b in(5,21,29,45,53): add("drums",b,0,960,49,74)
# remove same-pitch overlaps
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["velocity"]>0 and a["tick"]+a["duration"]>c["tick"]:
      if c["tick"]-a["tick"]<40: c["velocity"]=0 if c["tick"]==a["tick"] else c["velocity"]; a["duration"]=max(20,c["tick"]-a["tick"]-5) if c["velocity"] else a["duration"]
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[k]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
# verify
for k,N in tr.items():
  by={}
  for n in N: by.setdefault(n["pitch"],[]).append(n)
  for p,L in by.items():
    L.sort(key=lambda n:n["tick"])
    for a,c in zip(L,L[1:]): assert a["tick"]+a["duration"]<=c["tick"],(k,p,a,c)
json.dump(tr,open("plan.json","w"))
TRK={"keys":(0,4,"Rhodes"),"bass":(1,33,"Finger Bass"),"vibes":(2,11,"Vibraphone"),"strings":(3,48,"Strings"),"drums":(9,0,"Boom-Bap Kit")}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(88)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Fm'),mido.MetaMessage('track_name',name='Brick Dust Sermon')]
for k,(ch,prog,nm) in TRK.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
  if ch!=9: t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save("brick_dust_sermon.mid")
# pianoroll
import matplotlib;matplotlib.use('Agg');import matplotlib.pyplot as plt
fig,ax=plt.subplots(figsize=(22,9));cols=plt.cm.tab10.colors
for i,(k,(ch,prog,nm)) in enumerate(TRK.items()):
  for n in tr[k]: ax.broken_barh([(n['tick']/BAR+1,n['duration']/BAR)],(n['pitch']-.4,.8),color=cols[i])
  ax.plot([],[],color=cols[i],lw=6,label=f"{nm} (ch{ch+1}, GM {prog})")
for n,s,l in SEC: ax.axvline(s,color='k',ls='--',lw=.8);ax.text(s+.1,100,n)
ax.set_xlabel('Bar');ax.set_ylabel('MIDI pitch');ax.set_title('Brick Dust Sermon — F minor, 88 BPM, boom-bap');ax.legend(loc='lower right',fontsize=8);ax.set_xlim(1,LAST+1)
plt.tight_layout();plt.savefig('brick_dust_sermon_pianoroll.png',dpi=90)
print({k:len(v) for k,v in tr.items()}, round(mf.length,2))
