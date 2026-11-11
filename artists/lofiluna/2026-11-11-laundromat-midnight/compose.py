# "Laundromat Midnight" - original late-night lo-fi, B minor, 73 BPM
# Palette: soft Acoustic Grand Piano (GM 0), Slow Strings (GM 49), Fretless Bass (GM 35),
# Jazz Guitar lead (GM 26), Celesta sparkle (GM 8), standard kit. Heavy lazy swing ~60%.
import json,random,mido,sys
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1111)
Q=480;X=120;BAR=1920
SW=28
TITLE="Laundromat Midnight";BASE="laundromat_midnight";BPM=73
SEC=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,12),("Outro",49,4)]
LAST=52
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
  return "Outro",49
C={
  'Bm9':(35,[57,61,62,66]),
  'Gmaj9':(31,[54,57,59,62]),
  'Em9':(40,[55,59,62,66]),
  'F#7b13':(42,[52,58,61,62]),
  'Dmaj9':(38,[54,57,61,64]),
  'A13':(33,[55,59,61,66]),
  'F#m7':(42,[52,57,61,66]),
  'A7':(33,[55,57,61,64]),
  'F#7alt':(42,[52,58,62,67]),
}
Aprog=['Bm9','Gmaj9','Em9','F#7b13']
Bprog=['Dmaj9','A13','Gmaj9','F#m7','Em9','A7','F#7alt','Bm9']
def chord(b):
  s,st=sec(b)
  if s=="B": return Bprog[(b-st)%8]
  if s=="Outro": return ['Bm9','Gmaj9','Em9','Bm9'][b-st]
  if s=="Intro": return Aprog[b-st]
  return Aprog[(b-st)%4]
tr={k:[] for k in("piano","strings","bass","guitar","celesta","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and (t//X)%2==1 and t%X==0: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=p,velocity=max(1,min(127,int(v)))))
# Slow strings: bar-long chord bed, swell in B
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v={"Intro":48 if b==1 else 54,"Outro":42,"B":62}.get(s,48)
  if V>=2 and s=="Intro": v+=6
  if V>=2 and s=="B": v+=(4 if V==2 else 10)
  for p in vo[1:]: add("strings",b,0,BAR-40 if b<LAST else 1800,p,v,False)
# Piano: rolled chord on 1, lazy re-hit on and-of-2, soft top note on 4
for b in range(1,LAST):
  s,_=sec(b);_,vo=C[chord(b)]
  if s=="Outro":
    for i,p in enumerate(vo): add("piano",b,i*25,X*10,p,46,False)
    continue
  base=60 if s!="B" else (68 if V==1 else 73 if V==2 else 78)
  if s=="Intro": base=58 if V==1 else 64 if V==2 else 70
  for i,p in enumerate(vo): add("piano",b,i*22,X*5,p,base+random.randint(-3,3),False)
  for p in vo[1:]: add("piano",b,5*X,X*2.6,p,base-10+random.randint(-3,3))
  add("piano",b,12*X,X*3,vo[-1]+12 if vo[-1]+12<=80 else vo[-1],base-14+random.randint(-2,2))
# Fretless bass: long slides, root/fifth
for b in range(1,LAST+1):
  root,_=C[chord(b)];s,_=sec(b)
  if b==LAST: add("bass",b,0,1600,35,78);continue
  if s=="Intro":
    if b>=(2 if V>=3 else 3): add("bass",b,0,X*14,root,(78 if V>=3 else 72))
    continue
  if s=="Outro": add("bass",b,0,X*12,root,70);continue
  add("bass",b,0,X*7,root,84+random.randint(-3,3))
  add("bass",b,7*X,X*2,root+7 if root+7<=50 else root-5,70+random.randint(-3,3))
  add("bass",b,10*X,X*4,root+12 if root+12<=52 else root,66+random.randint(-3,3))
  nxt,_=C[chord(min(b+1,LAST))]
  if nxt!=root: add("bass",b,15*X,X*0.8,nxt+1 if nxt<root else nxt-1,64)
# Jazz guitar lead over B natural minor
SC=[59,61,62,64,66,67,69,71,73,74,76,78,79]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]] or SC
  return min(c,key=lambda q:abs(q-p))
R1=[(1,2),(4,2),(7,1),(8,6)]
R2=[(0,2),(3,1),(4,3),(10,2),(13,3)]
END=[(0,12)]
def phrase(b0,n,seed,base,vel):
  random.seed(seed);p=base;prev=None
  for i in range(n):
    b=b0+i
    if b>LAST: break
    _,vo=C[chord(b)]
    if i%4==3 and i!=n-1: continue  # breathing room
    rh=END if i==n-1 else (R1 if i%2==0 else R2)
    for j,(st,d) in enumerate(rh):
      if j==0 or d>=6: p=near(p+random.choice([-2,0,2]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)))
        idx=max(0,min(len(SC)-1,idx+random.choice([-1,1,-2,1,2])));p=SC[idx]
      if p==prev: p=SC[min(len(SC)-1,SC.index(p)+1)]
      add("guitar",b,st*X,d*X*0.9,p,vel+random.randint(-4,4))
      prev=p
phrase(9,8,31,66,(70 if V==1 else 74))
phrase(21,8,37,71,78)
phrase(29,8,53,69,76)
phrase(37,8,31,66,72)
phrase(49,3,59,62,58)
for i,p in enumerate([59,62,66]): add("guitar",LAST,i*60,1400,p,54,False)
# Celesta: small sparkles (intro, B, outro)
for b in range(1,LAST):
  s,_=sec(b);_,vo=C[chord(b)]
  if s in("Intro","B","Outro") and b%2==0:
    add("celesta",b,14*X,X*2,vo[-1]+12,(44 if V==1 else 50)+random.randint(-3,3))
    add("celesta",b,15*X,X*3,vo[-2]+12,(38 if V==1 else 44)+random.randint(-3,3))
# Drums: kick 36, snare 38, side-stick 37, closed hat 42, pedal hat 44, ride 51, crash 49
KK=[[0,10],[0,6,10],[0,10,15],[0,7]]
for b in range(1,LAST+1):
  s,st0=sec(b)
  if b==LAST: add("drums",b,0,800,36,70);add("drums",b,0,800,49,44);continue
  if s=="Intro":
    if b>=2:
      for st in range(0,16,2): add("drums",b,st*X,X*0.4,42,34+b*4+(8 if V>=2 else 0))
    if b>=(2 if V>=3 else 3): add("drums",b,0,X,36,64);add("drums",b,12*X,X,37,50)
    continue
  if s=="Outro":
    add("drums",b,0,X,36,58);add("drums",b,12*X,X,37,46)
    for st in (0,4,8,12): add("drums",b,st*X,X*0.4,44,34)
    continue
  hat=51 if s=="B" else 42
  for st in range(0,16,2):
    add("drums",b,st*X,X*0.5,hat,(54 if st%4==0 else 40)+random.randint(-4,4)+(5 if V>=2 and s=="B" else 0))
  for st in KK[(b-st0)%4]: add("drums",b,st*X,X,36,(82 if st==0 else 64)+random.randint(-3,3))
  sn=38 if s=="B" else 37
  add("drums",b,4*X,X,sn,(70+(6 if V>=3 else 0) if s=="B" else 62)+random.randint(-2,2))
  add("drums",b,12*X,X,sn,(74+(6 if V>=3 else 0) if s=="B" else 66)+random.randint(-2,2))
  if random.random()<0.35: add("drums",b,11*X,X*0.4,38,30)  # ghost
  if (b-st0)%8==7:
    for st in (13,14,15): add("drums",b,st*X,X*0.4,sn,44+st)
  if b in(5,21,37): add("drums",b,0,600,49,50)
# de-overlap same pitch
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
TRK={"piano":(0,0,"Soft Piano"),"strings":(1,49,"Slow Strings"),"bass":(2,35,"Fretless Bass"),"guitar":(3,26,"Jazz Guitar"),"celesta":(4,8,"Celesta"),"drums":(9,0,"Standard Kit")}
json.dump(TRK,open("tracks.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Bm'),mido.MetaMessage('track_name',name=TITLE)]
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
