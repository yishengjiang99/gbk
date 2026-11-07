# Ironwood Run - Juniper Blue. Original uptempo hard bop in C minor, 4/4, 168 BPM, swung.
# Quintet: trumpet lead + tenor sax harmony front line, piano comping, walking bass, ride-led kit.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1107)
Q=480;BAR=1920;BPM=168;SW=290
Qual={'maj7':[0,4,7,11],'m7':[0,3,7,10],'7':[0,4,7,10],'m7b5':[0,3,6,10],'alt':[0,4,10,13]}
Scale={'maj7':[0,2,4,7,9,11],'m7':[0,2,3,5,7,9,10],'7':[0,2,4,7,9,10],'m7b5':[0,1,3,5,6,8,10],'alt':[0,1,3,4,7,8,10]}
Voic={'maj7':[4,7,11,14],'m7':[3,7,10,14],'7':[4,9,10,14],'m7b5':[3,6,10,12],'alt':[4,10,13,15]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bars(*ss): return [tuple(c(x) for x in s.split()) if ' ' in s else (c(s),c(s)) for s in ss]
INTRO=bars('C:m7','D:m7b5 G:alt','C:m7','D:m7b5 G:alt')
A1=bars('C:m7','C:m7','D:m7b5 G:alt','C:m7','F:m7','Bb:7','Eb:maj7 Ab:7','D:m7b5 G:alt')
A2=A1[:6]+bars('D:m7b5 G:alt','C:m7')
B=bars('G:m7 C:7','F:m7','Bb:m7 Eb:7','Ab:maj7','A:m7b5 D:7','G:m7','Ab:7','G:alt')
CODA=bars('C:m7','Ab:7','D:m7b5 G:alt','C:m7')
MA=[
  [(0,72,1),(1,75,1),(2,79,2),(4,77,1),(5,75,1),(6,74,1),(7,72,1)],
  [(0,70,1),(1,72,3),(5,67,1),(6,70,2)],
  [(0,74,1),(1,77,1),(2,80,2),(4,79,1),(5,77,1),(6,75,1),(7,71,1)],
  [(0,72,4),(5,67,1),(6,68,1),(7,70,1)],
  [(0,72,1),(1,75,1),(2,77,2),(4,80,2),(6,79,1),(7,77,1)],
  [(0,74,2),(2,70,1),(3,74,1),(4,77,3),(7,79,1)],
  [(0,79,3),(3,75,1),(4,78,2),(6,77,1),(7,75,1)],
  [(0,74,2),(2,72,1),(3,74,1),(4,71,2),(6,67,2)],
]
MA2=MA[:6]+[MA[7],[(0,72,4),(6,70,1),(7,72,1)]]
MB=[
  [(0,74,3),(3,77,1),(4,76,4)],
  [(0,77,2),(2,75,1),(3,72,1),(4,68,2),(6,72,2)],
  [(0,73,3),(3,77,1),(4,79,4)],
  [(0,80,2),(2,79,1),(3,75,1),(4,72,4)],
  [(0,72,3),(3,75,1),(4,78,4)],
  [(0,77,2),(2,74,1),(3,70,1),(4,74,2),(6,77,2)],
  [(0,78,2),(2,75,1),(3,72,1),(4,70,2),(6,72,2)],
  [(0,71,2),(2,74,1),(3,77,1),(4,80,2),(6,79,1),(7,75,1)],
]
MLAST=MA[:6]+[MA[7],[(0,72,8)]]
MCODA=[[(0,79,2),(2,75,2),(4,72,4)],[(0,78,4),(4,75,4)],[(0,74,2),(2,77,2),(4,71,4)],[(0,72,8)]]
INTROHITS=[[],[(6,74,1),(7,71,1)],[],[(0,74,2),(4,71,1),(5,74,1),(6,71,1),(7,67,1)]]
tr={k:[] for k in('trumpet','tenor','piano','bass','drums')}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def tk(bi,e): return bi*BAR+(e//2)*Q+(SW if e%2 else 0)
def dur(e,L): return tk(0,e+L)-tk(0,e) if e+L<=8 else BAR-tk(0,e)
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]
  return min(cand,key=lambda x:(abs(x-p),x)) if cand else max(lo,min(hi,p))
def harm(p,cb,e):
  # tenor harmony: chord tone 3-9 semitones below melody, else a sixth below
  r,q=cb[min(1,e//4)]; ct=[(r+x)%12 for x in Qual[q]]
  c=[p-d for d in (3,4,5,8,9) if (p-d)%12 in ct]
  return c[0] if c else p-9
def solo(bl,b0,lo,hi,k,vel,start,density,run=False):
  p=start
  for i,cb in enumerate(bl):
    ph=i%4; e=random.choice([0,1,2]) if ph in(0,2) else 0
    arc=int(12*i/max(1,len(bl)-1)) if V>=2 else 0
    while e<8:
      if ph==3 and e>=6: break
      r,q=cb[e//4]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if run and e%2==0 and e<6 and random.random()<.22:
        # bebop triplet/sixteenth burst
        d=random.choice([-1,1])
        for j in range(3):
          cc=[x for x in range(p+d,p+d*5,d) if x%12 in sc and lo<=x<=hi]; p=cc[0] if cc else p
          add(k,tk(b0+i,e)+j*Q//3,Q//3*0.9,p,vel+arc-6+random.randint(-3,3))
        e+=2; continue
      if e==4 and random.random()<.35:
        # enclosure into a chord tone
        t=near(p,ct,lo+1,hi-1); add(k,tk(b0+i,e),dur(e,1)*0.85,t+1,vel+arc-4); add(k,tk(b0+i,e+1),dur(e+1,1)*0.85,t-1,vel+arc-8)
        add(k,tk(b0+i,e+2),dur(e+2,1)*0.9,t,vel+arc); p=t; e+=3; continue
      if e%2==0: p=near(p+random.choice([-4,-3,-2,2,3,4]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=1 if random.random()<density else random.choice([2,3])
      L=min(L,8-e)
      add(k,tk(b0+i,e),dur(e,L)*0.88,p,vel+arc+(-6 if e%2 else 0)+random.randint(-4,4))
      e+=L
      if random.random()>density+0.1: e+=1
    if ph==3:
      r,q=cb[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi)
      add(k,tk(b0+i,6),dur(6,2)*0.9,tgt,vel+arc+2); p=tgt
form=[
  ("Intro",INTRO,'intro'),
  ("Head A1",A1,'head'),("Head A2",A2,'head'),("Head B",B,'head'),("Head A3",A2,'head'),
  ("Trumpet solo",A1+A2+B+A2,'tsolo'),
  ("Tenor solo",A1+B,'xsolo'),
  ("Trading fours",A1+A2,'trade'),
  ("Head out B",B,'headout'),("Head out A",A2,'headout'),
  ("Coda",CODA,'coda'),
]
MEL={'Head A1':MA,'Head A2':MA2,'Head B':MB,'Head A3':MA2,'Head out B':MB,'Head out A':MLAST,'Coda':MCODA,'Intro':INTROHITS}
EN={'intro':.5,'head':.7,'tsolo':.85,'xsolo':.9,'trade':.95,'headout':.75,'coda':.5}
b=0;sections=[];allbars=[]
for name,chs,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='tsolo': solo(chs,b,64,86,'trumpet',96,74,0.8,run=True)
  if mode=='xsolo': solo(chs,b,(57 if V>=2 else 52),(82 if V>=2 else 79),'tenor',98+(6 if V>=2 else 0),(67 if V>=2 else 62),0.82,run=True)
  if mode=='trade':
    for blk in range(4):
      if blk%2==0:
        who,lo,hi,st=(('trumpet',66,86,76) if blk==0 else ('tenor',54,79,65))
        solo(chs[blk*4:blk*4+4],b+blk*4,lo,hi,who,104,st,0.85,run=True)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if name in MEL:
      for e,p,l in MEL[name][i]:
        v={'head':100,'headout':102,'coda':94,'intro':96}[mode]
        add('trumpet',tk(bi,e),dur(e,l)*0.9,p,v+(-6 if e%2 else 0))
        add('tenor',tk(bi,e),dur(e,l)*0.9,harm(p,cb,e),v-8+(-6 if e%2 else 0))
  b+=len(chs)
total=b
def drumsolo(bi):
  return [s for s in sections if s['name']=='Trading fours' and 4<= bi-(s['startBar']-1) <8 or (s['name']=='Trading fours' and 12<=bi-(s['startBar']-1)<16)]
# Walking bass
last=None
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  nxt_r=allbars[idx+1][1][0][0] if not final else cb[0][0]
  if final:
    add('bass',bi*BAR,BAR*0.95,near(36,[cb[0][0]],31,50),96); continue
  if drumsolo(bi):
    if bi==allbars[idx][0] and (bi-(sections[7]['startBar']-1))%4==0: add('bass',bi*BAR,Q*0.8,near(36,[cb[0][0]],31,50),86)
    continue
  if mode=='intro':
    # two-feel pedal intro
    r,q=cb[0]; root=near(36,[r],31,48)
    add('bass',bi*BAR,Q*1.4,root,88); add('bass',bi*BAR+2*Q+SW,Q*0.6,root+7,78); add('bass',bi*BAR+3*Q,Q*0.9,root+7 if cb[1]==cb[0] else near(root,[cb[1][0]],31,48),82); last=root; continue
  notes=[]
  for beat in range(4):
    half=0 if beat<2 else 1
    r,q=cb[half]
    if beat==0: p=near(last if last else 36,[r],31,50)
    elif beat==3:
      tgt=near(last,[nxt_r],31,52); p=tgt+random.choice([-1,1]) if random.random()<.6 else near(last,[(nxt_r+7)%12],31,52)
    else:
      ct=[(r+x)%12 for x in Qual[q]]
      p=near(last+random.choice([-3,-2,2,3,4]),ct,31,52)
    notes.append(p); last=p
  for beat,p in enumerate(notes):
    add('bass',bi*BAR+beat*Q,Q*0.85,p,(98 if beat==0 else 88)+random.randint(-3,3))
# Piano comping, rootless, syncopated Charleston/anticipations
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  if drumsolo(bi): continue
  for h in (0,1):
    r,q=cb[h]
    ns=[near(55,[r],50,62)+x for x in Voic[q]]
    while ns[-1]>76: ns=[n-12 for n in ns]
    t0=bi*BAR+h*2*Q
    if final:
      for j,n in enumerate(ns+[ns[-1]+5]): add('piano',bi*BAR+j*30,BAR*0.95,n,62)
      add('piano',bi*BAR,BAR*0.95,near(36,[r],32,48),58); break
    if h==1 and cb[1]==cb[0] and random.random()<.5: continue
    off=random.choice([0,SW,Q+SW]) if mode not in('intro',) else (0 if h==0 else Q+SW)
    if off>=2*Q: off=0
    L=Q*random.choice([0.5,0.7,1.2])
    base={'intro':60,'head':56,'tsolo':58,'xsolo':60,'trade':62,'headout':58,'coda':54}[mode]
    for j,n in enumerate(ns): add('piano',t0+off+j*12,L,n,base+random.randint(-4,4))
# Drums: ride spang-a-lang, hat foot 2&4, feathered kick, snare comping, fills
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  if final:
    add('drums',bi*BAR,2400,51,60); add('drums',bi*BAR,1800,49,78); add('drums',bi*BAR,200,36,86); add('drums',bi*BAR,200,38,70); continue
  dv={'intro':-4,'head':0,'headout':2,'tsolo':4,'xsolo':6,'trade':8,'coda':-2}[mode]
  if drumsolo(bi):
    # written drum break: snare/tom phrases on swung eighths
    pat=random.choice([[38,38,45,38,47,38,48,50],[38,0,38,45,0,47,38,49],[50,48,47,45,38,38,0,36]])
    for e,p in enumerate(pat):
      if p: add('drums',tk(bi,e),120,p,82+random.randint(-6,6)+(8 if e%2==0 else 0))
    add('drums',bi*BAR,120,36,80); add('drums',bi*BAR+Q,80,44,60); add('drums',bi*BAR+3*Q,80,44,60)
    continue
  for j in range(4):
    add('drums',bi*BAR+j*Q,Q*0.9,51,62+dv+random.randint(-3,3)+(5 if j%2==1 else 0))
    if j in(1,3): add('drums',bi*BAR+j*Q+SW,120,51,48+dv+random.randint(-3,3))
  for j in (1,3): add('drums',bi*BAR+j*Q,80,44,56+dv)
  for j in range(4): add('drums',bi*BAR+j*Q,100,36,34+random.randint(-2,2))
  if mode!='intro':
    for e in range(8):
      if random.random()<(.16 if mode in('head','headout') else .24): add('drums',tk(bi,e),90,38,46+dv+random.randint(-6,6))
  else:
    add('drums',bi*BAR+Q,90,37,60)
  starts=[s['startBar']-1 for s in sections]
  if bi in starts and bi>0: add('drums',bi*BAR,1600,49,72); add('drums',bi*BAR,120,36,74)
  if bi+1 in starts and mode!='coda':
    for e in (5,6,7): add('drums',tk(bi,e),90,38,70+dv+e)
# horn hits under intro/coda handled by melody; resolve overlaps
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
      f=ARC.get(sec,1.0)*ARC.get(k+'@'+sec,1.0)*ARC.get(k,1.0)
      n['velocity']=max(1,min(127,int(n['velocity']*f)))
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=total*BAR,timeSig=[4,4]),open(f'plan_v{V}.json','w'))
CH={'trumpet':(0,56),'tenor':(1,66),'piano':(2,0),'bass':(3,32),'drums':(9,0)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Cm'),mido.MetaMessage('track_name',name='Ironwood Run')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'ironwood_run_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,'bars',round(mf.length,1),'s')
