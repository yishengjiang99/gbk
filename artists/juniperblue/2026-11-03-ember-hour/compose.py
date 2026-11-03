# Ember Hour - Juniper Blue. Original jazz ballad in Ab major, 4/4, 66 BPM, lightly swung eighths.
# Quartet: alto sax lead, piano, upright bass, brushes.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1103)
Q=480;BAR=1920;BPM=66;SW=300
Qual={'maj7':[0,4,7,11],'m7':[0,3,7,10],'7':[0,4,7,10],'m7b5':[0,3,6,10]}
Scale={'maj7':[0,2,4,7,9,11],'m7':[0,2,3,5,7,9,10],'7':[0,2,4,7,9,10],'m7b5':[0,1,3,5,6,8,10]}
Voic={'maj7':[4,7,11,14],'m7':[3,7,10,14],'7':[4,9,10,14],'m7b5':[3,6,10,12]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bars(*ss): return [tuple(c(x) for x in s.split()) if ' ' in s else (c(s),c(s)) for s in ss]
INTRO=bars('Db:maj7','C:m7 B:7','Bb:m7 Eb:7','Bb:m7 Eb:7')
A=bars('Ab:maj7','Bb:m7 Eb:7','C:m7 F:7','Bb:m7 Eb:7','Db:maj7 Gb:7','C:m7 B:7','Bb:m7 Eb:7','Ab:maj7 A:7')
Aend=A[:7]+bars('Ab:maj7')
B=bars('Eb:m7 Ab:7','Db:maj7','Db:m7 Gb:7','B:maj7','Bb:m7 Eb:7','C:m7 F:7','F:m7 Bb:7','Bb:m7 Eb:7')
CODA=bars('Db:maj7','Db:m7 Gb:7','C:m7 B:7','Ab:maj7')
# melodies per bar: (eighth 0-7, pitch, length in eighths)
MA=[[(1,72,1),(2,75,1),(3,79,5)],[(0,77,2),(2,73,2),(4,79,1),(5,77,1),(6,73,2)],[(0,70,3),(3,75,1),(4,81,4)],
    [(0,80,2),(2,77,1),(3,73,1),(4,79,2),(6,78,1),(7,77,1)],[(0,77,3),(3,72,1),(4,76,4)],[(0,75,2),(2,74,1),(3,72,1),(4,75,2),(6,78,2)],
    [(0,77,4),(4,79,2),(6,73,2)],[(0,72,4),(4,73,3)]]
MB=[[(0,78,2),(2,82,2),(4,84,2),(6,78,2)],[(0,77,6),(6,80,1),(7,82,1)],[(0,83,3),(3,80,1),(4,82,2),(6,76,2)],[(0,75,8)],
    [(0,73,2),(2,77,2),(4,79,3),(7,80,1)],[(0,82,3),(3,79,1),(4,81,2),(6,84,2)],[(0,80,4),(4,74,4)],[(0,73,2),(2,72,1),(3,70,1),(4,67,2),(6,70,2)]]
MAend=MA[:7]+[[(0,72,8)]]
MCODA=[[(0,77,4),(4,80,4)],[(0,76,4),(4,73,4)],[(0,75,4),(4,75,4)],[(0,70,8)]]
INTROMEL=[[(0,77,2),(2,80,2),(4,84,4)],[(0,82,3),(3,79,1),(4,78,4)],[(0,77,2),(2,73,2),(4,79,4)],[(0,80,2),(2,79,2),(4,77,2),(6,73,2)]]
tr={k:[] for k in('alto','piano','bass','drums')}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def tk(bi,e): return bi*BAR+(e//2)*Q+(SW if e%2 else 0)
def dur(e,L): return tk(0,e+L)-tk(0,e) if e+L<=8 else BAR-tk(0,e)
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]; return min(cand,key=lambda x:(abs(x-p),x))
def solo(bl,b0,lo,hi,k,vel,start,density,run=False,octave=False):
  p=start
  for i,cb in enumerate(bl):
    ph=i%4; e=random.choice([1,2]) if ph in(0,2) else 0
    while e<8:
      if ph in(1,3) and e>=5: break
      r,q=cb[e//4]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      arc=int(10*i/len(bl)) if V>=2 else 0
      if run and e%2==0 and e<6 and random.random()<.3:
        # double-time scale run: four sixteenths
        d=random.choice([-1,1])
        for j in range(4):
          cc=[x for x in range(p+d,p+d*4,d) if x%12 in sc and lo<=x<=hi]; p=cc[0] if cc else p
          add(k,tk(b0+i,e)+j*Q//4,Q//4*0.9,p,vel+arc-4+random.randint(-4,4))
        e+=2; continue
      if e%2==0: p=near(p+random.choice([-4,-3,-2,2,3,4,5]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=random.choice([1,1,2,2,3]) if random.random()<density else 2
      L=min(L,8-e)
      v=vel+arc+(-6 if e%2 else 0)+random.randint(-5,5)
      add(k,tk(b0+i,e),dur(e,L)*0.9,p,v)
      if octave: add(k,tk(b0+i,e),dur(e,L)*0.9,p-12,v-(6 if V>=4 else 14))
      e+=L
      if random.random()>density: e+=1
    if ph in(1,3):
      r,q=cb[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi)
      add(k,tk(b0+i,5),dur(5,3)*0.95,tgt,vel+4)
      if octave: add(k,tk(b0+i,5),dur(5,3)*0.95,tgt-12,vel-10)
      p=tgt
form=[("Intro",INTRO,INTROMEL,'pmel','intro'),("Head A",A,MA,'alto','head'),("Head B",B,MB,'alto','head'),
      ("Piano solo",A,None,None,'psolo'),("Alto solo",B,None,None,'asolo'),("Head out A",Aend,MAend,'alto','headout'),("Coda",CODA,MCODA,'alto','coda')]
EN={'intro':.25,'head':.5,'psolo':.65,'asolo':.9,'headout':.55,'coda':.3}
b=0;sections=[];allbars=[]
for name,chs,mel,who,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='psolo': solo(chs,b,67,91,'piano',86+(14 if V>=2 else 0),79,0.75,run=V>=2,octave=V>=2)
  if mode=='asolo': solo(chs,b,63,87,'alto',100,77,0.72,run=True)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if mel:
      for e,p,l in mel[i]:
        if who=='alto':
          v={'head':92,'headout':90,'coda':80}[mode]
          add('alto',tk(bi,e),dur(e,l)*0.94,p,v+(-5 if e%2 else 0))
        else: add('piano',tk(bi,e),dur(e,l)*0.9,p,70+(-4 if e%2 else 0))
  b+=len(chs)
total=b;last=None
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  nxt=allbars[idx+1][1][0] if not final else cb[0]
  # bass: half notes in intro/heads/coda, walking quarters in solos
  for h in (0,1):
    r,q=cb[h]; root=near(last if last else 44,[r],31,50)
    nr=(cb[1] if h==0 else nxt)[0]
    if final and h==0:
      add('bass',bi*BAR,BAR*0.95,near(44,[r],31,50),84); break
    if mode in('psolo','asolo'):
      mid=near(root+random.choice([3,4,7]),[(r+x)%12 for x in Qual[q]],31,52)
      ap=near(root,[nr],31,52)+random.choice([-1,1])
      for j,p in enumerate([root,ap if random.random()<.5 else mid]): add('bass',bi*BAR+h*2*Q+j*Q,Q*0.88,p,(92 if j==0 else 82)+random.randint(-4,4))
    else:
      v=84 if mode!='intro' else 72
      if mode in('head','headout') and h==1 and random.random()<.4:
        add('bass',bi*BAR+2*Q,Q*0.9,root,v-4); add('bass',bi*BAR+3*Q,Q*0.85,near(root,[nr],31,52)+random.choice([-1,1]),v-10)
      else: add('bass',bi*BAR+h*2*Q,2*Q*0.92,root,v)
    last=root
  # piano: rootless voicings, sustained in heads, light comping in alto solo, LH shells in piano solo
  for h in (0,1):
    r,q=cb[h]
    if h==1 and cb[1]==cb[0] and not final: 
      if mode in('head','headout','asolo') and random.random()<.5:
        ns=[near(53,[r],48,59)+x for x in Voic[q]]
        while ns[-1]>72: ns=[n-12 for n in ns]
        for n in ns: add('piano',bi*BAR+2*Q+SW,Q*1.2,n,(46 if mode!='asolo' else 52)+random.randint(-3,3))
      continue
    ns=[near(53,[r],48,59)+x for x in Voic[q]]
    while ns[-1]>72: ns=[n-12 for n in ns]
    t0=bi*BAR+h*2*Q; L=(BAR if cb[1]==cb[0] else 2*Q)
    if final:
      for j,n in enumerate(ns+[ns[-1]+5]): add('piano',t0+j*40,BAR*0.95,n,54)
      add('piano',t0,BAR*0.95,near(44,[r],32,47),50); break
    if mode=='psolo':
      for n in (ns if V>=4 else ns[:2]): add('piano',t0+(random.choice([0,SW]) if h else 0),L*0.7,n-12 if (n>60 and V<4) else n,62 if V>=4 else 54)
    elif mode=='asolo':
      off=random.choice([0,SW,Q+SW])
      for n in ns: add('piano',t0+off,(L-off)*0.6,n,58+random.randint(-4,4))
    else:
      base={'intro':48,'head':50,'headout':50,'coda':46}[mode]
      for j,n in enumerate(ns): add('piano',t0+j*25,L*0.92,n,base+random.randint(-3,3))
  # piano fill answering the melody at phrase ends in heads (bars 4 and 8 of each 8)
  if V>=2 and mode in('head','headout') and (bi-[s['startBar']-1 for s in sections if s['name']==name][0]) in ((3,6) if name=='Head B' else (2,7)) and not final:
    r,q=cb[1]; p=near(84,[(r+Qual[q][1])%12],78,92)
    for j in range(3):
      add('piano',tk(bi,5+j),Q*0.5,p,52-j*3); p=near(p-2,[(r+x)%12 for x in Scale[q]],70,90)
  # brushes (GM brush kit): swirl 40 on every beat, taps 38 on 2 and 4, hat foot on 2 and 4, soft kick on 1
  if final:
    add('drums',bi*BAR,2400,40,40); add('drums',bi*BAR,1800,51,44); continue
  dv={'intro':-10,'head':0,'headout':0,'psolo':4,'asolo':10,'coda':-8}[mode]
  for j in range(4):
    add('drums',bi*BAR+j*Q,Q*0.95,40,44+dv+random.randint(-3,3))
    if j in(1,3): add('drums',bi*BAR+j*Q,100,38,46+dv+random.randint(-3,3)); add('drums',bi*BAR+j*Q,100,44,40)
  if mode in('psolo','asolo'):
    for j in range(4): add('drums',bi*BAR+j*Q,150,51,46+dv+random.randint(-3,3))
    for j in (1,3): add('drums',bi*BAR+j*Q+SW,120,51,36+dv)
  add('drums',bi*BAR,150,36,36)
  starts=[s['startBar']-1 for s in sections]
  if bi in starts and bi>0 and mode in('asolo','headout'): add('drums',bi*BAR,1800,49,48)
  if bi+1 in starts and mode!='coda': add('drums',tk(bi,7),100,38,52+dv)
for k,N in tr.items():
  N.sort(key=lambda n:(n['pitch'],n['tick']))
  for a,cn in zip(N,N[1:]):
    if a['pitch']==cn['pitch'] and a['tick']+a['duration']>cn['tick']:
      if a['tick']==cn['tick']: cn['velocity']=0
      else: a['duration']=max(30,cn['tick']-a['tick']-10)
  tr[k]=sorted([n for n in N if n['velocity']>0],key=lambda n:(n['tick'],n['pitch']))
ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
if ARC:
  for k,N in tr.items():
    for n in N:
      bi=n['tick']//BAR; sec=[x for x in sections if x['startBar']-1<=bi][-1]['name']
      f=ARC.get(sec,1.0)*ARC.get(k+'@'+sec,1.0)
      n['velocity']=max(1,min(127,int(n['velocity']*f)))
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=total*BAR,timeSig=[4,4]),open(f'plan_v{V}.json','w'))
CH={'alto':(0,65),'piano':(1,0),'bass':(2,32),'drums':(9,40)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Ab'),mido.MetaMessage('track_name',name='Ember Hour')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'ember_hour_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,round(mf.length,1))
