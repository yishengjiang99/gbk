import json,random,mido
random.seed(1025)
Q=480;S=240;BAR=1920  # S = 8th note
SEC=[("Intro",1,4),("A",5,16),("B",21,16),("A reprise",37,16),("Coda",53,8)]
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n
# chords: (bass root, guitar voicing, melody chord tones)
C={'Am9':(45,[57,60,64,67,71]),'Dm9':(50,[53,57,60,64]),'G13':(43,[53,59,64]),'Cmaj7':(48,[55,59,64]),
   'Fmaj7':(41,[57,60,64]),'Bm7b5':(47,[57,62,65]),'E7b9':(40,[56,62,65]),'Em7':(52,[55,59,62]),
   'A7':(45,[55,61,64]),'Dm7':(50,[53,57,60]),'Gm7':(43,[53,58,62]),'C7':(48,[52,58,62])}
PA=['Am9','Dm9','G13','Cmaj7','Fmaj7','Bm7b5','E7b9','Am9']
PB=['Dm7','G13','Cmaj7','A7','Dm9','Gm7','C7','Fmaj7','Bm7b5','E7b9','Am9','A7','Dm9','E7b9','Am9','E7b9']
def chord(b):
  s=sec(b)
  if s=="B": return PB[(b-21)%16]
  if s=="Coda": return ['Am9','Dm9','Bm7b5','E7b9','Am9','Fmaj7','E7b9','Am9'][b-53]
  return PA[(b-1)%8]
tr={k:[] for k in("gtr","bass","flute","drums")}
def add(k,bar,tick,dur,p,v): tr[k].append(dict(tick=(bar-1)*BAR+int(tick),duration=int(dur),pitch=p,velocity=max(1,min(127,v))))
# guitar bossa comp (8th positions), thumb on bass
GP=[(0,1.5),(1.5,1),(3,1),(5,1.5),(6.5,1.5)]
for b in range(1,61):
  root,vo=C[chord(b)];last=b==60
  if last:
    for i,p in enumerate([45,52]+[57,60,64,67,71]): add("gtr",b,i*40,1800,p,80)
    continue
  add("gtr",b,0,S*1.8,root if root<50 else root-12,78); add("gtr",b,4*S,S*1.8,(root if root<50 else root-12)+7,72)
  for st,d in (GP if b%2 else [(1,1),(2.5,1),(4,1.5),(6,1)]):
    for p in vo: add("gtr",b,st*S+random.randint(0,15),d*S*0.9,p,random.randint(58,72))
# bass (acoustic): root-fifth two-feel
for b in range(5,61):
  root,_=C[chord(b)];r=root-12 if root>=48 else root
  if b==60: add("bass",b,0,1800,33,100);continue
  add("bass",b,0,S*2.8,r,96); add("bass",b,3*S,S*0.9,r+7,80); add("bass",b,4*S,S*2.8,r+7 if b%2 else r+12,90); add("bass",b,7*S,S*0.9,r+(5 if b%4==2 else 2),70)
# flute melody: motif-based, A minor scale
SC=[57,59,60,62,64,65,67,69,71,72,74,76,77,79,81]
RH=[[(0,3),(3,1),(4,2),(6,2)],[(1,2),(3,3),(6,2)],[(0,2),(2,1),(3,1),(4,4)],[(0,6),(6,2)]]
def near(p,tones):
  c=[q for q in SC if q%12 in [t%12 for t in tones]]
  return min(c,key=lambda q:abs(q-p))
def phrase(b0,n,base,ornate):
  p=base;prev=None
  for i in range(n):
    b=b0+i;_,vo=C[chord(b)];rh=RH[(i+(1 if ornate else 0))%4] if i%4!=3 else [(0,6)]
    for j,(st,d) in enumerate(rh):
      if j==0: p=near(p+random.choice([-2,0,2,3]),vo)
      else:
        idx=SC.index(min(SC,key=lambda q:abs(q-p)));idx=max(1,min(len(SC)-2,idx+random.choice([-2,-1,1,1,2] if ornate else [-1,1,-1,2])));p=SC[idx]
      if p==prev: p=SC[min(len(SC)-1,SC.index(p)+1)]
      add("flute",b,st*S,d*S*0.92,p,random.randint(78,98)+(6 if j==0 else 0));prev=p
random.seed(7);phrase(5,8,72,False);random.seed(7);phrase(13,8,74,False)
random.seed(11);phrase(21,16,77,True)
random.seed(7);phrase(37,8,76,False);random.seed(23);phrase(45,8,79,True)
random.seed(7);phrase(53,7,72,False);add("flute",60,0,1700,69,85)
# drums: kick 36, rim 37, shaker 70/cabasa 69 alternation, ride 51 in B, crash 49
RIM=[0,3,6,10,13]  # 16ths, 2-bar clave-ish
for b in range(1,61):
  s=sec(b)
  if b==60: add("drums",b,0,960,36,90);add("drums",b,0,960,49,80);continue
  if s=="Intro" and b<3: continue
  for st in range(8):
    p=70 if st%2==0 else 69
    if s=="B" and st%2==0: p=51
    add("drums",b,st*S,S*0.5,p,(70 if st%2==0 else 50)+random.randint(-5,5))
  add("drums",b,0,S,36,85);add("drums",b,3*S,S,36,70);add("drums",b,4*S,S,36,82);add("drums",b,7*S,S,36,66)
  for st in (RIM[:3] if b%2 else [2,6,10]): add("drums",b,st*120,120,37,72)
  if b in(5,21,37,53): add("drums",b,0,960,49,80)
issues=[]
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if c["tick"]-a["tick"]<40: a["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[k]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
json.dump(tr,open("plan.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(132)),mido.MetaMessage('key_signature',key='Am'),mido.MetaMessage('track_name',name='Salt Wind on Ipanema Steps')]
for k,(ch,prog) in {"gtr":(0,24),"bass":(1,32),"flute":(2,73),"drums":(9,0)}.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save("salt_wind.mid")
print({k:len(v) for k,v in tr.items()}, mf.length)
