# Tidepool Postcard - Juniper Blue. Original bossa nova in F major, 140 BPM, straight eighths.
# Quintet: flute lead, nylon guitar comp, piano, acoustic bass, brushes/cross-stick drums.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1026)
Q=480;E8=240;BAR=1920;BPM=140
Qual={'maj7':[0,4,7,11],'6':[0,4,7,9],'m7':[0,3,7,10],'7':[0,4,7,10],'m7b5':[0,3,6,10]}
Scale={'maj7':[0,2,4,7,9,11],'6':[0,2,4,7,9],'m7':[0,2,3,5,7,9,10],'7':[0,2,4,6,7,9,10],'m7b5':[0,1,3,5,6,8,10]}
Voic={'maj7':[0,4,11,14],'6':[0,4,9,14],'m7':[0,3,10,14],'7':[0,4,10,14],'m7b5':[0,3,6,10]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def bar(*c): return [(PC[r],q) for r,q in (x.split(':') for x in c)]
INTRO=[bar('F:maj7'),bar('Bb:7'),bar('A:m7','D:7'),bar('G:m7','C:7')]
A=[bar('F:maj7'),bar('Bb:7'),bar('A:m7'),bar('D:7'),bar('G:m7'),bar('C:7'),bar('F:maj7'),bar('G:m7','C:7')]
B=[bar('Eb:maj7'),bar('Ab:7'),bar('Db:maj7'),bar('G:m7b5','C:7'),bar('A:m7'),bar('D:7'),bar('G:m7'),bar('C:7')]
A2=A[:6]+[bar('F:maj7'),bar('G:m7','C:7')]
A2end=A[:6]+[bar('F:6'),bar('F:6')]
CODA=[bar('G:m7'),bar('C:7'),bar('Db:maj7'),bar('F:6')]
# melodies: per bar (eighth_pos, pitch, len_eighths), straight eighths
MA=[[(0,81,3),(3,79,1),(4,76,4)],[(1,74,1),(2,77,2),(4,80,3),(7,79,1)],[(0,76,4),(4,72,2),(6,74,2)],[(0,78,3),(3,81,1),(4,84,4)],
    [(0,82,3),(3,81,1),(4,77,2),(6,74,2)],[(0,76,2),(2,79,1),(3,82,5)],[(0,81,6),(6,79,1),(7,77,1)],[(0,74,3),(3,70,1),(4,72,4)]]
MB=[[(1,79,2),(3,82,1),(4,86,4)],[(0,84,3),(3,82,1),(4,78,4)],[(0,77,4),(4,80,2),(6,84,2)],[(0,77,2),(2,73,2),(4,76,2),(6,79,2)],
    [(0,79,3),(3,76,1),(4,72,4)],[(1,78,1),(2,81,2),(4,84,2),(6,83,2)],[(0,82,6),(6,81,1),(7,79,1)],[(0,76,3),(3,74,1),(4,72,2),(6,79,2)]]
MA2=[[(0,81,3),(3,79,1),(4,76,2),(6,77,2)],[(0,74,2),(2,77,1),(3,80,1),(4,82,4)],[(0,84,3),(3,81,1),(4,79,2),(6,76,2)],[(0,78,2),(2,74,2),(4,72,4)],
     [(0,70,2),(2,74,2),(4,77,2),(6,81,2)],[(0,82,3),(3,79,1),(4,76,4)],[(0,77,8)],[(4,74,1),(5,76,1),(6,79,2)]]
MA2end=MA2[:6]+[[(0,77,4),(4,74,4)],[(1,72,1),(2,74,1),(3,77,5)]]
MCODA=[[(0,82,3),(3,81,1),(4,79,4)],[(0,76,3),(3,79,1),(4,82,4)],[(0,80,4),(4,77,4)],[(0,81,8)]]
tr={k:[] for k in('flute','guitar','piano','bass','drums')}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def tk(bi,e): return bi*BAR+e*E8
def chord_at(chs,e): return chs[0] if len(chs)==1 or e<4 else chs[1]
def near(p,pcs,lo,hi):
  c=[x for x in range(lo,hi+1) if x%12 in pcs]; return min(c,key=lambda x:(abs(x-p),x))
def solo(bars,b0,lo,hi,k,vel,start,density):
  # lyrical written solo: chord tones on strong eighths, scale steps between, longer notes, 4-bar phrases
  p=start
  for i,chs in enumerate(bars):
    ph=i%4; e=0
    if ph==0: e=random.choice([1,2])
    while e<8:
      if ph==3 and e>=4: break
      r,q=chord_at(chs,e); ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if e%2==0: p=near(p+random.choice([-4,-3,-2,2,3,4,5]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); c=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(c)
      L=random.choice([1,1,1,2,2,3]) if random.random()<density else 2
      L=min(L,8-e)
      arc=0
      if V>=2: arc=int(10*i/len(bars))  # build through the solo
      add(k,tk(b0+i,e),L*E8*0.92,p,vel+arc+(6 if e%2 else 0)+random.randint(-5,5))
      e+=L
      if random.random()>density: e+=1
    if ph==3:
      r,q=chs[-1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi); add(k,tk(b0+i,2),2*E8*0.95,tgt,vel+4); p=tgt
form=[("Intro",INTRO,None,'intro'),("Head A",A,MA,'head'),("Head B",B,MB,'head'),("Head A'",A2,MA2,'head'),
      ("Flute solo",A+B,None,'flute'),("Piano solo",A,None,'piano'),("Head out A'",A2end,MA2end,'head'),("Coda",CODA,MCODA,'coda')]
b=0;sections=[];allbars=[]
EN={'intro':.35,'head':.6,'flute':.85,'piano':.7,'coda':.4}
for name,chs,mel,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='flute': solo(chs,b,69,91,'flute',80,81,0.75)
  if mode=='piano':
    n0=len(tr['piano']); solo(chs,b,65,89,'piano',76 if V<2 else 94 if V<3 else 104,77,0.7 if V<3 else 0.82)
    if V>=3:  # v3: octave-doubled right-hand line, bossa piano style
      for n in list(tr['piano'][n0:]): add('piano',n['tick'],n['duration'],n['pitch']-12,n['velocity']-14)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if mel:
      for e,p,l in mel[i]: add('flute',tk(bi,e),l*E8*0.94,p,84+(4 if e%2 else 0))
  b+=len(chs)
total=b
last=None
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final= idx==len(allbars)-1
  # bass: bossa root/fifth, dotted-quarter + eighth pattern
  if final:
    add('bass',bi*BAR,BAR*0.95,near(41,[cb[0][0]],28,45),92)
  else:
    halves=[cb[0],cb[0]] if len(cb)==1 else cb
    for h,(r,q) in enumerate(halves):
      root=near(last if last else 38,[r],28,45); fifth=root+(6 if q=='m7b5' else 7)
      if h==0 or len(cb)==2: add('bass',tk(bi,h*4),3*E8*0.9,root,96 if h==0 else 90); last=root
      else: add('bass',tk(bi,4),3*E8*0.9,fifth,88)
      add('bass',tk(bi,h*4+3),E8*0.85,fifth if h==0 or len(cb)==2 else root,80)
  # guitar: 2-bar bossa comp pattern with anticipations (positions in 16 eighths)
  pat2=[0,3,6,10,13] if mode!='intro' or V<2 else [0,3,6,10,13]
  for ci,(r,q) in enumerate(cb):
    root=near(50,[r],45,56); ns=[root+x for x in Voic[q]]
    while ns[-1]>69: ns=[n-12 for n in ns]
    if final:
      for j,n in enumerate(ns): add('guitar',bi*BAR+j*40,BAR*0.95,n,64)
      continue
    lo=ci*4; hi=8 if len(cb)==1 else ci*4+4
    for pos in pat2:
      e=pos-8*(bi%2)
      if lo<=e<hi:
        nxt=e
        add_v=58+random.randint(-5,5)
        for n in ns: add('guitar',tk(bi,e),2*E8*0.85,n,add_v)
  # piano: soft sustained shells in heads, sparse in flute solo, none in piano solo (left hand only)
  if mode in('head','flute','coda','piano','intro'):
    r,q=cb[0]; root=near(52,[r],48,59); ns=[root+Qual[q][1]+12,root+Qual[q][3]+12] if mode!='piano' else [root+Qual[q][1],root+Qual[q][3]]
    if mode=='piano' or (mode=='flute' and bi%2==0) or mode in('head','coda'):
      for n in ns: add('piano',tk(bi,0 if mode!='piano' else 1),BAR*(0.9 if mode!='piano' else 0.4),n,(46 if V<2 else 40) if mode!='piano' else 52)
  # drums: cross-stick clave, closed hat eighths, soft kick following bass
  if final:
    add('drums',bi*BAR,1800,49 if V<2 else 55,70);add('drums',bi*BAR,300,36,70);continue
  for e in range(8):
    if mode=='flute' and V>=2: add('drums',tk(bi,e),150,51,(58 if e%2==0 else 44)+random.randint(-3,3))
    else: add('drums',tk(bi,e),120,42,(54 if e%2==0 else 38)+random.randint(-3,3) if mode!='intro' else 34+random.randint(-3,3))
  for pos in [0,3,6,10,13]:
    e=pos-8*(bi%2)
    if 0<=e<8 and mode!='intro': add('drums',tk(bi,e),100,37,62+random.randint(-4,4))
  for e in (0,3,4,7): add('drums',tk(bi,e),120,36,50 if e in(0,4) else 36)
  if mode!='intro' and random.random()<.4: add('drums',tk(bi,random.choice([2,5,7])),80,70,40)
  starts=[s['startBar']-1 for s in sections]
  if bi in starts and bi>0: add('drums',bi*BAR,1400,55,60)
  if V>=2 and bi+1 in starts:
    for e in (5,6,7): add('drums',tk(bi,e),90,38,44+e*4)
for k,N in tr.items():
  N.sort(key=lambda n:(n['pitch'],n['tick']))
  for a,c in zip(N,N[1:]):
    if a['pitch']==c['pitch'] and a['tick']+a['duration']>c['tick']:
      if a['tick']==c['tick']: c['velocity']=0
      else: a['duration']=max(30,c['tick']-a['tick']-10)
  tr[k]=sorted([n for n in N if n['velocity']>0],key=lambda n:(n['tick'],n['pitch']))
if V>=2:
  ARC={'Intro':.7 if V<3 else .86,'Head A':.88,'Head B':.94,"Head A'":.96,'Flute solo':1.1,'Piano solo':1.0,"Head out A'":.98,'Coda':.8}
  for k,N in tr.items():
    for n in N:
      bi=n['tick']//BAR; sec=[x for x in sections if x['startBar']-1<=bi][-1]['name']
      f=ARC[sec]
      if k=='flute': f*=1.06
      if k=='guitar' and sec=='Flute solo': f*=1.08
      if k=='bass' and sec=='Piano solo': f*=0.85
      if sec=='Coda' and k!='flute': f*=0.9
      n['velocity']=max(1,min(127,int(n['velocity']*f)))
end=total*BAR
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=end),open(f'plan_v{V}.json','w'))
CH={'flute':(0,73),'guitar':(1,24),'piano':(2,0),'bass':(3,32),'drums':(9,0)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('key_signature',key='F'),mido.MetaMessage('track_name',name='Tidepool Postcard')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'tidepool_postcard_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,round(mf.length,1))
