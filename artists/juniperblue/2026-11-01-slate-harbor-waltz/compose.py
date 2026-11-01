# Slate Harbor Waltz - Juniper Blue. Original modal jazz waltz in D dorian, 3/4, 150 BPM, swung eighths.
# Quintet: vibraphone and muted trumpet, piano, upright bass, brushes/ride drums.
import json,sys,random,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1101)
Q=480;BAR=1440;BPM=150;SW=320
Qual={'maj7':[0,4,7,11],'m7':[0,3,7,10],'7':[0,4,7,10],'m7b5':[0,3,6,10]}
Scale={'maj7':[0,2,4,6,7,9,11],'m7':[0,2,3,5,7,9,10],'7':[0,1,3,4,7,9,10],'m7b5':[0,1,3,5,6,8,10]}
Voic={'maj7':[4,11,14,18],'m7':[3,7,10,14],'7':[4,10,13,21],'m7b5':[3,6,10,13]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def c(s): r,q=s.split(':'); return (PC[r],q)
INTRO=[c('D:m7')]*4
A=[c('D:m7')]*4+[c('Eb:maj7')]*4+[c('D:m7')]*2+[c('G:m7')]*2+[c('Bb:maj7'),c('A:7'),c('D:m7'),c('A:7')]
B=[c('Bb:maj7')]*2+[c('A:m7')]*2+[c('G:m7'),c('C:7'),c('E:m7b5'),c('A:7')]
Aend=A[:14]+[c('D:m7'),c('D:m7')]
CODA=[c('Eb:maj7'),c('Eb:maj7'),c('D:m7'),c('D:m7')]
# melodies: per bar (eighth_pos 0-5, pitch, len_eighths)
MA=[[(0,74,2),(2,77,1),(3,81,3)],[(0,79,2),(2,76,1),(3,77,3)],[(0,74,1),(1,76,1),(2,77,1),(3,79,1),(4,81,2)],[(0,83,6)],
    [(0,82,2),(2,79,1),(3,81,3)],[(0,86,4),(4,84,2)],[(0,82,2),(2,79,2),(4,75,2)],[(0,77,6)],
    [(1,81,1),(2,84,2),(4,81,2)],[(0,77,3),(3,76,1),(4,74,2)],[(0,82,2),(2,81,1),(3,79,3)],[(0,74,2),(2,77,2),(4,82,2)],
    [(0,81,4),(4,79,2)],[(0,77,2),(2,76,1),(3,73,3)],[(0,74,6)],[(2,76,1),(3,79,1),(4,73,2)]]
MB=[[(0,74,3),(3,72,1),(4,69,2)],[(0,70,2),(2,74,2),(4,77,2)],[(0,76,4),(4,72,2)],[(0,79,3),(3,76,1),(4,74,2)],
    [(0,74,2),(2,70,1),(3,72,3)],[(0,76,2),(2,79,2),(4,82,2)],[(0,81,3),(3,79,1),(4,77,2)],[(0,76,2),(2,73,2),(4,69,2)]]
MAend=MA[:14]+[[(0,74,3),(3,77,3)],[(0,74,6)]]
MCODA=[[(0,81,6)],[(0,79,3),(3,82,3)],[(0,76,6)],[(0,74,6)]]
tr={k:[] for k in('vibes','trumpet','piano','bass','drums')}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def tk(bi,e): return bi*BAR+(e//2)*Q+(SW if e%2 else 0)
def dur(e,L): return tk(0,e+L)-tk(0,e) if e+L<=6 else BAR-tk(0,e)
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]; return min(cand,key=lambda x:(abs(x-p),x))
def solo(bars,b0,lo,hi,k,vel,start,density):
  p=start
  for i,(r,q) in enumerate(bars):
    ph=i%4; e=random.choice([1,2]) if ph==0 else 0
    ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
    while e<6:
      if ph==3 and e>=3: break
      if e%2==0: p=near(p+random.choice([-4,-3,-2,2,3,4,5]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=random.choice([1,1,1,2,2,3]) if random.random()<density else 2
      L=min(L,6-e); arc=int(10*i/len(bars)) if V>=2 else 0
      add(k,tk(b0+i,e),dur(e,L)*0.9,p,vel+arc+(-6 if e%2 else 0)+random.randint(-5,5))
      e+=L
      if random.random()>density: e+=1
    if ph==3:
      tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi); add(k,tk(b0+i,3),dur(3,3)*0.95,tgt,vel+4); p=tgt
form=[("Intro",INTRO,None,None,'intro'),("Head A",A,MA,'vibes','head'),("Head B",B,MB,'trumpet','head'),
      ("Vibes solo",A,None,None,'vsolo'),("Trumpet solo",B+B,None,None,'tsolo'),("Head out A",Aend,MAend,'both','head'),("Coda",CODA,MCODA,'both','coda')]
EN={'intro':.3,'head':.55,'vsolo':.8,'tsolo':.85,'coda':.35}
b=0;sections=[];allbars=[]
for name,chs,mel,who,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='vsolo': solo(chs,b,65,89,'vibes',84,77,0.75)
  if mode=='tsolo': solo(chs,b,58,81,'trumpet',100,69,0.72)
  for i,cb in enumerate(chs):
    bi=b+i; allbars.append((bi,cb,name,mode))
    if mel:
      for e,p,l in mel[i]:
        if who in('vibes','both'): add('vibes',tk(bi,e),dur(e,l)*0.95,p,86+(-4 if e%2 else 0))
        if who=='trumpet': add('trumpet',tk(bi,e),dur(e,l)*0.92,p,104+(-4 if e%2 else 0))
        if who=='both': add('trumpet',tk(bi,e),dur(e,l)*0.92,p-12,80+(-4 if e%2 else 0))
  b+=len(chs)
total=b;last=None
COMP=[[(0,2)],[(0,1),(3,2)],[(3,3)],[(2,1),(5,1)],[(0,2),(4,2)]]
for idx,(bi,(r,q),name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  nxt=allbars[idx+1][1] if not final else (r,q)
  root=near(last if last else 38,[r],28,45)
  # bass: 2-feel (1 and 3) in intro/heads/coda, walking quarters in solos
  if final: add('bass',bi*BAR,BAR*0.95,near(38,[r],28,45),90)
  elif mode in('vsolo','tsolo'):
    nr=near(root,[nxt[0]],28,47); ap=nr+random.choice([-1,1])
    mid=near(root+random.choice([3,4,7]),[(r+x)%12 for x in Qual[q]],28,50)
    for j,p in enumerate([root,mid,ap]): add('bass',bi*BAR+j*Q,Q*0.88,p,(96 if j==0 else 84)+random.randint(-4,4))
  else:
    add('bass',bi*BAR,2*Q*0.9,root,94); add('bass',bi*BAR+2*Q,Q*0.85,root+(6 if q=='m7b5' else 7),82)
  last=root
  # piano: rootless voicings, waltz comping patterns; sparse under the trumpet head
  ns=[near(50,[r],45,56)+x for x in Voic[q]]
  while ns[-1]>74: ns=[n-12 for n in ns]
  if final:
    for j,n in enumerate(ns): add('piano',bi*BAR+j*30,BAR*0.95,n,56)
  elif mode=='intro':
    for j,n in enumerate(ns): add('piano',bi*BAR+j*20,BAR*0.9,n,50 if bi%2==0 else 44)
  else:
    pat=random.choice(COMP) if mode!='coda' else [(0,6)]
    for e,L in pat:
      v=(58 if mode=='head' else 64)+random.randint(-5,5)
      for n in ns: add('piano',tk(bi,e),dur(e,L)*0.8,n,v)
  if V>=4 and mode=='tsolo' or (V>=4 and name=='Head B'):
    if bi%2==0 or mode=='tsolo':
      sh=[near(64,[(r+Qual[q][1])%12],60,71)]; sh+= [near(sh[0]+4,[(r+Qual[q][3])%12],sh[0]+1,sh[0]+9), near(sh[0]+9,[(r+(14 if q!='m7b5' else 13))%12],sh[0]+5,sh[0]+15)]
      e0=0 if bi%2==0 else 3
      for n in sh: add('vibes',tk(bi,e0),dur(e0,3)*0.9,n,56 if mode=='tsolo' else 48)
  # drums: jazz waltz ride (1, 2, 2&, 3), hat foot on 2, feathered kick on 1, cross-stick on 3 in heads
  if final:
    add('drums',bi*BAR,1800,55,64);add('drums',bi*BAR,300,36,60);continue
  ride=51 if mode!='intro' else 59
  for e,v in [(0,58),(2,52),(3,40),(4,54)]:
    if mode=='intro' and e==3: continue
    add('drums',tk(bi,e),150,ride,v+random.randint(-3,3)-(10 if mode=='intro' else 0))
  add('drums',tk(bi,2),120,44,44); add('drums',bi*BAR,150,36,42)
  if mode in('head','coda'): add('drums',tk(bi,4),100,37,54+random.randint(-4,4))
  if mode in('vsolo','tsolo') and random.random()<.45: add('drums',tk(bi,random.choice([1,3,5])),80,38,34+random.randint(0,10))
  starts=[s['startBar']-1 for s in sections]
  if bi in starts and bi>0: add('drums',bi*BAR,1400,49,58)
  if V>=2 and bi+1 in starts:
    for e in (3,4,5): add('drums',tk(bi,e),90,38,42+e*4)
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
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=total*BAR,timeSig=[3,4]),open(f'plan_v{V}.json','w'))
CH={'vibes':(0,11),'trumpet':(1,56),'piano':(2,0),'bass':(3,32),'drums':(9,0)}
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=3,denominator=4),mido.MetaMessage('key_signature',key='Dm'),mido.MetaMessage('track_name',name='Slate Harbor Waltz')]
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'slate_harbor_waltz_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,round(mf.length,1))
