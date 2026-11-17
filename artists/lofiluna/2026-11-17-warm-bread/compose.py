# "Warm Bread" - original morning-kitchen lo-fi, F major, 85 BPM
# Palette: soft piano (GM 0), Choir Aahs pad (GM 52), Picked Bass (GM 34), Kalimba lead (GM 108),
# Bird Tweet (GM 123) as a light morning layer, standard kit with tambourine. Light swing ~55%.
import json,random,mido,sys
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1711)
Q=480;X=120;BAR=1920
SW=14
TITLE="Warm Bread";BASE="warm_bread";BPM=85
SEC=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,16),("Outro",53,4)]
LAST=56
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
  return "Outro",53
C={
  'Fmaj9':(41,[57,60,64,67]),
  'A7b13':(45,[55,59,61,65]),
  'Dm9':(38,[53,57,60,64]),
  'Bbm6':(46,[53,55,58,61]),
  'Gm7':(43,[53,58,62,65]),
  'C13':(36,[52,57,58,62]),
  'Am7':(45,[55,60,64,67]),
  'D7b9':(38,[54,57,60,63]),
  'Gm9':(43,[53,57,58,62]),
  'Bbmaj9':(46,[57,60,62,65]),
  'C7sus':(36,[53,55,58,62]),
}
ALT={'A7b13','Bbm6','D7b9'}
Aprog=['Fmaj9','A7b13','Dm9','Bbm6']
Bprog=['Gm7','C13','Am7','D7b9','Gm9','Bbm6','Fmaj9','C7sus']
def chord(b):
  s,st=sec(b)
  if s=="B": return Bprog[(b-st)%8]
  if s=="Outro": return ['Bbmaj9','Bbm6','Fmaj9','Fmaj9'][b-st]
  if s=="Intro": return ['Bbmaj9','Bbm6','Fmaj9','C7sus'][b-st]
  return Aprog[(b-st)%4]
tr={k:[] for k in("keys","pad","bass","lead","birds","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Choir pad: top three tones, soft
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v={"Intro":(52 if V==1 else 70),"Outro":(50 if V==1 else 68),"B":(50 if V==1 else 58)}.get(s,42)
  for p in vo[1:]: add("pad",b,0,BAR-40 if b<LAST else 1800,p,v,False)
# Piano: block chord on 1, broken chord tones rising on 2-and, 3, 3-and; B adds a 4-and push
for b in range(1,LAST+1):
  s,st=sec(b);_,vo=C[chord(b)]
  base={"Intro":(60 if V==1 else 74),"B":(66 if V==1 else 72),"Outro":(56 if V==1 else 72)}.get(s,62)
  if s=="Outro" or b==LAST:
    for i,p in enumerate(vo): add("keys",b,i*30,X*14 if b<LAST else 1700,p,base,False)
    continue
  for i,p in enumerate(vo): add("keys",b,i*(1 if V==1 else 16),X*5,p,base-(0 if V==1 else 4)+random.randint(-3,3),False)
  for i,stp in enumerate((6,8,10)): add("keys",b,stp*X,X*2,vo[i+1]+12,base-12+random.randint(-3,3))
  if s=="B" and (b-st)%2==1:
    for p in vo[1:3]: add("keys",b,14*X,X*1.5,p,base-14+random.randint(-3,3))
# Picked bass: root on 1, fifth on 2-and, root on 3, walk-up into next bar
for b in range(1,LAST+1):
  root,_=C[chord(b)];s,_=sec(b)
  if b==LAST: add("bass",b,0,1600,41,78);continue
  if s=="Intro":
    if b>=2: add("bass",b,0,X*7,root,(70 if V==1 else 82));add("bass",b,8*X,X*6,root,(62 if V==1 else 70))
    continue
  if s=="Outro": add("bass",b,0,X*12,root,(70 if V==1 else 84));continue
  add("bass",b,0,X*3,root,86+random.randint(-3,3))
  add("bass",b,6*X,X*1.5,root+7,68+random.randint(-3,3))
  add("bass",b,8*X,X*3,root,78+random.randint(-3,3))
  nxt,_=C[chord(min(b+1,LAST))]
  ap=nxt-2 if nxt-2>=33 else nxt+2
  add("bass",b,12*X,X*1.5,root+12 if root<=40 else root-5,62)
  add("bass",b,14*X,X*1.6,ap,64)
# Kalimba lead, F major
SC=[72,74,76,77,79,81,82,84,86,88,89]
def pool(ch):
  _,vo=C[ch];pcs={t%12 for t in vo}
  if ch in ALT: return [q for q in range(70,92) if q%12 in pcs]
  return SC
def near(p,ch):
  _,vo=C[ch];pcs={t%12 for t in vo}
  c=[q for q in range(70,92) if q%12 in pcs]
  return min(c,key=lambda q:abs(q-p))
R1=[(0,2),(2,2),(6,2),(8,4),(14,2)]
R2=[(0,3),(4,2),(8,2),(10,4)]
END=[(0,4),(4,10)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i
    if b>LAST: break
    ch=chord(b);P=pool(ch)
    if i%4==3 and i!=n-1:
      add("lead",b,0,X*3,near(p,ch),vel-10);continue
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0 or d>=4: p=near(p+random.choice([-2,0,2,3]),ch)
      else:
        idx=P.index(min(P,key=lambda q:abs(q-p)))
        idx=max(0,min(len(P)-1,idx+random.choice([1,-1,1,-2])));p=P[idx]
      if p==prev: p=P[max(0,P.index(min(P,key=lambda q:abs(q-p)))-1)]
      add("lead",b,st*X,d*X*0.9,p,vel+random.randint(-4,4))
      prev=p
lv=(74 if V==1 else 80)
phrase(9,8,31,76,lv)
phrase(25,8,37,81,lv+4)
phrase(41,8,31,76,lv)
phrase(49,4,41,79,lv-6)
for i,p in enumerate([77,81,84]): add("lead",LAST,i*120,1600,p,58,False)
# Birds: short soft chirps, intro/outro and every 4th bar of A
for b in range(1,LAST+1):
  s,st=sec(b)
  if s in("Intro","Outro") or (s in("A","A2") and (b-st)%4==0):
    add("birds",b,random.choice([2,6,10])*X,X*2,random.choice([84,88,91]),(36 if V==1 else 30),False)
# Drums: kick 36, snare 38, rim 37, closed hat 42, open hat 46, tambourine 54, crash 49
KK=[[0,7,10],[0,10],[0,7,10],[0,10,13]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,800,36,66);add("drums",b,0,800,49,38);continue
  if s=="Intro":
    if b>=2:
      for st in range(0,16,2): add("drums",b,st*X,X*0.3,42,(36 if V==1 else 42)+b*3)
      add("drums",b,0,X,36,(62 if V==1 else 66));add("drums",b,12*X,X,37,(48 if V==1 else 54))
    continue
  if s=="Outro":
    add("drums",b,0,X,36,56);add("drums",b,12*X,X,37,44)
    for st in range(0,16,(4 if V==1 else 2)): add("drums",b,st*X,X*0.3,42,(34 if V==1 else 40))
    continue
  for st in range(0,16,2):
    add("drums",b,st*X,X*0.4,42,(48 if st%4==0 else 36)+random.randint(-4,4))
  if (b-st0)%4==3: add("drums",b,14*X,X*0.8,46,40)
  for st in KK[(b-st0)%4]: add("drums",b,st*X,X,36,((84 if V==1 else 78) if st==0 else (66 if V==1 else 62))+random.randint(-3,3))
  sn=38 if s in("B","A2") else 37
  add("drums",b,4*X,X,sn,(70 if sn==38 else 62)+random.randint(-2,2))
  add("drums",b,12*X,X,sn,(74 if sn==38 else 66)+random.randint(-2,2))
  if s=="B":
    for st in (4,12): add("drums",b,st*X,X*0.5,54,(40 if V==1 else 46)+random.randint(-3,3))
  if random.random()<0.2: add("drums",b,15*X,X*0.4,38,24)
  if (b-st0)%8==7:
    for st in (13,14,15): add("drums",b,st*X,X*0.4,sn,42+st)
  if b in(5,21,37): add("drums",b,0,600,49,44)
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
  for n in N: n["duration"]=min(n["duration"],BAR*2)
json.dump(tr,open("plan.json","w"))
TRK={"keys":(0,0,"Soft Piano"),"pad":(1,52,"Choir Pad"),"bass":(2,34,"Picked Bass"),"lead":(3,108,"Kalimba"),"birds":(4,123,"Birds"),"drums":(9,0,"Standard Kit")}
json.dump(TRK,open("tracks.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='F'),mido.MetaMessage('track_name',name=TITLE)]
for k,(ch,prog,nm) in TRK.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
  t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]:
    ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(BASE+".mid")
print({k:len(v) for k,v in tr.items()},"len_sec",round(mf.length,2),"maxdur",max(n["duration"] for N in tr.values() for n in N))
