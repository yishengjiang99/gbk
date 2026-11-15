# Tinsmith Wheel - Juniper Blue. Original gypsy-jazz (manouche) swing in D minor, 200 BPM, 4/4.
# Violin lead, lead steel guitar, rhythm guitar (la pompe), upright bass, light brushes.
import json,sys,random
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1113)
Q=480;BAR=1920;BPM=200;SW=272  # swung offbeat eighth
PC={'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
Qual={'m6':[0,3,7,9],'7':[0,4,7,10],'7b9':[0,4,7,10,13],'dim':[0,3,6,9],'m7b5':[0,3,6,10],'maj7':[0,4,7,11]}
Scale={'m6':[0,2,3,5,7,9,11],'7':[0,2,4,5,7,9,10],'7b9':[0,1,4,5,7,8,10],'dim':[0,2,3,5,6,8,9,11],'m7b5':[0,1,3,5,6,8,10],'maj7':[0,2,4,5,7,9,11]}
Voic={'m6':[7,9,15,19],'7':[4,10,16,19],'7b9':[4,10,13,19],'dim':[3,6,9,12],'m7b5':[3,6,10,15],'maj7':[4,7,11,16]}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bar(s):  # "Dm" or "E:m7b5/A:7b9" -> two half-bar chords
  h=s.split('/'); return [c(h[0]),c(h[-1])]
def bars(*ss):
  out=[]
  for s in ss:
    ch,n=s.split('*') if '*' in s else (s,'1'); out+=[bar(ch)]*int(n)
  return out
A1=bars('D:m6*2','G:m6','G:m6/C#:dim','D:m6','Bb:7','E:m7b5/A:7b9','D:m6/A:7b9')
A2=A1[:7]+bars('D:m6/A:7')
B=bars('D:7*2','G:m6*2','Bb:7','A:7b9','D:m6/B:m7b5','E:m7b5/A:7b9')
INTRO=bars('D:m6*2','A:7b9*2','D:m6','G:m6/C#:dim','E:m7b5/A:7b9','A:7b9')
CODA=bars('E:m7b5/A:7b9','D:m6','E:m7b5/A:7b9','D:m6','Bb:7/A:7b9','D:m6*2')
# hand-written head: per bar list of (eighth 0-7, midi, length in eighths)
MA=[
 [(0,69,1),(1,74,1),(2,77,1),(3,81,3),(6,83,1),(7,81,1)],
 [(0,77,2),(2,74,1),(3,73,1),(4,74,4)],
 [(0,70,1),(1,74,1),(2,79,1),(3,82,3),(6,76,1),(7,79,1)],
 [(0,77,2),(2,76,1),(3,74,1),(4,73,2),(6,76,1),(7,79,1)],
 [(0,81,3),(3,77,1),(4,74,2),(6,71,1),(7,74,1)],
 [(0,77,1),(1,79,1),(2,80,1),(3,79,1),(4,77,2),(6,74,1),(7,70,1)],
 [(0,67,1),(1,70,1),(2,74,1),(3,76,1),(4,73,1),(5,70,1),(6,69,1),(7,67,1)],
]
MA1=MA+[[(0,65,1),(1,69,1),(2,74,2),(4,73,1),(5,76,1),(6,79,1),(7,82,1)]]
MA2=MA+[[(0,74,4),(4,76,1),(5,79,1),(6,81,2)]]
MA3=MA+[[(0,74,6)]]
MB=[
 [(0,78,3),(3,81,1),(4,84,2),(6,81,1),(7,78,1)],
 [(0,74,1),(1,75,1),(2,78,1),(3,81,1),(4,84,3),(7,82,1)],
 [(0,82,3),(3,79,1),(4,76,2),(6,74,1),(7,79,1)],
 [(0,82,1),(1,81,1),(2,79,1),(3,76,1),(4,74,4)],
 [(0,77,1),(1,80,1),(2,82,1),(3,86,3),(6,84,1),(7,82,1)],
 [(0,81,2),(2,82,1),(3,81,1),(4,79,1),(5,76,1),(6,73,2)],
 [(0,74,2),(2,77,1),(3,81,1),(4,83,3),(7,81,1)],
 [(0,79,2),(2,76,1),(3,74,1),(4,73,1),(5,76,1),(6,79,1),(7,82,1)],
]
MCODA=[MA[6],[(0,74,2),(2,77,1),(3,81,5)],MA[6],[(0,74,2),(2,77,1),(3,81,5)],
 [(0,77,1),(1,79,1),(2,80,1),(3,82,1),(4,81,1),(5,79,1),(6,76,1),(7,73,1)],[(0,74,8)],[(0,74,6)]]
# guitar intro lick (bars 5-8)
GINT=[[(0,62,1),(1,65,1),(2,69,1),(3,71,1),(4,74,2),(6,73,1),(7,74,1)],
 [(0,70,2),(2,67,1),(3,64,1),(4,61,2),(6,64,1),(7,67,1)],
 [(0,70,1),(1,69,1),(2,67,1),(3,64,1),(4,61,1),(5,64,1),(6,67,1),(7,70,1)],
 [(0,73,3),(3,70,1),(4,67,1),(5,64,1),(6,61,1),(7,64,1)]]
K=('violin','guitar','rhythm','bass','drums')
tr={k:[] for k in K}
def et(e): return (e//2)*Q+(SW if e%2 else 0)
def add(k,t,d,p,v,hum=10):
  t=int(t)+random.randint(-hum,hum)
  tr[k].append(dict(tick=max(0,t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]
  return min(cand,key=lambda x:(abs(x-p),x)) if cand else max(lo,min(hi,p))
def mel(k,b0,M,vel,trans=0,dur=0.92,hum=6):
  for i,ph in enumerate(M):
    for e,p,l in ph:
      t=(b0+i)*BAR+et(e); end=(b0+i)*BAR+et(e+l) if e+l<8 else (b0+i)*BAR+et(e)+l*240
      add(k,t,max(60,(end-t))*dur,p+trans,vel+(4 if e%2==0 else -6)+(3 if l>=3 else 0),hum)
def solo(bl,b0,lo,hi,k,vel,start,density):
  p=start;n=len(bl)
  for i,ch in enumerate(bl):
    arc=int(10*i/max(1,n-1)); phrase_end=(i%4==3) or (i%2==1 and random.random()<.35)
    e=random.choice([0,0,1,2]) if i%4==0 else 0
    end=5 if phrase_end else 8
    while e<end:
      r,q=ch[0 if e<4 else 1]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if e%2==0 and e+2<=end and random.random()<.17:
        # gypsy triplet arpeggio up through chord tones, one beat
        bt=(b0+i)*BAR+(e//2)*Q; up=[x for x in range(p-2,hi+1) if x%12 in ct][:3]
        if len(up)==3:
          for j,x in enumerate(up): add(k,bt+j*160,150,x,vel+arc-3+j*2,4)
          p=up[-1]; e+=2; continue
      if e%2==0 and random.random()<.55: p=near(p+random.choice([-5,-4,-3,3,4,5,7,-7]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,-1,1,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=1 if random.random()<density else random.choice([2,3])
      L=min(L,end-e)
      t=(b0+i)*BAR+et(e); t2=(b0+i)*BAR+et(e+L) if e+L<8 else (b0+i+1)*BAR
      add(k,t,(t2-t)*0.88,p,vel+arc+(0 if e%2==0 else -7)+random.randint(-4,4),6)
      e+=L
      if random.random()>density+0.15: e+=1
    if phrase_end:
      r,q=ch[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][2])%12],lo,hi)
      add(k,(b0+i)*BAR+et(5),(BAR-et(5))*0.9+300,tgt,vel+arc+4,6); p=tgt
form=[("Intro",INTRO,'intro'),("Head A1",A1,'head'),("Head A2",A2,'head'),("Head B",B,'head'),("Head A3",A1,'head'),
      ("Guitar solo",A1+A2+B+A1,'gsolo'),("Violin solo",A1+A2+B+A1,'vsolo'),
      ("Head out A",A1,'out'),("Head out A2",A2,'out'),("Head out B",B,'out'),("Head out A3",A1,'out'),("Coda",CODA,'coda')]
MEL={'Head A1':MA1,'Head A2':MA2,'Head B':MB,'Head A3':MA3,'Head out A':MA1,'Head out A2':MA2,'Head out B':MB,'Head out A3':MA1,'Coda':MCODA}
EN={'intro':.45,'head':.65,'gsolo':.8,'vsolo':.85,'out':.9,'coda':.6}
b=0;sections=[];allbars=[]
for name,chs,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='gsolo': solo(chs,b,55,84,'guitar',92,67,0.78)
  if mode=='vsolo': solo(chs,b,67,93,'violin',90,81,0.72)
  if mode=='intro': mel('guitar',b+4,GINT,90,0,0.9,4)
  if name in MEL:
    v={'head':88,'out':94,'coda':86}[mode]
    mel('violin',b,MEL[name],v)
    # guitar doubles an octave below in the head-out A sections and coda; answers in head B
    if mode in('out','coda') and name!='Head out B': mel('guitar',b,MEL[name],v-14,-12,0.8,8)
  for i,cb in enumerate(chs): allbars.append((b+i,cb,name,mode))
  b+=len(chs)
total=b
# violin pads behind the second half of the guitar solo
gs=[s for s in sections if s['name']=='Guitar solo'][0]
for i in range(16,32):
  bi=gs['startBar']-1+i; r,q=allbars[bi][1][0]
  add('violin',bi*BAR,BAR*0.96,near(76,[(r+Qual[q][1])%12],70,82),56,4)
# guitar fills in the head bridge
hb=[s for s in sections if s['name'] in('Head B','Head out B')]
for s in hb:
  for i in (1,3,5):
    bi=s['startBar']-1+i; r,q=allbars[bi][1][1]; ct=[(r+x)%12 for x in Qual[q]]
    ps=[x for x in range(60,76) if x%12 in ct][:4]
    for j,x in enumerate(ps): add('guitar',bi*BAR+Q*2+j*160+(SW-240 if j%2 else 0),150,x,70+j*3,4)
# rhythm guitar: la pompe. beats 1/3 short low "boom", 2/4 shorter full-chord "chick"
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1; t0=bi*BAR
  base={'intro':-4,'head':-2,'gsolo':-6,'vsolo':-4,'out':0,'coda':-2}[mode]
  for beat in range(4):
    r,q=cb[beat//2]; root=near(48,[r],45,56)
    vo=[root]+[near(root+x,[(r+x)%12],root+1,root+24) for x in Voic[q]]
    vo=sorted(set(vo))
    if final and beat>0: break
    if final:
      for j,n in enumerate(vo): add('rhythm',t0+j*25,BAR*0.9,n,72,0)
      break
    t=t0+beat*Q
    if beat%2==0:
      for j,n in enumerate(vo[:3]): add('rhythm',t+j*7,130,n,52+base+random.randint(-3,3),3)
    else:
      for j,n in enumerate(vo[1:]): add('rhythm',t+j*6,95,n,74+base+random.randint(-3,3),3)
# bass: two-feel in intro/head/coda, walking in solos/head out
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1; t0=bi*BAR
  nxt=allbars[idx+1][1][0] if not final else cb[0]
  if final: add('bass',t0,BAR*1.2,near(38,[cb[0][0]],33,45),100); continue
  walk=mode in('gsolo','vsolo','out')
  for h in range(2):
    r,q=cb[h]; root=near(38,[r],33,45)
    if not walk:
      add('bass',t0+h*2*Q,Q*1.6,root,96+random.randint(-3,3),6)
    else:
      nr=(cb[1] if h==0 else nxt)[0]; nroot=near(root,[nr],33,47)
      appr=nroot+random.choice([-1,1]) if nroot!=root else root+(Qual[q][2] if random.random()<.5 else Qual[q][1])
      if appr<31: appr+=12
      add('bass',t0+h*2*Q,Q*0.85,root,98+random.randint(-3,3),6)
      add('bass',t0+h*2*Q+Q,Q*0.85,appr,84+random.randint(-3,3),6)
# light brushes: soft snare swish on 2/4, hat foot on 2/4, ride-ish brush in solos
starts=[s['startBar']-1 for s in sections]
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1; t0=bi*BAR
  dv={'intro':-10,'head':-4,'gsolo':0,'vsolo':2,'out':4,'coda':-2}[mode]
  if final: add('drums',t0,1800,49,62,0); add('drums',t0,200,35,70,0); continue
  if mode=='intro' and bi<4: continue
  for beat in (1,3): add('drums',t0+beat*Q,80,44,46+dv,4); add('drums',t0+beat*Q,120,38,34+dv+random.randint(-3,3),4)
  for beat in (0,2): add('drums',t0+beat*Q,200,38,20+dv//2,4)
  if mode in('gsolo','vsolo','out'):
    for e in range(8):
      if e%2==0 or e in(3,7): add('drums',t0+et(e),120,59,(44 if e%2==0 else 34)+dv+random.randint(-3,3),4)
  add('drums',t0,120,35,30+dv,4)
  if bi in starts and bi>0: add('drums',t0,1500,49,58,2)
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
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=total*BAR+BAR,timeSig=[4,4],barSec=60/BPM*4),open(f'plan_v{V}.json','w'))
import mido
mf=mido.MidiFile(ticks_per_beat=Q);t=mido.MidiTrack();mf.tracks.append(t)
t.append(mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)));t.append(mido.MetaMessage('time_signature',numerator=4,denominator=4))
CH={'violin':(0,40),'guitar':(1,25),'rhythm':(2,24),'bass':(3,32),'drums':(9,0)}
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k))
  if ch!=9: t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'tinsmith_wheel_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,'bars',round(mf.length,1),'s')
