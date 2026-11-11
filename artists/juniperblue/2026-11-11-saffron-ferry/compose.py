# Saffron Ferry - Juniper Blue. Original Afro-Cuban 6/8 jazz in G minor, dotted quarter = 100 (quarter 150).
# Flute lead, muted trumpet, piano montuno, acoustic bass, kit + congas/bell/shaker.
import json,sys,random
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1111)
Q=480;E=240;BAR=1440;BPM=150
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
Qual={'m9':[0,3,7,10],'maj7':[0,4,7,11],'lyd':[0,4,7,11],'alt':[0,4,10,15],'13':[0,4,7,10],'m7b5':[0,3,6,10]}
Scale={'m9':[0,2,3,5,7,9,10],'maj7':[0,2,4,5,7,9,11],'lyd':[0,2,4,6,7,9,11],'alt':[0,1,3,4,6,8,10],'13':[0,2,4,5,7,9,10],'m7b5':[0,2,3,5,6,8,10]}
Voic={'m9':[3,7,10,14],'maj7':[4,7,11,14],'lyd':[4,6,11,14],'alt':[4,10,15,20],'13':[4,10,14,21],'m7b5':[3,6,10,15]}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bars(*ss):
  out=[]
  for s in ss:
    ch,n=s.split('*') if '*' in s else (s,'1')
    out+= [c(ch)]*int(n)
  return out
A=bars('G:m9*4','Eb:lyd*2','D:alt*2','G:m9*4','Ab:lyd*2','D:alt*2')
B=bars('C:m9*2','F:13*2','Bb:maj7','Eb:lyd','A:m7b5','D:alt')
INTRO=bars('G:m9*8')
CODA=bars('G:m9*2','Eb:lyd*2','D:alt*2','G:m9*2')
# hand-written head, 2-bar phrases: (eighth 0-11, midi, length in eighths)
PA=[
 [(0,74,2),(2,77,1),(3,79,3),(6,77,1),(7,74,1),(8,72,1),(9,74,3)],
 [(0,70,1),(1,72,1),(2,74,2),(4,72,1),(5,70,1),(6,67,5)],
 [(0,79,2),(2,81,1),(3,82,3),(6,81,1),(7,79,1),(8,74,4)],
 [(0,78,1),(1,75,1),(2,72,1),(3,70,1),(4,66,2),(6,69,3),(9,72,2)],
 [(0,74,2),(2,77,1),(3,79,3),(6,77,1),(7,74,1),(8,72,1),(9,74,3)],
 [(0,70,1),(1,72,1),(2,74,2),(4,77,1),(5,79,1),(6,82,5)],
 [(0,84,2),(2,82,1),(3,79,3),(6,80,2),(8,75,4)],
 [(0,78,2),(2,75,1),(3,74,3),(6,70,1),(7,66,1),(8,67,3)],
]
PB=[
 [(0,75,3),(3,79,1),(4,82,2),(6,81,2),(8,79,1),(9,77,3)],
 [(0,77,2),(2,74,1),(3,72,3),(6,69,1),(7,72,1),(8,74,1),(9,77,3)],
 [(0,74,3),(3,77,3),(6,79,3),(9,74,3)],
 [(0,72,2),(2,75,1),(3,72,1),(4,69,2),(6,78,2),(8,75,1),(9,72,1),(10,70,2)],
]
PEND=PA[:7]+[[(0,78,2),(2,75,1),(3,74,3),(6,70,1),(7,72,1),(8,74,4)]]
PCODA=[PA[0],[(0,79,3),(3,77,3),(6,75,3),(9,74,3)],[(0,78,2),(2,75,1),(3,74,3),(6,70,1),(7,66,1),(8,67,4)],[(0,67,12)]]
K=('flute','trumpet','piano','bass','drums')
tr={k:[] for k in K}
def add(k,t,d,p,v,hum=12):
  t=int(t)+(random.randint(-hum,hum) if k!='drums' else random.randint(-6,6))
  tr[k].append(dict(tick=max(0,t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]
  return min(cand,key=lambda x:(abs(x-p),x)) if cand else max(lo,min(hi,p))
def phrases(bl): return [bl[i:i+2] for i in range(0,len(bl),2)]
def solo(bl,b0,lo,hi,k,vel,start,density):
  p=start;ph=phrases(bl);n=len(ph)
  for i,pc in enumerate(ph):
    arc=int(12*i/max(1,n-1)); e=random.choice([0,1,2,3]) if i%2==0 else 0
    end=12 if i%2==0 else 9
    while e<end:
      r,q=pc[e//6]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if e%3==0 and random.random()<.16 and e+3<=end:
        # descending/ascending four-note run across a dotted quarter
        d=random.choice([-1,1])
        for j in range(3):
          cc=[x for x in range(p+d,p+d*5,d) if x%12 in sc and lo<=x<=hi]; p=cc[0] if cc else p
          add(k,b0*BAR+i*2*BAR+(e+j)*E,E*0.85,p,vel+arc-4+random.randint(-3,3))
        e+=3; continue
      if e%3==0: p=near(p+random.choice([-5,-4,-3,3,4,5]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=1 if random.random()<density else random.choice([2,3])
      L=min(L,end-e)
      add(k,b0*BAR+i*2*BAR+e*E,L*E*0.9,p,vel+arc+(0 if e%3==0 else -8)+random.randint(-4,4))
      e+=L
      if random.random()>density+0.12: e+=1
    if i%2==1:
      r,q=pc[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi)
      add(k,b0*BAR+i*2*BAR+9*E,3*E*0.9,tgt,vel+arc+3); p=tgt
form=[("Intro",INTRO,'intro'),("Head A1",A,'head'),("Head A2",A,'head'),("Head B",B,'head'),("Head A3",A,'head'),
      ("Flute solo",A+A,'fsolo'),("Piano solo",A+B,'psolo'),("Head out B",B,'out'),("Head out A",A,'outend'),("Coda",CODA,'coda')]
MEL={'Head A1':PA,'Head A2':PA,'Head B':PB,'Head A3':PA,'Head out B':PB,'Head out A':PEND,'Coda':PCODA}
EN={'intro':.4,'head':.65,'fsolo':.8,'psolo':.75,'out':.85,'outend':.85,'coda':.5}
b=0;sections=[];allbars=[]
for name,chs,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='fsolo': solo(chs,b,67,93,'flute',90,79,0.7)
  if mode=='psolo':
    n0=len(tr['piano']); solo(chs,b,65,91,'piano',92,76,0.75)
    for n in list(tr['piano'][n0:]):  # latin-piano octaves
      tr['piano'].append(dict(n,pitch=n['pitch']-12,velocity=n['velocity']-10))
  if name in MEL:
    for i,ph in enumerate(MEL[name]):
      for e,p,l in ph:
        t=(b+2*i)*BAR+e*E
        v={'head':92,'out':98,'outend':98,'coda':86}[mode]+(0 if e%3==0 else -6)
        add('flute',t,l*E*0.92,p,v,6)
        tp=p-12 if name in('Head A1','Head A3','Head out A','Coda') else p-5 if name in('Head B','Head out B') else p-9
        if name=='Head A2':
          r,q=chs[2*i+e//6]; tp=near(p-4,[(r+x)%12 for x in Scale[q]],55,78)
        if not(name=='Head A1' and i<4):  # trumpet enters halfway through the first A
          add('trumpet',t,l*E*0.86,tp,v-14,6)
  for i,cb in enumerate(chs): allbars.append((b+i,cb,name,mode))
  b+=len(chs)
total=b
# trumpet background figures behind the flute solo, second chorus
fs=[s for s in sections if s['name']=='Flute solo'][0]
for i in range(16,32,2):
  bi=fs['startBar']-1+i; r,q=allbars[bi][1]
  ns=[near(62,[(r+Qual[q][1])%12],58,70),near(66,[(r+Qual[q][3])%12],60,72)]
  add('trumpet',bi*BAR+3*E,E*5,ns[0],62); add('trumpet',bi*BAR+BAR+0*E,E*2,ns[1],60)
ps=[s for s in sections if s['name']=='Piano solo'][0]
for i in range(16,24):
  bi=ps['startBar']-1+i; r,q=allbars[bi][1]
  add('trumpet',bi*BAR,BAR*0.95,near(64,[(r+Qual[q][1])%12],58,70),54)
# bass: Afro 6/8 tumbao-ish; final bar sustained
last=43
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  r,q=cb; nr,nq=allbars[idx+1][1] if not final else cb
  root=near(38,[r],31,45)
  if final: add('bass',bi*BAR,BAR*1.6,near(31,[r],28,43),96); continue
  fifth=root+(6 if q=='m7b5' else 7)
  if fifth>50: fifth-=12
  ant=near(root,[nr],31,46)
  if mode in('fsolo','psolo','out','outend'):
    pat=[(0,root,2,96),(2,root+12 if root<38 else fifth,1,80),(3,fifth,2,86),(5,ant if nr!=r else root+(10 if q in('m9','13','alt') else 11)-12,1,90)]
  elif mode=='intro' and bi<2:
    pat=[]
  else:
    pat=[(0,root,3,96),(3,fifth,2,84),(5,ant,1,90)]
  for e,p,l,v in pat: add('bass',bi*BAR+e*E,l*E*0.88,p,v+random.randint(-3,3),8)
# piano montuno (comping in solos; left hand only under its own solo)
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  r,q=cb; ns=[near(52,[r],48,59)+x for x in Voic[q]]
  while ns[-1]>76: ns=[n-12 for n in ns]
  if final:
    for j,n in enumerate(ns+[ns[0]+12,ns[2]+12]): add('piano',bi*BAR+j*30,BAR*1.5,n,66,0)
    break
  if mode=='intro' and bi<2: continue
  if mode=='psolo':
    hits=[(0,3,50),(5,1,46)] if bi%2==0 else [(2,2,48)]
    vo=[n for n in ns[:3]]; vo=[n-12 if n>64 else n for n in vo]
  else:
    hits=[(0,1,60),(2,1,54),(3,1,58),(5,1,56)] if bi%2==0 else [(1,1,52),(3,2,60),(5,1,54)]
    vo=ns
    if mode in('fsolo',): hits=[h for h in hits if random.random()<.75]
  base={'intro':-6,'head':-4,'fsolo':-2,'psolo':0,'out':2,'outend':2,'coda':-2}[mode]
  for e,l,v in hits:
    for j,n in enumerate(vo): add('piano',bi*BAR+e*E+j*6,l*E*0.8,n,v+base+random.randint(-4,4),4)
    if mode not in('psolo','intro') and e==0: add('piano',bi*BAR,E*0.8,vo[-1]+12,v+base-4,4)
# drums + percussion
BELL=[0,2,4,5,7,9,11]
starts=[s['startBar']-1 for s in sections]
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1
  t0=bi*BAR
  if final:
    add('drums',t0,2400,49,86); add('drums',t0,200,36,96); add('drums',t0,200,64,80); add('drums',t0,1600,53,70); continue
  dv={'intro':-8,'head':0,'fsolo':4,'psolo':0,'out':6,'outend':6,'coda':-4}[mode]
  # bell pattern (ride bell / cowbell) over a 12/8 cycle = 2 bars
  bell=53 if mode in('fsolo','psolo','out','outend') else 56
  for e in BELL:
    if (bi%2)*6<=e<(bi%2)*6+6: add('drums',t0+(e-(bi%2)*6)*E,E*0.8,bell,(70 if e in(0,7) else 58)+dv+random.randint(-3,3))
  if mode in('fsolo','psolo','out','outend'):
    for e in (0,3): add('drums',t0+e*E,E*2,51,58+dv)
  # hi-hat foot on dotted quarters, shaker on eighths
  for e in (0,3): add('drums',t0+e*E,60,44,50+dv)
  if not (mode=='intro' and bi<4):
    for e in range(6): add('drums',t0+e*E,60,70,(42 if e%3==0 else 32)+dv//2+random.randint(-3,3))
  # kick on 1 and pushed '2'
  add('drums',t0,120,36,80+dv); 
  if mode!='intro' or bi>=2: add('drums',t0+5*E,120,36,62+dv)
  # congas: low/open/mute
  cg=[(0,64,70),(2,62,52),(3,63,76),(4,62,48),(5,63,72)] if bi%2==0 else [(0,64,66),(1,62,46),(3,63,74),(4,63,70),(5,62,50)]
  for e,p,v in cg: add('drums',t0+e*E,90,p,v+dv+random.randint(-4,4))
  # rim click on beat 2 of the 12/8 cycle in head/solos
  if mode not in('intro',) and bi%2==1: add('drums',t0+3*E,80,37,64+dv)
  if bi in starts and bi>0: add('drums',t0,1600,49,76); add('drums',t0,120,36,88)
  if bi+1 in starts:
    for e,p in ((3,38),(4,45),(5,41)): add('drums',t0+e*E,90,p,72+dv+e*2)
for k,N in tr.items():
  N.sort(key=lambda n:(n['pitch'],n['tick']))
  for a,cn in zip(N,N[1:]):
    if a['pitch']==cn['pitch'] and a['tick']+a['duration']>cn['tick']:
      if abs(a['tick']-cn['tick'])<20: cn['velocity']=0
      else: a['duration']=max(30,cn['tick']-a['tick']-10)
  tr[k]=sorted([n for n in N if n['velocity']>0],key=lambda n:(n['tick'],n['pitch']))
ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
if ARC:
  for k,N in tr.items():
    for n in N:
      bi=n['tick']//BAR; sec=[x for x in sections if x['startBar']-1<=bi][-1]['name']
      f=ARC.get(sec,1.0)*ARC.get(k+'@'+sec,1.0)*ARC.get(k,1.0)
      n['velocity']=max(1,min(127,int(n['velocity']*f)))
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=total*BAR+2*BAR,timeSig=[6,8],barSec=60/BPM*3),open(f'plan_v{V}.json','w'))
import mido
mf=mido.MidiFile(ticks_per_beat=Q);t=mido.MidiTrack();mf.tracks.append(t)
t.append(mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)));t.append(mido.MetaMessage('time_signature',numerator=6,denominator=8))
CH={'flute':(0,73),'trumpet':(1,59),'piano':(2,0),'bass':(3,32),'drums':(9,0)}
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k))
  if ch!=9: t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'saffron_ferry_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,'bars',round(mf.length,1),'s')
