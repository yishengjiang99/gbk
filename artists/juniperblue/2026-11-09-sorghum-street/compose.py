# Sorghum Street - Juniper Blue. Original soul-jazz organ-trio shuffle in F, 4/4, 118 BPM.
# Drawbar organ lead + jazz guitar, percussive organ comping, electric bass (organ left-hand role), shuffle kit.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1109)
Q=480;BAR=1920;BPM=118;SW=315
Qual={'7':[0,4,7,10],'m7':[0,3,7,10],'dim7':[0,3,6,9],'alt':[0,4,10,13]}
Scale={'7':[0,2,3,4,7,9,10],'m7':[0,2,3,5,7,9,10],'dim7':[0,2,3,5,6,8,9,11],'alt':[0,1,3,4,6,8,10]}
Voic={'7':[4,9,10,14],'m7':[3,7,10,14],'dim7':[3,6,9,12],'alt':[4,10,13,15]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bars(*ss): return [tuple(c(x) for x in s.split()) if ' ' in s else (c(s),c(s)) for s in ss]
INTRO=bars('F:7','Bb:7','F:7','G:m7 C:7')
A=bars('F:7','Bb:7','F:7','C:m7 F:7','Bb:7','B:dim7','F:7','A:m7 D:7','G:m7','C:7','F:7 D:7','G:m7 C:7')
AEND=A[:10]+bars('F:7','F:7')
BR=bars('Bb:7','Bb:7','Ab:7','Ab:7','G:m7','C:7','Db:7','C:7')
CODA=bars('F:7 Bb:7','F:7 Bb:7','Db:7 C:7','F:7')
MA=[
 [(1,68,1),(2,69,1),(3,72,2),(5,75,1),(6,72,2)],
 [(0,74,2),(2,72,1),(3,70,1),(4,68,3)],
 [(1,68,1),(2,69,1),(3,72,2),(5,77,1),(6,75,2)],
 [(0,72,2),(2,70,1),(3,67,1),(4,69,2),(6,65,2)],
 [(0,74,1),(1,77,1),(2,80,2),(4,79,1),(5,77,1),(6,74,2)],
 [(0,77,2),(2,74,1),(3,71,1),(4,68,4)],
 [(0,72,3),(3,69,1),(4,68,1),(5,65,3)],
 [(0,67,1),(1,69,1),(2,72,2),(4,78,2),(6,77,1),(7,74,1)],
 [(0,74,2),(2,70,1),(3,74,1),(4,77,2),(6,74,1),(7,70,1)],
 [(0,76,3),(3,72,1),(4,70,2),(6,67,2)],
 [(0,69,2),(2,72,1),(3,69,1),(4,66,2),(6,69,2)],
 [(0,70,2),(2,74,1),(3,70,1),(4,67,1),(5,64,1),(6,67,2)],
]
MEND=MA[:10]+[[(0,69,1),(1,72,1),(2,75,1),(3,77,5)],[(0,77,4)]]
MB=[
 [(0,74,3),(3,77,1),(4,80,4)],
 [(0,79,2),(2,77,1),(3,74,1),(4,70,2),(6,74,2)],
 [(0,72,3),(3,75,1),(4,78,4)],
 [(0,77,2),(2,75,1),(3,72,1),(4,68,2),(6,72,2)],
 [(0,70,1),(1,74,1),(2,77,2),(4,79,1),(5,77,1),(6,74,2)],
 [(0,76,3),(3,79,1),(4,82,2),(6,79,2)],
 [(0,77,2),(2,80,1),(3,83,1),(4,82,2),(6,80,2)],
 [(0,79,2),(2,76,1),(3,72,1),(4,70,2),(6,64,1),(7,67,1)],
]
MCODA=[[(1,68,1),(2,69,1),(3,72,2),(5,74,1),(6,72,2)],[(1,68,1),(2,69,1),(3,72,2),(5,74,1),(6,72,2)],
       [(0,77,2),(2,80,2),(4,79,2),(6,76,2)],[(0,77,8)]]
K=('organ','guitar','comp','bass','drums')
tr={k:[] for k in K}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def tk(bi,e): return bi*BAR+(e//2)*Q+(SW if e%2 else 0)
def dur(e,L): return tk(0,e+L)-tk(0,e) if e+L<=8 else BAR-tk(0,e)
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]
  return min(cand,key=lambda x:(abs(x-p),x)) if cand else max(lo,min(hi,p))
def solo(bl,b0,lo,hi,k,vel,start,density,organ=False):
  p=start;n=len(bl)
  for i,cb in enumerate(bl):
    ph=i%4; e=random.choice([0,1,2]) if ph in(0,2) else 0
    arc=int(10*i/max(1,n-1))
    # organ trademark: repeated blue-note riff in the last chorus, bars 5-8
    if organ and n>=24 and 16<=i<20:
      r,q=cb[0]; top=near(hi-4,[(r+10)%12,(r+7)%12],lo,hi)
      for e2 in (0,1,2,3,4,5,6):
        add(k,tk(b0+i,e2),dur(e2,1)*0.8,top if e2%3!=2 else top-3,vel+arc-2+(-6 if e2%2 else 0))
      continue
    while e<8:
      if ph==3 and e>=6: break
      r,q=cb[e//4]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if e%2==0 and e<6 and random.random()<.18:
        # triplet turn
        d=random.choice([-1,1])
        for j in range(3):
          cc=[x for x in range(p+d,p+d*5,d) if x%12 in sc and lo<=x<=hi]; p=cc[0] if cc else p
          add(k,tk(b0+i,e)+j*Q//3,Q//3*0.9,p,vel+arc-6+random.randint(-3,3))
        e+=2; continue
      if q=='7' and e%2==0 and random.random()<.2:
        # blue-note bend figure: b3 -> 3
        t=near(p,[(r+4)%12],lo+1,hi); add(k,tk(b0+i,e),Q//4,t-1,vel+arc-4); add(k,tk(b0+i,e)+Q//4,dur(e,2)-Q//4,t,vel+arc); p=t; e+=2; continue
      if e%2==0: p=near(p+random.choice([-4,-3,-2,2,3,4]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=1 if random.random()<density else random.choice([2,3])
      L=min(L,8-e)
      add(k,tk(b0+i,e),dur(e,L)*(0.95 if organ else 0.82),p,vel+arc+(-7 if e%2 else 0)+random.randint(-4,4))
      e+=L
      if random.random()>density+0.1: e+=1
    if ph==3:
      r,q=cb[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi)
      add(k,tk(b0+i,6),dur(6,2)*0.9,tgt,vel+arc+2); p=tgt
form=[("Intro",INTRO,'intro'),("Head A",A,'head'),("Head bridge",BR,'head'),("Head A2",A,'head'),
      ("Guitar solo",A+A,'gsolo'),("Organ solo",A+A,'osolo'),
      ("Head out bridge",BR,'headout'),("Head out A",AEND,'headout'),("Coda",CODA,'coda')]
MEL={'Head A':MA,'Head bridge':MB,'Head A2':MA,'Head out bridge':MB,'Head out A':MEND,'Coda':MCODA}
EN={'intro':.5,'head':.7,'gsolo':.8,'osolo':.9,'headout':.8,'coda':.6}
b=0;sections=[];allbars=[]
for name,chs,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='gsolo': solo(chs,b,(55 if V<2 else 60),(81 if V<2 else 84),'guitar',96,(67 if V<2 else 72),0.78)
  if mode=='osolo': solo(chs,b,62,88,'organ',92,72,0.72,organ=True)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if name in MEL:
      for e,p,l in MEL[name][i]:
        v={'head':96,'headout':100,'coda':94}[mode]
        add('organ',tk(bi,e),dur(e,l)*0.92,p,v+(-6 if e%2 else 0))
        add('guitar',tk(bi,e),dur(e,l)*0.85,p-12,v-4+(-6 if e%2 else 0))
  b+=len(chs)
total=b
# Bass: boogaloo/shuffle riff in head/intro/coda, walking in solos
last=None
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  nxt_r=allbars[idx+1][1][0][0] if not final else cb[0][0]
  if final: add('bass',bi*BAR,BAR*0.9,near(29,[cb[0][0]],28,43),100); continue
  if mode in('intro','head','headout','coda'):
    for h in (0,1):
      r,q=cb[h]; root=near(36,[r],28,43); t0=bi*BAR+h*2*Q
      if cb[0]==cb[1]:
        if h==0: add('bass',t0,Q*0.85,root,98); add('bass',t0+Q+SW,140,root,80)
        else:
          dm=q=='dim7'; fifth=root+(6 if dm else 7); add('bass',t0,Q*0.8,fifth,90); add('bass',t0+Q,Q*0.55,root+9,84); add('bass',t0+Q+SW,140,root+(9 if dm else 10),78)
      else:
        add('bass',t0,Q*0.85,root,96); add('bass',t0+Q,Q*0.5,root+7,84); add('bass',t0+Q+SW,140,root+(10 if h==0 else 7),76)
      last=root
    continue
  notes=[]
  for beat in range(4):
    r,q=cb[0 if beat<2 else 1]
    if beat==0: p=near(last if last else 36,[r],28,46)
    elif beat==3:
      tgt=near(last,[nxt_r],28,48); p=tgt+random.choice([-1,1]) if random.random()<.6 else near(last,[(nxt_r+7)%12],28,48)
    else: p=near(last+random.choice([-3,-2,2,3,4]),[(r+x)%12 for x in Qual[q]],28,48)
    notes.append(p); last=p
  for beat,p in enumerate(notes):
    add('bass',bi*BAR+beat*Q,Q*0.8,p,(96 if beat==0 else 86)+random.randint(-3,3))
    if beat==1 and random.random()<.3: add('bass',bi*BAR+beat*Q+SW,120,p,62)
# Comp organ (percussive): stabs and pads; guitar chops on 2&4 in the organ solo
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  for h in (0,1):
    r,q=cb[h]
    ns=[near(53,[r],48,59)+x for x in Voic[q]]
    while ns[-1]>74: ns=[n-12 for n in ns]
    t0=bi*BAR+h*2*Q
    if final:
      for j,n in enumerate(ns+[ns[-1]+5]): add('comp',bi*BAR+j*25,BAR*0.95,n,64)
      for j,n in enumerate([ns[0]+12,ns[1]+12,ns[2]+12]): add('guitar',bi*BAR+j*40,BAR*0.9,n,70)
      break
    base={'intro':62,'head':52,'gsolo':58,'osolo':50,'headout':54,'coda':56}[mode]
    if mode=='gsolo':
      # sustained pads with a pushed restrike
      add_ = [(0,Q*1.6)] if random.random()<.6 else [(Q+SW,Q*0.9)]
    elif mode=='intro':
      add_ = [(Q,Q*0.35),(Q+SW,Q*0.9)]
    else:
      add_ = [random.choice([(SW,Q*0.6),(Q+SW,Q*0.5),(Q,Q*0.3)])]
    for off,L in add_:
      for j,n in enumerate(ns): add('comp',t0+off+j*8,L,n,base+random.randint(-4,4))
    if mode=='osolo':
      gv=[n+12 for n in ns[:3]]
      for j,n in enumerate(gv): add('guitar',t0+Q+j*10,Q*0.28,n,62+random.randint(-4,4))
# Drums: shuffle ride, hat foot 2&4, backbeat (cross-stick in head, snare in solos), ghost notes, kick pattern, fills
starts=[s['startBar']-1 for s in sections]
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  if final:
    add('drums',bi*BAR,2400,51,62); add('drums',bi*BAR,2000,49,84); add('drums',bi*BAR,200,36,92); add('drums',bi*BAR,200,38,78); continue
  dv={'intro':-6,'head':0,'headout':4,'gsolo':4,'osolo':8,'coda':0}[mode]
  for j in range(4):
    add('drums',bi*BAR+j*Q,Q*0.9,51,62+dv+random.randint(-3,3)+(4 if j%2==0 else 0))
    add('drums',bi*BAR+j*Q+SW,120,51,46+dv+random.randint(-3,3))
  for j in (1,3):
    add('drums',bi*BAR+j*Q,80,44,54+dv)
    bb=37 if mode in('intro','head') else 38
    add('drums',bi*BAR+j*Q,120,bb,(78 if bb==37 else 84)+dv+random.randint(-3,3))
  for t,v in ((0,78),(Q+SW,58),(2*Q,70)):
    add('drums',bi*BAR+t,120,36,v+dv//2+random.randint(-3,3))
  if random.random()<.4: add('drums',bi*BAR+3*Q+SW,120,36,56)
  # ghost notes on triplet partials
  for j in range(4):
    for tp in (Q//3,2*Q//3):
      if j not in (1,3) and random.random()<(.28 if mode!='intro' else .15): add('drums',bi*BAR+j*Q+tp,70,38,26+random.randint(-4,4))
  if bi in starts and bi>0: add('drums',bi*BAR,1600,49,74); add('drums',bi*BAR,120,36,84)
  if bi+1 in starts:
    for e,p in ((5,38),(6,45),(7,41)): add('drums',tk(bi,e),90,p,72+dv+e)
# resolve same-pitch overlaps
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
CH={'organ':(0,16),'guitar':(1,26),'comp':(2,17),'bass':(3,33),'drums':(9,0)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='F'),mido.MetaMessage('track_name',name='Sorghum Street')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'sorghum_street_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,'bars',round(mf.length,1),'s')
