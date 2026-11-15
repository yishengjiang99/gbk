# "Sunday Rain" - original rainy-Sunday lo-fi, D minor, 82 BPM
# Palette: EP2 (GM 5), Warm Pad (GM 89), Fingered Bass (GM 33), Muted Trumpet lead (GM 59),
# Celesta (GM 8) sparkle, Seashore (GM 122) as soft rain, standard kit. Light swing ~56%.
import json,random,mido,sys
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1511)
Q=480;X=120;BAR=1920
SW=16
TITLE="Sunday Rain";BASE="sunday_rain";BPM=82
SEC=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,16),("Outro",53,4)]
LAST=56
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
  return "Outro",53
C={
  'Dm9':(38,[53,57,60,64]),
  'Gm9':(43,[53,57,58,62]),
  'Bbmaj7':(46,[57,58,62,65]),
  'A7sus':(45,[55,59,62,64]),
  'Fmaj9':(41,[52,55,57,60]),
  'C9':(36,[52,55,58,62]),
  'Em7b5':(40,[50,55,58,64]),
  'A7b9':(45,[55,58,61,64]),
}
Aprog=['Dm9','Gm9','Bbmaj7','A7sus']
Bprog=['Fmaj9','C9','Bbmaj7','A7sus','Gm9','Em7b5','A7b9','Dm9']
def chord(b):
  s,st=sec(b)
  if s=="B": return Bprog[(b-st)%8]
  if s=="Outro": return ['Gm9','A7sus','Bbmaj7','Dm9'][b-st]
  if s=="Intro": return ['Bbmaj7','A7sus','Dm9','A7sus'][b-st]
  return Aprog[(b-st)%4]
tr={k:[] for k in("keys","pad","bass","horn","bell","rain","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Rain bed: Seashore held 4 bars at a time, low
for b in range(1,LAST+1,4):
  add("rain",b,0,BAR*4-60,60,(40 if V==1 else 34) if b<53 else 30,False)
# Pad
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v={"Intro":(54 if V==1 else 62),"Outro":(50 if V==1 else 60),"B":56}.get(s,44)
  for p in vo[:3]: add("pad",b,0,BAR-40 if b<LAST else 1800,p,v,False)
# EP: rolled downbeat, soft stab on beat 3-and, little pickup on 4-and every other bar
for b in range(1,LAST+1):
  s,st=sec(b);_,vo=C[chord(b)]
  base={"Intro":(62 if V==1 else 70),"B":(70 if V==1 else 75),"Outro":(56 if V==1 else 64)}.get(s,64)
  if s=="Outro" or b==LAST:
    for i,p in enumerate(vo): add("keys",b,i*40,X*14 if b<LAST else 1700,p,base,False)
    continue
  for i,p in enumerate(vo): add("keys",b,i*18,X*5,p,base+random.randint(-3,3),False)
  for p in vo[1:]: add("keys",b,9*X,X*1.5,p,base-10+random.randint(-3,3))
  if (b-st)%2==1:
    for p in vo[2:]: add("keys",b,14*X,X*1.4,p+0,base-12+random.randint(-3,3))
# Fingered bass: syncopated
for b in range(1,LAST+1):
  root,_=C[chord(b)];s,_=sec(b)
  if b==LAST: add("bass",b,0,1600,38,80);continue
  if s=="Intro":
    if b>=(3 if V==1 else 2): add("bass",b,0,X*6,root,76);add("bass",b,10*X,X*4,root,64)
    continue
  if s=="Outro": add("bass",b,0,X*12,root,(72 if V==1 else 80));continue
  add("bass",b,0,X*3.5,root,88+random.randint(-3,3))
  add("bass",b,6*X,X*1.5,root+12 if root<=40 else root-12+12,70+random.randint(-3,3))
  add("bass",b,10*X,X*2.5,root+7 if root+7<=52 else root-5,74+random.randint(-3,3))
  nxt,_=C[chord(min(b+1,LAST))]
  ap=nxt+1 if nxt<root else nxt-1
  add("bass",b,14*X,X*1.6,ap,64)
# Muted trumpet lead, D minor
SC=[62,64,65,67,69,70,72,74,76,77]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
R1=[(1,2),(3,1),(4,6),(12,2),(14,2)]
R2=[(0,4),(6,2),(8,6)]
END=[(0,12)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i
    if b>LAST: break
    _,vo=C[chord(b)]
    if i%4==3 and i!=n-1: continue
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0 or d>=6: p=near(p+random.choice([-2,0,2]),vo+[vo[0]+12])
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)))
        idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-1,-2])));p=SC[idx]
      if p==prev: p=SC[max(0,SC.index(p)-1)]
      add("horn",b,st*X,d*X*0.92,p,vel+random.randint(-4,4))
      prev=p
hv=(72 if V==1 else 76)
phrase(9,8,21,69,hv)
phrase(25,8,23,72,hv+4)
phrase(41,8,21,69,hv)
phrase(49,4,29,67,hv-6)
# Celesta sparkle in B and late A2: three falling chord tones on beat 2-3, every other bar
for b in range(1,LAST):
  s,st=sec(b);_,vo=C[chord(b)]
  if (s=="B" or (s=="A2" and b-st>=8)) and (b-st)%2==0:
    ts=sorted(set(vo[1:]),reverse=True)
    for i,p in enumerate(ts[:3]): add("bell",b,(4+i*2)*X,X*3,p+12,(48 if V==1 else 54)+random.randint(-3,3))
for i,p in enumerate([74,77,81]): add("bell",LAST,i*90,1400,p,46,False)
# Drums: kick 36, snare 38, rim 37, closed hat 42, open hat 46, crash 49
KK=[[0,10],[0,6,10],[0,10,15],[0,7,10]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,800,36,68);add("drums",b,0,800,49,40);continue
  if s=="Intro":
    if b>=(3 if V==1 else 2):
      for st in range(0,16,2): add("drums",b,st*X,X*0.3,42,34+b*3)
    if b>=3: add("drums",b,0,X,36,64);add("drums",b,12*X,X,37,50)
    continue
  if s=="Outro":
    add("drums",b,0,X,36,56);add("drums",b,12*X,X,37,44)
    continue
  for st in range(0,16,2):
    add("drums",b,st*X,X*0.4,42,(50 if st%4==0 else 38)+random.randint(-4,4))
  if s=="B":
    for st in (3,11):
      if random.random()<0.5: add("drums",b,st*X,X*0.3,42,26)
  if (b-st0)%4==3: add("drums",b,14*X,X*0.8,46,42)
  for st in KK[(b-st0)%4]: add("drums",b,st*X,X,36,(84 if st==0 else 68)+random.randint(-3,3))
  sn=38 if s in("B","A2") else 37
  add("drums",b,4*X,X,sn,(72 if sn==38 else 64)+random.randint(-2,2))
  add("drums",b,12*X,X,sn,(76 if sn==38 else 68)+random.randint(-2,2))
  if random.random()<0.25: add("drums",b,15*X,X*0.4,38,26)
  if (b-st0)%8==7:
    for st in (13,14,15): add("drums",b,st*X,X*0.4,sn,44+st)
  if b in(5,21,37): add("drums",b,0,600,49,46)
for k,N in tr.items():
  by={}
  for n in N: by.setdefault(n["pitch"],[]).append(n)
  keep=[]
  for p,L in by.items():
    L.sort(key=lambda n:n["tick"]);out=[]
    for n in L:
      if out and n["tick"]-out[-1]["tick"]<30: continue
      if out and out[-1]["tick"]+out[-1]["duration"]>n["tick"]: out[-1]["duration"]=max(20,n["tick"]-out[-1]["tick"]-6)
      out.append(n)
    keep+=out
  tr[k]=sorted(keep,key=lambda n:(n["tick"],n["pitch"]))
for N in tr.values():
  for n in N: n["duration"]=min(n["duration"],BAR*4)
json.dump(tr,open("plan.json","w"))
TRK={"keys":(0,5,"Electric Piano"),"pad":(1,89,"Warm Pad"),"bass":(2,33,"Finger Bass"),"horn":(3,59,"Muted Trumpet"),"bell":(4,8,"Celesta"),"rain":(5,122,"Rain"),"drums":(9,0,"Standard Kit")}
json.dump(TRK,open("tracks.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Dm'),mido.MetaMessage('track_name',name=TITLE)]
for k,(ch,prog,nm) in TRK.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
  t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]:
    ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(BASE+".mid")
print({k:len(v) for k,v in tr.items()},"len_sec",round(mf.length,2),"maxdur",max(n["duration"] for k,N in tr.items() if k!="rain" for n in N))
