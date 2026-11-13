# "Persimmon Porch" - original autumn-afternoon lo-fi, Db major, 77 BPM
# Palette: Rhodes (GM 4), Warm Pad (GM 89), Acoustic Bass (GM 32), Vibraphone lead (GM 11),
# Nylon Guitar arps (GM 24), standard kit with shaker. Medium swing ~58%.
import json,random,mido,sys
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1313)
Q=480;X=120;BAR=1920
SW=22
TITLE="Persimmon Porch";BASE="persimmon_porch";BPM=77
SEC=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,16),("Outro",53,4)]
LAST=56
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
  return "Outro",53
C={
  'Dbmaj9':(37,[53,56,60,63]),
  'Fm7':(41,[56,60,63,65]),
  'Gbmaj9':(42,[53,56,58,61]),
  'Ab9sus':(44,[54,58,61,63]),
  'Bbm9':(34,[53,56,60,61]),
  'Ebm9':(39,[54,58,61,65]),
  'Ab13':(44,[54,58,60,65]),
  'F7alt':(41,[51,57,61,66]),
}
Aprog=['Dbmaj9','Fm7','Gbmaj9','Ab9sus']
Bprog=['Bbm9','Ebm9','Ab13','Dbmaj9','Gbmaj9','F7alt','Bbm9','Ab9sus']
def chord(b):
  s,st=sec(b)
  if s=="B": return Bprog[(b-st)%8]
  if s=="Outro": return ['Gbmaj9','Ab9sus','Gbmaj9','Dbmaj9'][b-st]
  if s=="Intro": return ['Gbmaj9','Fm7','Ebm9','Ab9sus'][b-st]
  return Aprog[(b-st)%4]
tr={k:[] for k in("rhodes","pad","bass","vibes","nylon","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Warm pad bed
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v={"Intro":56,"Outro":(46 if V==1 else 56),"B":58}.get(s,44)+((6 if V==2 else 14) if V>=2 and s=="Intro" else 0)
  for p in vo[:3]: add("pad",b,0,BAR-40 if b<LAST else 1800,p,v,False)
# Rhodes: anticipated comping - hit on and-of-4 of previous bar, short stab on 2-and
for b in range(1,LAST):
  s,_=sec(b);_,vo=C[chord(b)]
  if s=="Outro":
    for i,p in enumerate(vo): add("rhodes",b,i*30,X*12,p,(52 if V==1 else 62),False)
    continue
  base={"Intro":(60 if V==1 else 68 if V==2 else 76),"B":(70 if V==1 else 74)}.get(s,64)
  for i,p in enumerate(vo): add("rhodes",b,i*12,X*3.5,p,base+random.randint(-3,3),False)
  for p in vo: add("rhodes",b,6*X,X*1.4,p,base-8+random.randint(-3,3))
  if b<LAST-5:
    _,nv=C[chord(b+1)]
    for p in nv[1:]: add("rhodes",b,14*X,X*1.6,p,base-6+random.randint(-3,3))
# Acoustic bass: walking-ish two-feel
SCB=[37,39,41,42,44,46,48,49,51]
for b in range(1,LAST+1):
  root,_=C[chord(b)];s,_=sec(b)
  if b==LAST: add("bass",b,0,1600,37,80);continue
  if s=="Intro":
    if b>=(2 if V>=2 else 3): add("bass",b,0,X*7,root,76);add("bass",b,8*X,X*6,root+7 if root+7<=51 else root-5,68)
    continue
  if s=="Outro": add("bass",b,0,X*12,root,(72 if V==1 else 80));continue
  add("bass",b,0,X*5,root,86+random.randint(-3,3))
  add("bass",b,6*X,X*2,root+7 if root+7<=51 else root-5,72+random.randint(-3,3))
  add("bass",b,8*X,X*4,root+(12 if root<=39 else 0),74+random.randint(-3,3))
  nxt,_=C[chord(min(b+1,LAST))]
  ap=nxt-1 if nxt>root else nxt+2
  add("bass",b,14*X,X*1.6,ap,66)
# Vibraphone lead over Db major pentatonic-leaning scale
SC=[61,63,65,68,70,72,73,75,77,80]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
R1=[(0,3),(3,1),(4,4),(10,1),(11,5)]
R2=[(2,2),(4,2),(6,6),(14,2)]
END=[(0,10)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i
    if b>LAST: break
    _,vo=C[chord(b)]
    if i%4==3 and i!=n-1: continue
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0 or d>=5: p=near(p+random.choice([-3,0,3]),vo+[vo[0]+12])
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)))
        idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-1,2])));p=SC[idx]
      if p==prev: p=SC[max(0,SC.index(p)-1)]
      add("vibes",b,st*X,d*X*0.95,p,vel+random.randint(-4,4))
      prev=p
phrase(9,8,71,68,(68 if V==1 else 72))
phrase(21,8,73,73,76)
phrase(29,8,79,72,74)
phrase(41,8,71,68,70)
phrase(49,4,83,70,66)
for i,p in enumerate([65,68,73]): add("vibes",LAST,i*80,1500,p,56,False)
# Nylon guitar: gentle 8th arpeggio in B and A2 second half
for b in range(1,LAST):
  s,st=sec(b);_,vo=C[chord(b)]
  if s=="B" or (s=="A2" and b-st>=8):
    pat=[vo[0],vo[2],vo[1],vo[3],vo[2],vo[1]]
    for i,st8 in enumerate((0,3,4,6,8,11)):
      add("nylon",b,st8*X*1,X*2.2,pat[i]+12 if pat[i]<56 else pat[i],(50 if V==1 else 56)+random.randint(-4,4))
# Drums: kick 36, snare 38, side-stick 37, closed hat 42, shaker 70, crash 49, open hat 46
KK=[[0,7,10],[0,10],[0,3,10],[0,10,14]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,800,36,70);add("drums",b,0,800,49,42);continue
  if s=="Intro":
    if b>=2:
      for st in range(0,16,2): add("drums",b,st*X,X*0.3,70,36+b*4+(6 if V==2 else 12 if V>=3 else 0))
    if b>=(3 if V==1 else 2): add("drums",b,0,X,36,66);add("drums",b,12*X,X,37,52)
    continue
  if s=="Outro":
    add("drums",b,0,X,36,58);add("drums",b,12*X,X,37,46)
    for st in range(0,16,4): add("drums",b,st*X,X*0.3,70,36)
    continue
  for st in range(0,16,2):
    add("drums",b,st*X,X*0.4,70 if s!="B" else 42,(52 if st%4==0 else 40)+random.randint(-4,4)+(5 if V>=2 and s=="B" else 0))
  if s=="B" and (b-st0)%2==1: add("drums",b,14*X,X*0.8,46,44)
  for st in KK[(b-st0)%4]: add("drums",b,st*X,X,36,(84 if st==0 else 66)+random.randint(-3,3))
  sn=38 if s=="B" else 37
  add("drums",b,4*X,X,sn,(72+(4 if V>=3 else 0) if s=="B" else 64)+random.randint(-2,2))
  add("drums",b,12*X,X,sn,(76+(4 if V>=3 else 0) if s=="B" else 68)+random.randint(-2,2))
  if random.random()<0.3: add("drums",b,7*X,X*0.4,38,28)
  if (b-st0)%8==7:
    for st in (13,14,15): add("drums",b,st*X,X*0.4,sn,44+st)
  if b in(5,21,37): add("drums",b,0,600,49,48)
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
TRK={"rhodes":(0,4,"Rhodes"),"pad":(1,89,"Warm Pad"),"bass":(2,32,"Acoustic Bass"),"vibes":(3,11,"Vibraphone"),"nylon":(4,24,"Nylon Guitar"),"drums":(9,0,"Standard Kit")}
json.dump(TRK,open("tracks.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Db'),mido.MetaMessage('track_name',name=TITLE)]
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
