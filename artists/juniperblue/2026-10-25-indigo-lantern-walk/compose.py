# Indigo Lantern Walk - Juniper Blue. Original medium-swing tune in Bb, piano/bass/drums + tenor sax.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1025)
Q=480;BAR=1920;BPM=168
Qual={'maj7':[0,4,7,11],'6':[0,4,7,9],'m7':[0,3,7,10],'7':[0,4,7,10],'m7b5':[0,3,6,10]}
Scale={'maj7':[0,2,4,5,7,9,11],'6':[0,2,4,5,7,9,11],'m7':[0,2,3,5,7,9,10],'7':[0,2,4,5,7,9,10],'m7b5':[0,1,3,5,6,8,10]}
Voic={'maj7':[4,7,11,14],'6':[4,7,9,14],'m7':[3,7,10,14],'7':[10,14,16,21],'m7b5':[3,6,10,12]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def bar(*c):
  c=[x.split(':') for x in c]; return [(PC[r],q) for r,q in c]
A1=[bar('Bb:maj7'),bar('G:m7','C:7'),bar('C:m7','F:7'),bar('Bb:maj7','G:7'),bar('C:m7'),bar('F:7'),bar('D:m7','G:7'),bar('C:m7','F:7')]
A2=[bar('Bb:maj7'),bar('Bb:7'),bar('Eb:maj7'),bar('Ab:7'),bar('D:m7','G:7'),bar('C:m7','F:7'),bar('Bb:maj7','G:7'),bar('C:m7','F:7')]
A2end=A2[:6]+[bar('Bb:6'),bar('Bb:6')]
INTRO=[bar('C:m7','F:7'),bar('D:m7','G:7'),bar('C:m7','F:7'),bar('C:m7','F:7')]
# head melody: per bar list of (eighth_pos, pitch, len_eighths)
H1=[[(1,74,1),(2,77,1),(3,69,3),(6,67,2)],[(0,70,2),(2,74,1),(3,76,3)],[(0,75,1),(1,74,1),(2,72,2),(4,69,1),(5,72,1),(6,75,2)],[(0,74,4),(4,71,2)],
    [(1,67,1),(2,70,1),(3,74,1),(4,75,4)],[(2,75,1),(3,74,1),(4,72,1),(5,69,1),(6,65,2)],[(0,69,2),(2,72,2),(4,77,2),(6,74,1),(7,71,1)],[(0,72,3),(4,69,1),(5,70,1),(6,72,2)]]
H2=[[(1,74,1),(2,77,1),(3,81,3),(6,79,2)],[(0,80,2),(2,77,1),(3,74,1),(4,70,2),(6,68,2)],[(0,67,3),(3,70,1),(4,74,4)],[(0,72,1),(1,75,1),(2,78,3),(5,77,1),(6,75,2)],
    [(0,74,2),(2,77,1),(3,69,1),(4,71,2),(6,74,1),(7,77,1)],[(0,75,2),(2,74,1),(3,72,1),(4,69,2),(6,65,1),(7,69,1)],[(0,70,8)],[(4,72,1),(5,74,1),(6,75,1),(7,76,1)]]
H2end=H2[:6]+[[(0,70,6),(6,74,2)],[(0,77,2),(2,70,6)]]
def tick(bi,e): return bi*BAR+(e//2)*Q+(320 if e%2 else 0)
def dur(e,l): # swung length
  s=(e//2)*Q+(320 if e%2 else 0); f=e+l; t=(f//2)*Q+(320 if f%2 else 0); return t-s
tr={k:[] for k in('sax','piano','bass','drums')}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def chord_at(chs,e): return chs[0] if len(chs)==1 or e<4 else chs[1]
def near(p,pcs,lo,hi):
  c=[x for x in range(lo,hi+1) if x%12 in pcs]; return min(c,key=lambda x:abs(x-p))
def solo(bars,b0,lo,hi,k,vel,start,density):
  p=start;out=[]
  for i,chs in enumerate(bars):
    phrase=(i%4)
    for e in range(8):
      rest = (phrase==3 and e>=4) or (phrase==0 and e==0) or random.random()>density
      if rest: continue
      r,q=chord_at(chs,e); ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if e%2==0: p=near(p+random.choice([-3,-2,2,3,4]) ,ct,lo,hi)
      else:
        step=random.choice([-2,-1,1,2]) if random.random()<.8 else random.choice([-5,5])
        cand=[x for x in range(p+step-1,p+step+2) if x%12 in sc and lo<=x<=hi] or [p]
        p=cand[0]
        # chromatic approach into next chord tone
        if e in(3,7) and random.random()<.35: p=p+random.choice([-1,1])
      acc=12 if e%2 else 0  # bop accents on upbeats
      add(k,tick(b0+i,e),dur(e,1)*0.92,p,vel+acc+random.randint(-6,4)+(8 if V>=2 and i>=len(bars)//2 else 0))
    if V>=2 and phrase==3: # end-of-phrase long note on 3rd/7th
      r,q=chs[-1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi); add(k,tick(b0+i,2),dur(2,2),tgt,vel+6); p=tgt
form=[("Intro",INTRO,None,'none'),("Head A",A1,H1,'head'),("Head A'",A2,H2,'head'),("Tenor solo",A1+A2,None,'sax'),("Piano solo",A1+A2,None,'piano'),("Head out A",A1,H1,'head'),("Head out A'",A2end,H2end,'head')]
b=0;sections=[];last_root=None
allbars=[]
for name,chs,mel,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy={'none':.4,'head':.7,'sax':.85,'piano':.8}[mode]))
  if mode=='sax': solo(chs,b,60,82,'sax',78,70,0.9 if V>=2 else 0.85)
  if mode=='piano': solo(chs,b,67,91,'piano',72,77,0.8)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if mel:
      for e,p,l in mel[i]: add('sax',tick(bi,e),dur(e,l)*0.95,p,(92 if e%2 else 86)+(4 if 'out' in name else 0))
  b+=len(chs)
total=b
for idx,(bi,cb,name,mode) in enumerate(allbars):
  nxt=allbars[idx+1][1][0][0] if idx+1<len(allbars) else 10
  final= idx==len(allbars)-1
  # bass walk
  beats=[cb[0]]*2+[cb[-1]]*2
  for be in range(4):
    r,q=beats[be]
    if final and be>0: break
    if be==0 or (len(cb)==2 and be==2): pc=r
    elif be==3: pc=(nxt+random.choice([-1,1,7]))%12
    else: pc=(r+random.choice(Qual[q][1:]+[Scale[q][1]]))%12
    p=near(last_root if last_root else 34,[pc],28,50); last_root=p
    add('bass',bi*BAR+be*Q,Q*(0.9 if not final else 3.8),p,96+(6 if be==0 else 0)+random.randint(-5,5))
  # piano comp (sparser under piano solo: left hand shells)
  for ci,(r,q) in enumerate(cb):
    vs=[r+x for x in Voic[q]]
    base=min(range(48,60),key=lambda x:abs(x+ (vs[0]-r) -55) if (x%12)==r else 99)
    ns=[base+x-r for x in vs]
    if mode=='piano': ns=ns[:2]
    half=4 if len(cb)==2 else 8
    e0=ci*4
    pats=[[0],[0,3],[1],[3]] if half==4 else [[0,3],[0,5],[1,6],[2,7]]
    pat=random.choice(pats) if mode!='none' or V<2 else [0]
    if final: pat=[0]
    for e in pat:
      d=dur(e0+e,1 if e%2==0 else 2)*0.9 if not final else BAR*0.95
      vel=(58 if mode in('sax',) else 62 if mode!='piano' else 54)+random.randint(-6,6)
      for n in ns: add('piano',tick(bi,e0+e),d,n,vel)
  # drums: ride spang-a-lang, hats 2&4, feathered kick, snare comping
  if final:
    add('drums',bi*BAR,1600,49,100);add('drums',bi*BAR,400,36,90);continue
  rv=70 if mode!='none' else 58
  for be in range(4):
    add('drums',bi*BAR+be*Q,200,51,rv+(10 if be%2 else 0)+random.randint(-4,4))
    if be%2: add('drums',bi*BAR+be*Q+320,140,51,rv-12+random.randint(-4,4)); add('drums',bi*BAR+be*Q,100,44,62)
    add('drums',bi*BAR+be*Q,120,36,30)
  if mode in('sax','head') and random.random()<.5: add('drums',tick(bi,random.choice([3,5,7])),100,38,48+random.randint(0,12))
  if idx in [s['startBar']-1 for s in sections] and idx>0: add('drums',bi*BAR,1200,49,92)
  if V>=2 and idx+1 in [s['startBar']-1 for s in sections]:
    for e in (4,5,6,7): add('drums',tick(bi,e),100,38,70+e*4)
for k,N in tr.items():
  N.sort(key=lambda n:(n['pitch'],n['tick']))
  for a,c in zip(N,N[1:]):
    if a['pitch']==c['pitch'] and a['tick']+a['duration']>c['tick']:
      if a['tick']==c['tick']: c['velocity']=0
      else: a['duration']=max(30,c['tick']-a['tick']-10)
  tr[k]=sorted([n for n in N if n['velocity']>0],key=lambda n:(n['tick'],n['pitch']))
end=total*BAR
if V>=2:  # dynamic arc: scale velocities per section energy
  E={'Intro':.72,'Head A':.9,"Head A'":.95,'Tenor solo':1.08,'Piano solo':.95,'Head out A':1.0,"Head out A'":1.04}
  for k,N in tr.items():
    for n in N:
      bi=n['tick']//BAR; sec=[x for x in sections if x['startBar']-1<=bi][-1]['name']
      f=E[sec]*(1.08 if k=='sax' else 1)
      if sec=='Tenor solo': f*=0.95+0.12*((bi-(sections[3]['startBar']-1))/16)
      n['velocity']=max(1,min(127,int(n['velocity']*f)))
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=end),open(f'plan_v{V}.json','w'))
CH={'sax':(0,66),'piano':(1,0),'bass':(2,32),'drums':(9,0)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('key_signature',key='Bb'),mido.MetaMessage('track_name',name='Indigo Lantern Walk')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f'indigo_lantern_walk_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,round(mf.length,1))
