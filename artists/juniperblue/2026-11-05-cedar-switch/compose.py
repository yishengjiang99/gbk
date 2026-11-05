# Cedar Switch - Juniper Blue. Original cool/West Coast jazz in Eb major, 4/4, 104 BPM, lightly swung.
# Quintet: tenor sax lead, vibraphone, piano rootless, acoustic bass walking, ride-heavy kit.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1105)
Q=480;BAR=1920;BPM=104;SW=300
Qual={'maj7':[0,4,7,11],'m7':[0,3,7,10],'7':[0,4,7,10],'m7b5':[0,3,6,10],'sus':[0,5,7,10]}
Scale={'maj7':[0,2,4,7,9,11],'m7':[0,2,3,5,7,9,10],'7':[0,2,4,7,9,10],'m7b5':[0,1,3,5,6,8,10],'sus':[0,2,5,7,9,10]}
Voic={'maj7':[4,7,11,14],'m7':[3,7,10,14],'7':[4,9,10,14],'m7b5':[3,6,10,12],'sus':[5,7,10,14]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bars(*ss): return [tuple(c(x) for x in s.split()) if ' ' in s else (c(s),c(s)) for s in ss]
INTRO=bars('Bb:sus','Bb:7','F:m7 Bb:7','F:m7 Bb:7')
A=bars('F:m7 Bb:7','Eb:maj7','Ab:maj7 Db:7','Eb:maj7','G:m7 C:7','F:m7 Bb:7','Eb:maj7 Ab:7','Eb:maj7')
Aend=A[:7]+bars('Eb:maj7')
B=bars('Ab:maj7','A:m7b5 D:7','G:m7','C:7','F:m7','Bb:7','G:m7 C:7','F:m7 Bb:7')
AB=A+B
CODA=bars('Ab:maj7','Db:7','F:m7 Bb:7','Eb:maj7')
# Hand-crafted original head (eighth index, pitch, length in eighths)
MA=[
  [(0,70,2),(2,68,1),(3,67,1),(4,68,2),(6,65,2)],
  [(0,67,3),(3,65,1),(4,63,4)],
  [(1,68,1),(2,70,1),(3,72,1),(4,75,2),(6,74,2)],
  [(0,75,2),(2,72,2),(4,70,4)],
  [(0,70,1),(1,72,1),(2,74,2),(4,77,2),(6,75,2)],
  [(0,72,2),(2,70,1),(3,68,1),(4,70,1),(5,67,1),(6,65,2)],
  [(0,67,2),(2,70,2),(4,72,2),(6,74,1),(7,75,1)],
  [(0,70,2),(2,68,2),(4,67,4)],
]
MB=[
  [(0,72,4),(4,75,2),(6,77,2)],
  [(0,74,2),(2,72,1),(3,70,1),(4,69,4)],
  [(0,70,3),(3,72,1),(4,74,4)],
  [(0,75,2),(2,74,1),(3,72,1),(4,70,2),(6,67,2)],
  [(0,68,2),(2,70,2),(4,72,3),(7,70,1)],
  [(0,72,2),(2,70,2),(4,68,2),(6,65,2)],
  [(0,67,1),(1,70,1),(2,72,2),(4,75,2),(6,74,2)],
  [(0,72,2),(2,70,2),(4,68,1),(5,67,1),(6,65,2)],
]
MAend=MA[:7]+[[(0,67,2),(2,65,1),(3,63,1),(4,63,4)]]
MCODA=[[(0,72,4),(4,75,4)],[(0,74,4),(4,70,4)],[(0,68,2),(2,67,2),(4,65,2),(6,63,2)],[(0,63,8)]]
INTROMEL=[[(0,65,4),(4,67,4)],[(0,68,4),(4,70,4)],[(0,72,2),(2,70,2),(4,68,2),(6,65,2)],[(0,67,2),(2,65,2),(4,63,4)]]
tr={k:[] for k in('tenor','vibes','piano','bass','drums')}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def tk(bi,e): return bi*BAR+(e//2)*Q+(SW if e%2 else 0)
def dur(e,L): return tk(0,e+L)-tk(0,e) if e+L<=8 else BAR-tk(0,e)
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]
  return min(cand,key=lambda x:(abs(x-p),x)) if cand else max(lo,min(hi,p))
def solo(bl,b0,lo,hi,k,vel,start,density,run=False):
  p=start
  for i,cb in enumerate(bl):
    ph=i%4; e=random.choice([0,1,2]) if ph in(0,2) else 0
    while e<8:
      if ph in(1,3) and e>=6: break
      r,q=cb[e//4]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      arc=int(10*i/max(1,len(bl)-1)) if V>=2 else 0
      if run and e%2==0 and e<6 and random.random()<.28:
        d=random.choice([-1,1])
        for j in range(4):
          cc=[x for x in range(p+d,p+d*5,d) if x%12 in sc and lo<=x<=hi]; p=cc[0] if cc else p
          add(k,tk(b0+i,e)+j*Q//4,max(30,Q//4*0.9),p,vel+arc-6+random.randint(-3,3))
        e+=2; continue
      if e%2==0: p=near(p+random.choice([-5,-3,-2,2,3,4,5]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=random.choice([1,1,2,2,3]) if random.random()<density else 2
      L=min(L,8-e)
      add(k,tk(b0+i,e),dur(e,L)*0.9,p,vel+arc+(-5 if e%2 else 0)+random.randint(-4,4))
      e+=L
      if random.random()>density: e+=1
    if ph in(1,3):
      r,q=cb[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi)
      add(k,tk(b0+i,5),dur(5,3)*0.95,tgt,vel+4); p=tgt
form=[
  ("Intro",INTRO,INTROMEL,'vibes','intro'),
  ("Head A",A,MA,'tenor','head'),
  ("Head B",B,MB,'tenor','head'),
  ("Vibes solo",AB,None,None,'vsolo'),
  ("Tenor solo",AB,None,None,'tsolo'),
  ("Head out A",Aend,MAend,'tenor','headout'),
  ("Coda",CODA,MCODA,'tenor','coda'),
]
EN={'intro':.3,'head':.55,'vsolo':.7,'tsolo':.9,'headout':.6,'coda':.35}
b=0;sections=[];allbars=[]
for name,chs,mel,who,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='vsolo': solo(chs,b,60,88,'vibes',88+(10 if V>=2 else 0),72,0.72,run=V>=2)
  if mode=='tsolo': solo(chs,b,58,86,'tenor',100,70,0.74,run=True)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if mel:
      for e,p,l in mel[i]:
        if who=='tenor':
          v={'head':94,'headout':92,'coda':82}[mode]
          add('tenor',tk(bi,e),dur(e,l)*0.94,p,v+(-5 if e%2 else 0))
          if mode in('head','headout') and i in(1,3,5,7) and e==0 and l>=3:
            add('vibes',tk(bi,e)+40,dur(e,l)*0.7,p+12 if p+12<=88 else p,48)
        else:
          add('vibes',tk(bi,e),dur(e,l)*0.9,p,68+(-4 if e%2 else 0))
  b+=len(chs)
total=b
# Walking bass
last=None
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  nxt_r=allbars[idx+1][1][0][0] if not final else cb[0][0]
  if final:
    r,_=cb[0]; add('bass',bi*BAR,BAR*0.95,near(39,[r],31,50),90); continue
  if mode=='intro':
    for h in (0,1):
      r,q=cb[h]; root=near(last if last else 39,[r],31,50)
      add('bass',bi*BAR+h*2*Q,2*Q*0.92,root,74); last=root
    continue
  notes=[]
  for beat in range(4):
    half=0 if beat<2 else 1
    r,q=cb[half]
    if beat==0: p=near(last if last else 39,[r],31,50)
    elif beat==3:
      p=near(last,[nxt_r],31,52)
      if abs(p-last)>7: p=near(last,[(nxt_r+7)%12,nxt_r],31,52)
    else:
      ct=[(r+x)%12 for x in Qual[q]]
      p=near(last+random.choice([-3,-2,2,3,4,5]),ct,31,52)
    notes.append(p); last=p
  for beat,p in enumerate(notes):
    add('bass',bi*BAR+beat*Q,Q*0.88,p,(94 if beat==0 else 84)+random.randint(-3,3))
# Piano rootless voicings + vibes color
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  for h in (0,1):
    r,q=cb[h]
    if h==1 and cb[1]==cb[0] and not final:
      if mode in('head','headout','tsolo','vsolo') and random.random()<.45:
        ns=[near(55,[r],50,62)+x for x in Voic[q]]
        while ns[-1]>76: ns=[n-12 for n in ns]
        off=random.choice([0,SW,Q])
        for n in ns: add('piano',bi*BAR+2*Q+off,Q*1.1,n,(48 if mode!='tsolo' else 54)+random.randint(-3,3))
      continue
    ns=[near(55,[r],50,62)+x for x in Voic[q]]
    while ns[-1]>76: ns=[n-12 for n in ns]
    t0=bi*BAR+h*2*Q; L=(BAR if cb[1]==cb[0] else 2*Q)
    if final:
      for j,n in enumerate(ns+[ns[-1]+5]): add('piano',t0+j*35,BAR*0.95,n,56)
      add('piano',t0,BAR*0.95,near(39,[r],32,48),52); break
    if mode=='vsolo':
      off=random.choice([0,SW])
      for n in ns[:3]: add('piano',t0+off,(L-off)*0.65,n,52+random.randint(-3,3))
    elif mode=='tsolo':
      off=random.choice([0,SW,Q+SW])
      for n in ns: add('piano',t0+off,max(30,(L-off)*0.55),n,56+random.randint(-3,3))
    elif mode=='intro':
      for j,n in enumerate(ns): add('piano',t0+j*20,L*0.9,n,46+random.randint(-2,2))
    else:
      base={'head':52,'headout':52,'coda':48}[mode]
      for j,n in enumerate(ns): add('piano',t0+j*22,L*0.9,n,base+random.randint(-3,3))
  if mode in('head','headout') and (bi%2==1) and not final:
    r,q=cb[1]
    for j,pc in enumerate([(r+x)%12 for x in Qual[q][:3]]):
      add('vibes',tk(bi,6)+j*30,dur(6,2)*0.7,near(72,[pc],67,84),42+random.randint(-2,2))
  if mode=='tsolo' and not final:
    r,q=cb[0]; ns=[near(67,[r],60,76)+x for x in Voic[q][:3]]
    while ns[-1]>84: ns=[n-12 for n in ns]
    off=random.choice([0,Q+SW])
    for n in ns: add('vibes',bi*BAR+off,Q*1.5,n,46+random.randint(-3,3))
# Drums: Standard Kit, ride-heavy
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  if final:
    add('drums',bi*BAR,2400,51,50); add('drums',bi*BAR,1800,49,55); add('drums',bi*BAR,200,36,70); continue
  dv={'intro':-8,'head':0,'headout':0,'vsolo':4,'tsolo':8,'coda':-6}[mode]
  for j in range(4):
    add('drums',bi*BAR+j*Q,Q*0.9,51,52+dv+random.randint(-3,3)+(4 if j%2==0 else 0))
    if mode in('vsolo','tsolo'): add('drums',bi*BAR+j*Q+SW,120,51,38+dv)
  for j in (1,3):
    add('drums',bi*BAR+j*Q,100,38,58+dv+random.randint(-4,4))
  if mode in('head','headout','vsolo','tsolo'):
    for j in (1,3):
      if random.random()<.5: add('drums',bi*BAR+j*Q+SW,80,42,36+dv)
  add('drums',bi*BAR,120,36,62+dv)
  if mode in('vsolo','tsolo') or random.random()<.4: add('drums',bi*BAR+2*Q,100,36,50+dv)
  if mode=='tsolo' and random.random()<.35: add('drums',bi*BAR+Q+SW,80,36,44)
  if mode=='tsolo' and bi%2==0: add('drums',bi*BAR+3*Q+SW,200,46,48+dv)
  starts=[s['startBar']-1 for s in sections]
  if bi in starts and bi>0 and mode in('tsolo','headout','vsolo'): add('drums',bi*BAR,1600,49,52)
  if bi+1 in starts and mode!='coda': add('drums',tk(bi,7),90,38,56+dv)
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
CH={'tenor':(0,66),'vibes':(1,11),'piano':(2,0),'bass':(3,32),'drums':(9,0)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Eb'),mido.MetaMessage('track_name',name='Cedar Switch')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'cedar_switch_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,'bars',round(mf.length,1),'s')
