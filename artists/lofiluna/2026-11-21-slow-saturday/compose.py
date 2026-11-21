# Lofi Luna 2026-11-21: three draft ideas + revisions. usage: python3 compose.py <d1|d2|d3> [rev]
import json,random,mido,sys,os
DR=sys.argv[1];REV=int(sys.argv[2]) if len(sys.argv)>2 else 0
Q=480;X=120;BAR=1920
D={}
D['d1']=dict(title="Slow Saturday",bpm=81,key="E major",mkey='E',sw=20,seed=2101,style="slow-saturday-lofi",
 scale=[4,6,8,9,11,1,3],tonic=64,
 sections=[("Intro",1,4),("A",5,16),("B",21,8),("A2",29,16),("Outro",45,4)],
 C={'Emaj9':(40,[56,59,63,66]),'C#m9':(37,[52,56,59,63]),'F#m11':(42,[52,57,59,64]),'B13':(35,[51,56,57,61]),
    'Amaj9':(45,[56,59,61,64]),'G#7alt':(44,[54,60,64,69]),'B7sus':(35,[52,56,57,61]),'Am6':(45,[54,59,60,64]),
    'G#m7':(44,[54,59,63,66])},
 A=['Emaj9','C#m9','F#m11','B13','Amaj9','G#7alt','C#m9','B7sus'],
 B=['Amaj9','Am6','G#m7','C#m9','F#m11','B13','Emaj9','B7sus'],
 intro=['Amaj9','Am6','Emaj9','B7sus'],outro=['Amaj9','Am6','Emaj9','Emaj9'],
 comp='keys',bass='two',drums='soft',
 themeA=[(0,2,2),(2,2,4),(4,6,6),(10,2,5),(12,4,4),(16,3,2),(19,1,1),(20,8,2),(30,2,4),(32,2,5),(34,2,4),(36,4,3),(40,4,1),(44,2,0),(46,2,1),(48,12,1)],
 themeA2=[(0,2,2),(2,2,4),(4,6,6),(10,2,5),(12,4,4),(16,3,3),(19,1,2),(20,8,1),(30,2,2),(32,4,4),(36,4,2),(40,4,1),(44,4,-1),(48,14,0)],
 themeB=[(0,6,7),(6,2,6),(8,8,4),(18,2,5),(20,4,6),(24,8,7),(32,2,9),(34,2,8),(36,4,7),(40,6,5),(46,2,4),(48,12,5)],
 tracks=[("Rhodes","comp",0,4,90,50),("Warm Pad","pad",1,89,54,78),("Finger Bass","bass",2,33,98,64),
         ("Jazz Guitar","lead",3,26,92,60),("Soft Kit","drums",9,0,86,64)],
 fx=dict(roomSize=0.48,damping=0.5,reverbLevel=0.28,chorusLevel=0.1,chorusDepthMs=1,chorusRateHz=0.25,chorusDelayMs=10),
 outroTop=[68,71,75])
D['d2']=dict(title="Paper Boats",bpm=75,key="F minor",mkey='Fm',sw=24,seed=2102,style="paper-boats-lofi",
 scale=[5,7,8,10,0,1,3],tonic=77,
 sections=[("Intro",1,4),("A",5,16),("B",21,8),("A2",29,16),("Outro",45,4)],
 C={'Fm9':(41,[56,60,63,67]),'Fmadd9':(41,[56,60,65,67]),'FmMaj9':(41,[56,60,64,67]),'Bb9':(46,[56,60,62,65]),
    'Dbmaj9':(37,[53,56,60,63]),'Gm7b5':(43,[53,58,61,65]),'C7#5':(36,[52,56,58,61]),'Eb13':(39,[55,60,61,65]),
    'Cm9':(36,[55,58,62,63]),'Bbm9':(46,[56,60,61,65]),'Abmaj9':(44,[55,58,60,63])},
 A=['Fmadd9','FmMaj9','Fm9','Bb9','Dbmaj9','Gm7b5','C7#5','Fm9'],
 B=['Dbmaj9','Eb13','Cm9','Fm9','Bbm9','Eb13','Abmaj9','C7#5'],
 intro=['Dbmaj9','Gm7b5','C7#5','C7#5'],outro=['Dbmaj9','C7#5','Fm9','Fm9'],
 comp='strum',bass='long',drums='soft',
 themeA=[(0,8,4),(8,4,2),(12,4,0),(16,12,-1),(28,4,0),(32,6,2),(38,2,3),(40,8,4),(48,4,6),(52,12,4)],
 themeA2=[(0,8,4),(8,4,2),(12,4,0),(16,12,-1),(28,4,-2),(32,6,-3),(38,2,-2),(40,8,-1),(48,16,0)],
 themeB=[(0,4,7),(4,4,6),(8,8,4),(16,4,5),(20,4,4),(24,8,2),(32,4,3),(36,4,2),(40,8,0),(48,4,1),(52,12,-1)],
 tracks=[("Piano","comp",0,0,84,54),("Strings","pad",1,49,56,76),("Fretless Bass","bass",2,35,98,64),
         ("Whistle","lead",3,78,70,62),("Soft Kit","drums",9,0,84,64)],
 fx=dict(roomSize=0.6,damping=0.45,reverbLevel=0.34,chorusLevel=0.08,chorusDepthMs=1,chorusRateHz=0.2,chorusDelayMs=10),
 outroTop=[72,77,80])
D['d3']=dict(title="Pancake Morning",bpm=89,key="C major",mkey='C',sw=16,seed=2103,style="pancake-morning-chillhop",
 scale=[0,2,4,5,7,9,11],tonic=72,
 sections=[("Intro",1,4),("A",5,16),("B",21,8),("A2",29,16),("Outro",45,4)],
 C={'Cmaj9':(36,[52,55,59,62]),'Am9':(45,[55,59,60,64]),'Dm9':(38,[53,57,60,64]),'G13':(43,[53,57,59,64]),
    'Fmaj9':(41,[55,57,60,64]),'Em7':(40,[55,59,62,64]),'E7b9':(40,[56,59,62,65]),'D9':(38,[54,57,60,64])},
 A=['Cmaj9','Am9','Dm9','G13'],
 B=['Fmaj9','E7b9','Am9','D9','Fmaj9','Em7','Dm9','G13'],
 intro=['Fmaj9','E7b9','Dm9','G13'],outro=['Fmaj9','G13','Cmaj9','Cmaj9'],
 comp='chop',bass='synco',drums='boombap',
 themeA=[(0,1,4),(2,2,4),(4,2,5),(6,4,4),(10,2,2),(12,4,0),(16,2,2),(18,2,1),(20,6,2),(28,2,4),(30,2,5),(32,1,7),(34,2,7),(36,2,8),(38,4,7),(42,2,5),(44,4,4),(48,8,2),(56,4,1)],
 themeA2=[(0,1,4),(2,2,4),(4,2,5),(6,4,4),(10,2,2),(12,4,0),(16,2,2),(18,2,1),(20,6,2),(28,2,4),(30,2,5),(32,2,4),(34,2,2),(36,2,1),(38,4,-1),(44,2,1),(46,2,-1),(48,12,0)],
 themeB=[(2,2,5),(4,2,7),(6,6,9),(14,2,8),(16,6,7),(24,4,6),(28,4,4),(34,2,5),(36,2,4),(38,6,2),(46,2,1),(48,10,2)],
 tracks=[("Clean Guitar","comp",0,27,78,42),("Electric Piano","pad",1,4,56,84),("Finger Bass","bass",2,33,98,64),
         ("Steel Drums","lead",3,114,80,58),("Standard Kit","drums",9,0,92,64)],
 fx=dict(roomSize=0.36,damping=0.5,reverbLevel=0.22,chorusLevel=0.08,chorusDepthMs=1,chorusRateHz=0.3,chorusDelayMs=10),
 outroTop=[76,79,84])
REVS={('d1',1):dict(
 sections=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,16),("Outro",53,4)],
 themeB2=[(0,4,7),(4,2,5),(6,2,4),(8,6,4),(16,3,5),(19,1,4),(20,4,3),(24,6,2),(32,3,4),(35,1,3),(36,4,2),(40,4,1),(44,4,-1),(48,12,0)],
 tag=[(0,3,4),(3,1,2),(4,8,1),(16,2,0),(18,2,1),(20,10,2),(36,2,4),(38,2,2),(40,6,1),(48,10,0)],
 tease=[(8,2,2),(10,2,4),(12,4,6)],
 rev=dict(lead=4,vol_lead=10,vol_comp=-3,vol_pad=-4)),
 ('d1',2):dict(themeB3=[(0,2,9),(2,2,8),(4,4,7),(8,2,6),(10,2,7),(12,4,5),(16,6,4),(24,2,5),(26,2,4),(28,4,2),(32,4,6),(36,2,5),(38,2,4),(40,8,2),(48,2,3),(50,2,2),(52,8,1)],
  rev=dict(lead=4,vol_lead=10,vol_comp=-3,vol_pad=-4,pad=4))}
S=D[DR]
for r in range(1,REV+1): S.update(REVS.get((DR,r),{}))
random.seed(S['seed']+REV)
SW=S['sw'];C=S['C'];SEC=S['sections'];LAST=SEC[-1][1]+SEC[-1][2]-1
RV=S.get('rev',{})
def sec(b):
  for n,s,l in SEC:
    if s<=b<s+l:return n,s
  return SEC[-1][0],SEC[-1][1]
def chord(b):
  s,st=sec(b)
  if s=="Intro": return S['intro'][b-st]
  if s=="Outro": return S['outro'][b-st]
  if s=="B": return S['B'][(b-st)%len(S['B'])]
  return S['A'][(b-st)%len(S['A'])]
tr={k:[] for k in("comp","pad","bass","lead","drums")}
def add(k,bar,tick,dur,p,v,swing=True):
  t=int(tick)
  if swing and t%240==120: t+=SW
  tr[k].append(dict(tick=(bar-1)*BAR+t,duration=max(20,int(dur)),pitch=int(p),velocity=max(1,min(127,int(v)))))
E=lambda s,d:S.get(s,d)
# ---------------- pad ----------------
for b in range(1,LAST+1):
  s,_=sec(b);_,vo=C[chord(b)]
  v={"Intro":56,"Outro":54,"B":52}.get(s,44)+RV.get('pad',0)
  for p in vo[1:]: add("pad",b,0,BAR-40 if b<LAST else 1800,p,v,False)
# ---------------- comp ----------------
def strum(b,t,notes,v,gap=22,dur=X*6):
  for i,p in enumerate(notes): add("comp",b,t+i*gap,dur-i*gap,p,v-i*2,False)
for b in range(1,LAST+1):
  s,st=sec(b);root,vo=C[chord(b)];base={"Intro":66,"B":70,"Outro":62}.get(s,66)+RV.get('comp',0)
  low=root+12 if root+12<vo[0]-2 else root
  if b==LAST or s=="Outro":
    strum(b,0,[low]+vo,base-4,40,X*14 if b<LAST else 1750);continue
  if S['comp']=='strum':
    strum(b,0,[low]+vo,base+random.randint(-3,3))
    strum(b,6*X+SW,vo[1:],base-12+random.randint(-3,3),18,X*3)
    if (b-st)%2==1: strum(b,10*X,vo[1:],base-16,16,X*2)
    if s=="B" and (b-st)%4==3: strum(b,14*X+SW,vo[2:],base-14,14,X*1.5)
  elif S['comp']=='keys':
    v0=base+random.randint(-3,3)
    strum(b,0,[low]+vo,v0,8,X*7)
    strum(b,7*X+SW,vo,v0-10,6,X*4)
    if (b-st)%4==3: strum(b,14*X+SW,vo[1:],v0-14,6,X*1.5)
  elif S['comp']=='arp':
    pat=[vo[0],vo[1],vo[2],vo[3],vo[3]+12,vo[3],vo[2],vo[1]]
    if s=="B": pat=[vo[0],vo[2],vo[1],vo[3],vo[2]+12,vo[3]+12,vo[2],vo[3]]
    add("comp",b,0,X*8,low,base-8,False)
    for i,p in enumerate(pat): add("comp",b,i*240,X*3,p,base-6-(i%2)*8+random.randint(-3,3))
  elif S['comp']=='chop':
    for st8 in (2,6,10,14):
      if st8==10 and (b-st)%2==0: continue
      for i,p in enumerate(vo[1:]): add("comp",b,st8*X,90,p,base-4+random.randint(-4,4)-i*2)
    if s=="B" and (b-st)%2==1:
      for i,p in enumerate(vo[1:]): add("comp",b,15*X,70,p,base-14)
# ---------------- bass ----------------
for b in range(1,LAST+1):
  root,_=C[chord(b)];s,st=sec(b);r=root if root>=36 else root+12
  nxt,_=C[chord(min(b+1,LAST))];nx=nxt if nxt>=36 else nxt+12
  ap=nx-1 if abs(nx-1-r)<8 else nx+1
  bv=RV.get('bass',0)
  if b==LAST: add("bass",b,0,1700,r,76+bv,False);continue
  if s=="Intro" and b<2: continue
  if s in("Intro","Outro"): add("bass",b,0,X*7,r,74+bv);add("bass",b,8*X,X*6,r+7 if s=="Intro" else r,64+bv);continue
  if S['bass']=='two':
    add("bass",b,0,X*7,r,86+bv+random.randint(-3,3));add("bass",b,8*X,X*4,r+7 if r+7<52 else r-5,72+bv+random.randint(-3,3))
    if s!="A" or (b-st)>=4: add("bass",b,12*X,X*1.7,r+(3 if 'm' in chord(b) and 'maj' not in chord(b) else 4),62+bv);add("bass",b,14*X,X*1.7,ap,66+bv)
  elif S['bass']=='long':
    add("bass",b,0,X*9,r,84+bv+random.randint(-3,3));add("bass",b,10*X,X*3,r+12 if r<44 else r,62+bv)
    if (b-st)%2==1: add("bass",b,14*X,X*1.6,ap,62+bv)
  elif S['bass']=='synco':
    add("bass",b,0,X*3,r,90+bv+random.randint(-3,3));add("bass",b,3*X,X*1,r,58+bv)
    add("bass",b,6*X,X*2.5,r+7 if r+7<52 else r-5,76+bv);add("bass",b,10*X,X*1.5,r+12 if r<45 else r,66+bv)
    add("bass",b,12*X,X*1.5,r,72+bv);add("bass",b,14*X,X*1.6,ap,66+bv)
# ---------------- lead ----------------
SC=S['scale']
def degree_pitch(d):
  base=S['tonic'];octv,idx=divmod(d,7)
  tpc=SC[0];pc=SC[idx];off=(pc-tpc)%12
  return base+octv*12+off
def snap(p,ch,strong):
  _,vo=C[ch];root,_=C[ch];cpcs={x%12 for x in vo}|{root%12}
  if strong:
    cand=[q for q in range(p-4,p+5) if q%12 in cpcs]
    return min(cand,key=lambda q:(abs(q-p),q))
  # scale tone not clashing a semitone with a chord tone (unless chord tone)
  if p%12 in cpcs: return p
  bad=any(((p-c)%12) in(1,11) for c in cpcs if (c not in set(SC)))
  if not bad and p%12 in set(SC): return p
  cand=[q for q in range(p-3,p+4) if q%12 in cpcs]
  return min(cand,key=lambda q:(abs(q-p),q))
def phrase(b0,motif,vel,shift=0,octave=0):
  prev=None
  for st,d,deg in motif:
    b=b0+st//16;t=(st%16)*X
    if b>LAST: return
    ch=chord(b);p=degree_pitch(deg+shift)+12*octave
    p=snap(p,ch,(st%8==0) or d>=4)
    add("lead",b,t,d*X*0.92,p,vel+(6 if st%16==0 else 0)+random.randint(-4,4))
lv=80+RV.get('lead',0)
TA,TA2,TB=S['themeA'],S['themeA2'],S['themeB']
for n,s,l in SEC:
  if n=="A":
    phrase(s,TA,lv-6);phrase(s+4,TA2,lv-2);phrase(s+8,TA,lv-2);phrase(s+12,S.get('tag',TA2),lv-6)
  if n=="B":
    for k in range(0,l,8):
      phrase(s+k,S.get('themeB3',TB) if k>=8 else TB,lv+2)
      if l-k>=8: phrase(s+k+4,S['themeB2'] if 'themeB2' in S else (TB if k==0 and l>8 else TA2),lv-2,0,0)
  if n=="A2":
    phrase(s,TA,lv);phrase(s+4,TA2,lv)
    if l>=16: phrase(s+8,TA,lv-6,0,0);phrase(s+12,TA2,lv-8)
if 'tease' in S: phrase(3,S['tease'],lv-14);phrase(4,S['tease'],lv-12)
for i,p in enumerate(S['outroTop']): add("lead",LAST,i*120,1600,p,56,False)
# ---------------- drums ----------------
for b in range(1,LAST+1):
  s,st0=sec(b);dv=RV.get('drums',0);k=b-st0
  if b==LAST: add("drums",b,0,800,36,62);add("drums",b,0,900,(49 if S['drums']!='brush' else 51),40);continue
  if s=="Intro":
    if b>=2:
      for st in range(0,16,2): add("drums",b,st*X,X*0.3,(51 if S['drums']=='brush' else 42),36+b*3+dv)
    if b>=3: add("drums",b,0,X,36,60+dv);add("drums",b,12*X,X,37,48+dv)
    continue
  if s=="Outro":
    add("drums",b,0,X,36,56+dv);add("drums",b,12*X,X,37,44+dv)
    for st in range(0,16,4): add("drums",b,st*X,X*0.3,(51 if S['drums']=='brush' else 42),36+dv)
    continue
  sty=S['drums']
  if sty=='brush':
    for st in range(0,16,2): add("drums",b,st*X,X*0.5,51,(52 if st%4==0 else 40)+random.randint(-4,4)+dv)
    for st in ([0,10] if k%2==0 else [0,7,10]): add("drums",b,st*X,X,36,(80 if st==0 else 62)+random.randint(-3,3)+dv)
    sn=38 if s=="B" else 37
    for st in (4,12): add("drums",b,st*X,X,sn,(60 if sn==38 else 62)+random.randint(-2,2)+dv)
    for st in (3,11): 
      if random.random()<0.35: add("drums",b,st*X,X*0.4,38,22)
    if s=="B": add("drums",b,8*X,X,44,44+dv)
  elif sty=='soft':
    for st in range(0,16,(1 if s=="B" else 2)): add("drums",b,st*X,X*0.3,42,(44 if st%4==0 else 30)+random.randint(-3,3)+dv)
    for st in ([0,9] if k%2==0 else [0,6,9]): add("drums",b,st*X,X,36,(76 if st==0 else 60)+random.randint(-3,3)+dv)
    for st in (4,12): add("drums",b,st*X,X,38,56+random.randint(-2,2)+dv)
    if k%4==3: add("drums",b,14*X,X*0.8,46,38+dv)
  elif sty=='boombap':
    for st in range(0,16,2): add("drums",b,st*X,X*0.35,42,(56 if st%4==0 else 40)+random.randint(-4,4)+dv)
    for st in range(1,16,2): add("drums",b,st*X,X*0.3,70,28+random.randint(-3,3)+dv)
    for st in ([0,7,10] if k%2==0 else [0,3,10]): add("drums",b,st*X,X,36,(88 if st==0 else 70)+random.randint(-3,3)+dv)
    for st in (4,12): add("drums",b,st*X,X,38,(80 if s!="A" else 72)+random.randint(-2,2)+dv)
    if random.random()<0.3: add("drums",b,15*X,X*0.4,38,26)
    if k%4==3: add("drums",b,14*X,X*0.8,46,44+dv)
  if k%8==7 and s!="A2" or (s=="A2" and k==15):
    for st in (13,14,15): add("drums",b,st*X,X*0.4,38,36+st+dv)
  if k==0 and s in("A","B","A2"): add("drums",b,0,600,(49 if sty!='brush' else 51),44)
# ---------------- cleanup + write ----------------
for kk,N in tr.items():
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
  tr[kk]=sorted(keep,key=lambda n:(n["tick"],n["pitch"]))
  for n in tr[kk]: n["duration"]=min(n["duration"],BAR*2)
OD=f"{DR}{'_r'+str(REV) if REV else ''}";os.makedirs(OD,exist_ok=True)
json.dump(tr,open(OD+"/plan.json","w"))
song=dict(title=S['title'],bpm=S['bpm'],key=S['key'],style=S['style'],fx=S['fx'],
  sections=[dict(name=n,startBar=s,bars=l,energy={"Intro":0.35,"A":0.55,"B":0.75,"A2":0.6,"Outro":0.3}[n]) for n,s,l in SEC],
  tracks=[dict(name=a,key=k,ch=c,prog=p,vol=v+RV.get('vol_'+k,0),pan=pn) for a,k,c,p,v,pn in S['tracks']],
  chords={b:chord(b) for b in range(1,LAST+1)},last=LAST)
json.dump(song,open(OD+"/song.json","w"),indent=1)
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(S['bpm'])),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key=S['mkey']),mido.MetaMessage('track_name',name=S['title'])]
for a,k,ch,prog,v,pn in S['tracks']:
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=a))
  t.append(mido.Message('program_change',channel=ch,program=prog));ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(OD+"/song.mid")
print(OD,{k:len(v) for k,v in tr.items()},"len_sec",round(mf.length,2),"maxdur",max(n["duration"] for N in tr.values() for n in N))
