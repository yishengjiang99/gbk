# Lofi Luna 2026-11-19: three draft ideas + revision. usage: python3 compose.py <draft d1|d2|d3> [rev]
import json,random,mido,sys,os
DR=sys.argv[1];REV=int(sys.argv[2]) if len(sys.argv)>2 else 0
Q=480;X=120;BAR=1920
def n_(s): # note name -> pc
  return {'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}[s]

# ---------------- draft configs ----------------
D={}
D['d1']=dict(title="Late Train Home",bpm=71,key="G minor",mkey='Gm',sw=26,seed=1901,style="late-night-train-lofi",
 scale=[7,9,10,0,2,3,5],tonic=67,
 sections=[("Intro",1,4),("A",5,16),("B",21,8),("A2",29,16),("Outro",45,4)],
 C={'Gm9':(43,[58,62,65,69]),'Cm9':(36,[58,62,63,67]),'F13':(41,[57,62,63,67]),'Bbmaj9':(46,[57,60,62,65]),
    'Ebmaj9':(39,[55,58,62,65]),'Am7b5':(45,[55,60,63,69]),'D7b9':(38,[54,57,60,63]),'D7#9':(38,[54,60,65,70]),
    'Fm9':(41,[56,60,63,67]),'Bb13':(46,[56,60,62,67])},
 A=['Gm9','Cm9','F13','Bbmaj9','Ebmaj9','Am7b5','D7b9','Gm9'],
 B=['Fm9','Bb13','Ebmaj9','Ebmaj9','Am7b5','D7b9','Gm9','D7#9'],
 intro=['Ebmaj9','Am7b5','D7b9','D7#9'],outro=['Ebmaj9','D7b9','Gm9','Gm9'],
 comp='strum',bass='two',drums='brush',
 # theme in 16ths: (start, dur, scale-degree from tonic)
 themeA=[(0,3,4),(3,1,3),(4,6,2),(12,4,4),(16,3,5),(19,1,4),(20,8,2),(30,2,0),(32,3,4),(35,1,3),(36,6,2),(44,4,1),(48,12,0)],
 themeA2=[(0,3,4),(3,1,3),(4,6,2),(12,4,4),(16,3,5),(19,1,4),(20,8,2),(30,2,0),(32,4,1),(36,4,3),(40,4,2),(44,4,-1),(48,14,0)],
 themeB=[(0,4,6),(4,2,7),(6,2,6),(8,8,4),(18,2,2),(20,4,3),(24,8,4),(32,4,5),(36,2,4),(38,2,3),(40,8,1),(50,2,-1),(52,10,0)],
 tracks=[("Nylon Guitar","comp",0,24,92,46),("Warm Pad","pad",1,89,60,74),("Acoustic Bass","bass",2,32,100,64),
         ("Harmonica","lead",3,22,78,56),("Brush Kit","drums",9,40,88,64)],
 fx=dict(roomSize=0.5,damping=0.55,reverbLevel=0.3,chorusLevel=0.06,chorusDepthMs=1,chorusRateHz=0.2,chorusDelayMs=10),
 outroTop=[67,70,74])
D['d2']=dict(title="Snow Day",bpm=79,key="Eb major",mkey='Eb',sw=12,seed=1902,style="snow-day-lofi",
 scale=[3,5,7,8,10,0,2],tonic=75,
 sections=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,16),("Outro",53,4)],
 C={'Ebmaj9':(39,[55,58,62,65]),'Dbmaj9':(37,[53,56,60,63]),'Abmaj9':(44,[55,58,60,63]),'Bb9sus':(46,[56,60,63,65]),
    'Gm7':(43,[53,58,62,65]),'Fm9':(41,[56,60,63,67]),'Bb13':(46,[56,60,62,67]),'G7b13':(43,[53,59,63,65]),'Cm9':(36,[58,62,63,67])},
 A=['Ebmaj9','Dbmaj9','Abmaj9','Bb9sus'],
 B=['Abmaj9','Gm7','Fm9','Bb13','Abmaj9','G7b13','Cm9','Bb9sus'],
 intro=['Abmaj9','Dbmaj9','Abmaj9','Bb9sus'],outro=['Abmaj9','Dbmaj9','Ebmaj9','Ebmaj9'],
 comp='arp',bass='long',drums='soft',
 themeA=[(0,2,4),(2,2,2),(4,2,4),(6,6,5),(14,2,4),(16,2,3),(18,2,1),(20,4,3),(24,8,2),(32,2,4),(34,2,2),(36,2,4),(38,6,7),(46,2,6),(48,12,4)],
 themeA2=[(0,2,4),(2,2,2),(4,2,4),(6,6,5),(14,2,4),(16,2,3),(18,2,1),(20,4,3),(24,8,2),(32,2,4),(34,2,5),(36,2,6),(38,6,7),(46,2,8),(48,12,7)],
 themeB=[(0,6,9),(6,2,8),(8,8,7),(16,6,8),(22,2,7),(24,8,5),(32,4,6),(36,4,5),(40,4,4),(44,4,3),(48,10,4)],
 tracks=[("Felt Piano","comp",0,0,84,52),("Strings","pad",1,49,62,76),("Acoustic Bass","bass",2,32,96,64),
         ("Glockenspiel","lead",3,9,66,60),("Standard Kit","drums",9,0,82,64)],
 fx=dict(roomSize=0.62,damping=0.4,reverbLevel=0.34,chorusLevel=0.1,chorusDepthMs=1,chorusRateHz=0.25,chorusDelayMs=10),
 outroTop=[75,79,82])
D['d3']=dict(title="Corner Shop",bpm=87,key="Ab major",mkey='Ab',sw=18,seed=1903,style="corner-shop-chillhop",
 scale=[8,10,0,1,3,5,7],tonic=68,
 sections=[("Intro",1,4),("A",5,16),("B",21,16),("A2",37,16),("Outro",53,4)],
 C={'Abmaj9':(44,[55,58,60,63]),'Fm9':(41,[56,60,63,67]),'Bbm9':(46,[56,60,61,65]),'Eb13':(39,[55,60,61,65]),
    'Dbmaj9':(37,[53,56,60,63]),'C7#5':(36,[52,56,58,61]),'Ab9':(44,[54,58,60,63]),'Gb9':(42,[52,56,58,61])},
 A=['Abmaj9','Fm9','Bbm9','Eb13'],
 B=['Dbmaj9','C7#5','Fm9','Ab9','Dbmaj9','Gb9','Abmaj9','Eb13'],
 intro=['Dbmaj9','C7#5','Fm9','Eb13'],outro=['Dbmaj9','Eb13','Abmaj9','Abmaj9'],
 comp='chop',bass='synco',drums='boombap',
 themeA=[(0,2,4),(3,1,4),(4,2,5),(6,4,4),(12,2,2),(14,2,0),(16,6,2),(24,2,4),(26,6,1),(32,2,4),(35,1,4),(36,2,5),(38,4,7),(44,2,5),(46,2,4),(48,10,2)],
 themeA2=[(0,2,4),(3,1,4),(4,2,5),(6,4,4),(12,2,2),(14,2,0),(16,6,2),(24,2,4),(26,6,1),(32,2,4),(35,1,4),(36,2,5),(38,4,7),(44,2,8),(46,2,7),(48,12,7)],
 themeB=[(2,2,7),(4,2,8),(6,6,9),(14,2,7),(16,8,8),(26,2,5),(28,4,6),(34,2,4),(36,2,5),(38,6,6),(46,2,4),(48,10,5)],
 tracks=[("Muted Guitar","comp",0,28,80,40),("Soft Organ","pad",1,16,48,84),("Finger Bass","bass",2,33,98,64),
         ("Marimba","lead",3,12,92,58),("Standard Kit","drums",9,0,94,64)],
 fx=dict(roomSize=0.34,damping=0.5,reverbLevel=0.2,chorusLevel=0.08,chorusDepthMs=1,chorusRateHz=0.3,chorusDelayMs=10),
 outroTop=[72,75,80])
# revision 1 of the chosen draft (Late Train Home), from the critique
D['d1r']=dict(
 themeB2=[(0,4,7),(4,2,6),(6,2,5),(8,6,4),(16,3,5),(19,1,4),(20,4,3),(24,6,2),(32,3,4),(35,1,3),(36,4,2),(40,4,1),(44,4,-1),(48,12,0)],
 tag=[(0,3,4),(3,1,3),(4,8,2),(16,2,0),(18,2,1),(20,10,2),(36,2,4),(38,2,2),(40,6,1),(48,10,0)],
 tease=[(8,2,4),(10,2,3),(12,4,2)],
 rev=dict(bass=-6,drums=-6,lead=4,vol_bass=-12,vol_lead=8,vol_comp=-2,comp=-2))
S=D[DR]
if DR=='d1' and REV>=1: S.update(D['d1r'])
if REV>=2: S['rev'].update(D.get('r2',{}))
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
  bad=any(((p-c)%12) in(1,11) for c in cpcs if (REV<2 or c not in set(SC)))
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
    if REV>=2: # hook from bar 5: question (Gm..Bb), answer (Eb..Gm), question, tag answer
      phrase(s,TA,lv-6);phrase(s+4,TA2,lv-2);phrase(s+8,TA,lv-2);phrase(s+12,S['tag'],lv-6)
    else:
      phrase(s+4,TA,lv-6) if l>=16 else None
      if l>=16: phrase(s+8,TA2,lv-2)
      if 'tag' in S and l>=16: phrase(s+12,S['tag'],lv-8)
  if n=="B":
    for k in range(0,l,8):
      phrase(s+k,TB,lv+2)
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
