# Copperleaf Five - Juniper Blue. Original cool jazz in 5/4, E minor, 168 BPM.
# Alto sax lead, piano, upright bass, ride kit. Bars split 3+2 (chord change on beat 4).
import json,sys,random
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
random.seed(1117)
Q=480;BEATS=5;BAR=Q*BEATS;BPM=168;SW=290;SPLIT=6  # SPLIT = eighth where 2nd chord starts
PC={'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
Qual={'m9':[0,3,7,10,14],'maj7':[0,4,7,11,14],'lyd':[0,4,7,11,18],'9':[0,4,7,10,14],'13':[0,4,10,14,21],'m7b5':[0,3,6,10],'alt':[0,4,10,15,20],'7b9':[0,4,7,10,13]}
Scale={'m9':[0,2,3,5,7,9,10],'maj7':[0,2,4,5,7,9,11],'lyd':[0,2,4,6,7,9,11],'9':[0,2,4,5,7,9,10],'13':[0,2,4,5,7,9,10],'m7b5':[0,1,3,5,6,8,10],'alt':[0,1,3,4,6,8,10],'7b9':[0,1,4,5,7,8,10]}
Voic={'m9':[3,7,10,14],'maj7':[4,7,11,14],'lyd':[4,11,14,18],'9':[4,10,14,19],'13':[4,10,14,21],'m7b5':[3,6,10,12],'alt':[4,10,15,20],'7b9':[4,10,13,19]}
def c(s): r,q=s.split(':'); return (PC[r],q)
def bar(s): h=s.split('/'); return [c(h[0]),c(h[-1])]
def bars(*ss):
  out=[]
  for s in ss:
    ch,n=s.split('*') if '*' in s else (s,'1'); out+=[bar(ch)]*int(n)
  return out
A=bars('E:m9*2','C:maj7*2','A:m9','D:9','G:maj7/F#:m7b5','B:alt')
B=bars('F:lyd*2','E:m9*2','D:m9/G:13','C:maj7','F#:m7b5','B:7b9')
INTRO=bars('E:m9*4','C:lyd*2','F#:m7b5','B:alt')
CODA=bars('E:m9*2','C:lyd','F#:m7b5/B:alt','E:m9*2')
MA=[[(0,71,2),(2,74,1),(3,76,3),(6,78,1),(7,79,3)],
 [(0,78,2),(2,74,1),(3,71,4),(8,69,1),(9,71,1)],
 [(0,76,2),(2,79,1),(3,83,3),(6,81,1),(7,78,3)],
 [(0,79,2),(2,76,1),(3,74,6)],
 [(0,72,1),(1,76,1),(2,79,2),(4,83,2),(6,81,1),(7,79,3)],
 [(0,78,3),(3,76,1),(4,72,2),(6,74,4)],
 [(0,71,2),(2,74,1),(3,78,3),(6,81,2),(8,79,1),(9,76,1)]]
MA1=MA+[[(0,75,3),(3,72,1),(4,69,1),(5,66,2),(7,67,1),(8,69,1),(9,71,1)]]
MA3=MA+[[(0,75,2),(2,78,1),(3,81,2),(5,79,1),(6,76,4)]]
MB=[[(0,81,3),(3,79,1),(4,76,2),(6,72,1),(7,71,3)],
 [(0,72,2),(2,76,1),(3,79,1),(4,81,1),(5,83,5)],
 [(0,79,2),(2,78,1),(3,74,3),(6,71,4)],
 [(0,76,1),(1,78,1),(2,79,1),(3,83,2),(5,81,1),(6,79,2),(8,78,2)],
 [(0,77,2),(2,76,1),(3,72,2),(5,69,1),(6,71,2),(8,76,2)],
 [(0,76,4),(4,79,1),(5,83,5)],
 [(0,84,2),(2,81,1),(3,78,2),(5,76,1),(6,72,2),(8,69,2)],
 [(0,75,2),(2,72,1),(3,71,2),(5,69,1),(6,66,2),(8,69,1),(9,71,1)]]
MCODA=[MA[0],MA[1],[(0,76,2),(2,79,1),(3,83,7)],[(0,81,2),(2,79,1),(3,78,1),(4,75,2),(6,78,4)],[(0,78,10)],[(0,78,8)]]
K=('alto','piano','bass','drums')
tr={k:[] for k in K}
def et(e): return (e//2)*Q+(SW if e%2 else 0)
def add(k,t,d,p,v,hum=10):
  t=int(t)+random.randint(-hum,hum)
  tr[k].append(dict(tick=max(0,t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
def near(p,pcs,lo,hi):
  cand=[x for x in range(lo,hi+1) if x%12 in pcs]
  return min(cand,key=lambda x:(abs(x-p),x)) if cand else max(lo,min(hi,p))
def tend(b,e): return b*BAR+et(e) if e<10 else (b+1)*BAR+(e-10)*240
def mel(k,b0,M,vel,trans=0,dur=0.93,hum=6):
  for i,ph in enumerate(M):
    for e,p,l in ph:
      t=(b0+i)*BAR+et(e); end=tend(b0+i,e+l)
      add(k,t,max(60,end-t)*dur,p+trans,vel+(4 if e%2==0 else -7)+(3 if l>=3 else 0),hum)
def solo(bl,b0,lo,hi,k,vel,start,density):
  p=start;n=len(bl)
  for i,ch in enumerate(bl):
    arc=int(10*i/max(1,n-1)); phrase_end=(i%4==3) or (i%2==1 and random.random()<.3)
    e=random.choice([0,1,2,3]) if i%4==0 else random.choice([0,0,1])
    end=6 if phrase_end else 10
    while e<end:
      r,q=ch[0 if e<SPLIT else 1]; ct=[(r+x)%12 for x in Qual[q]]; sc=[(r+x)%12 for x in Scale[q]]
      if e%2==0 and random.random()<.5: p=near(p+random.choice([-5,-4,-3,3,4,5,-7,7]),ct,lo,hi)
      else:
        st=random.choice([-2,-1,-1,1,2,2]); cc=[x for x in range(p+st-1,p+st+2) if x%12 in sc and lo<=x<=hi] or [p]; p=random.choice(cc)
      L=1 if random.random()<density else random.choice([2,3])
      L=min(L,end-e)
      t=(b0+i)*BAR+et(e); t2=tend(b0+i,e+L)
      add(k,t,(t2-t)*0.88,p,vel+arc+(0 if e%2==0 else -8)+random.randint(-4,4),6)
      e+=L
      if random.random()>density+0.15: e+=1
    if phrase_end:
      r,q=ch[1]; tgt=near(p,[(r+Qual[q][1])%12,(r+Qual[q][3])%12],lo,hi)
      add(k,(b0+i)*BAR+et(7),(BAR-et(7))*0.9+300,tgt,vel+arc+4,6); p=tgt
form=[("Intro",INTRO,'intro'),("Head A1",A,'head'),("Head A2",A,'head'),("Head B",B,'head'),("Head A3",A,'head'),
      ("Alto solo",A+A+B+A,'asolo'),("Piano solo",A+B,'psolo'),("Head out B",B,'out'),("Head out A",A,'out'),("Coda",CODA,'coda')]
MEL={'Head A1':MA1,'Head A2':MA1,'Head B':MB,'Head A3':MA3,'Head out B':MB,'Head out A':MA1,'Coda':MCODA}
EN={'intro':.4,'head':.6,'asolo':.8,'psolo':.7,'out':.85,'coda':.5}
b=0;sections=[];allbars=[]
for name,chs,mode in form:
  sections.append(dict(name=name,startBar=b+1,bars=len(chs),energy=EN[mode]))
  if mode=='asolo': solo(chs,b,62,86,'alto',88,76,0.7)
  if mode=='psolo': solo(chs,b,64,91,'piano',80,79,0.72)
  if name in MEL: mel('alto',b,MEL[name],{'head':86,'out':92,'coda':80}[mode])
  for i,cb in enumerate(chs): allbars.append((b+i,cb,name,mode))
  b+=len(chs)
total=b
# piano: rootless voicings, 3+2 comping; shells only (LH) during piano solo
PAT=[[(0,2),(SPLIT,3)],[(0,2),(3,1),(SPLIT,2)],[(1,2),(SPLIT,2),(9,1)],[(0,3),(7,2)],[(0,2),(SPLIT,1),(8,2)]]
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1; t0=bi*BAR
  vb={'intro':-6,'head':-4,'asolo':-2,'psolo':-10,'out':0,'coda':-6}[mode]
  pat=PAT[0] if mode in('intro','coda') and bi%2==0 else random.choice(PAT)
  if final: pat=[(0,10)]
  for e,l in pat:
    r,q=cb[0 if e<SPLIT else 1]
    if e==9 and idx+1<len(allbars): r,q=allbars[idx+1][1][0]   # anticipation
    base=near(55,[(r+Voic[q][0])%12],52,62)
    vo=[base]+[near(base+(x-Voic[q][0]),[(r+x)%12],base+1,base+20) for x in Voic[q][1:]]
    if mode=='psolo': vo=vo[:2]
    t=t0+et(e); d=(tend(bi,e+l)-t)*(0.8 if l>1 else 0.55)
    if final: d=BAR*1.3
    for j,n in enumerate(sorted(set(vo))): add('piano',t+j*9,d,n,66+vb+(4 if e in(0,SPLIT) else 0)+random.randint(-4,4),5)
    if mode in('intro','coda') and e==0: add('piano',t,d,near(43,[r],40,52),58+vb,3)
# bass: 3+2 ostinato in intro/head/coda, walking quarters in solos and head out
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1; t0=bi*BAR
  nxt=allbars[idx+1][1][0] if not final else cb[0]
  r1,q1=cb[0];r2,q2=cb[1]; R1=near(40,[r1],33,45); R2=near(R1,[r2],31,47)
  if final: add('bass',t0,BAR*1.3,R1,96); continue
  if mode in('asolo','psolo','out'):
    nroot=near(R2,[nxt[0]],31,47)
    walk=[R1,near(R1+4,[(r1+Qual[q1][1])%12,(r1+Qual[q1][2])%12],R1+2,R1+9),near(R1+5,[(r1+x)%12 for x in Scale[q1]],R1+3,R1+12),R2,nroot+random.choice([-1,1,2]) if nroot!=R2 else R2+7]
    for j,p in enumerate(walk):
      if p<28: p+=12
      add('bass',t0+j*Q,Q*0.88,p,(96 if j in(0,3) else 84)+random.randint(-3,3),6)
  else:
    f1=near(R1+7,[(r1+7)%12],R1+5,R1+8); f2=near(R2+7,[(r2+Qual[q2][2])%12],R2+5,R2+8)
    add('bass',t0,Q*1.4,R1,96+random.randint(-2,2),5)
    add('bass',t0+et(3),Q*0.5,f1,80,5)
    add('bass',t0+2*Q,Q*0.9,R1+12 if R1+12<=52 else f1,84,5)
    add('bass',t0+3*Q,Q*0.9,R2,94,5)
    add('bass',t0+4*Q,Q*0.85,f2,82,5)
# drums: ride with skips on 2& and 4&, hat foot on 2 and 4, soft kick on 1 and 4, cross-stick on 5
starts=[s['startBar']-1 for s in sections]
for idx,(bi,cb,name,mode) in enumerate(allbars):
  final=idx==len(allbars)-1; t0=bi*BAR
  dv={'intro':-10,'head':-4,'asolo':2,'psolo':-2,'out':4,'coda':-6}[mode]
  if final: add('drums',t0,2000,53,64,0); add('drums',t0,200,35,62,0); continue
  if mode=='intro' and bi<4: continue
  for e in (0,2,3,4,6,8,9):
    if e in(3,9) and random.random()<.15: continue
    add('drums',t0+et(e),150,51,(58 if e%2==0 else 44)+(6 if e in(0,6) else 0)+dv+random.randint(-4,4),5)
  for beat in (1,3): add('drums',t0+beat*Q,80,44,44+dv,4)
  for beat in (0,3): add('drums',t0+beat*Q,150,35,40+dv,4)
  add('drums',t0+4*Q,90,37,40+dv+random.randint(-3,3),4)
  if mode in('asolo','out') and random.random()<.3: add('drums',t0+et(random.choice([5,7,9])),90,38,30+dv,4)
  if bi in starts and bi>0: add('drums',t0,1500,49,56+dv,2)
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
json.dump(dict(tracks=tr,sections=sections,bars=total,bpm=BPM,endTick=total*BAR+BAR,timeSig=[5,4],barSec=60/BPM*BEATS),open(f'plan_v{V}.json','w'))
import mido
mf=mido.MidiFile(ticks_per_beat=Q);t=mido.MidiTrack();mf.tracks.append(t)
t.append(mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)));t.append(mido.MetaMessage('time_signature',numerator=5,denominator=4))
CH={'alto':(0,65),'piano':(1,0),'bass':(2,32),'drums':(9,0)}
for k,(ch,prog) in CH.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k))
  if ch!=9: t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n['tick'],1,mido.Message('note_on',channel=ch,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=ch,note=n['pitch']))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
mf.save(f'copperleaf_five_v{V}.mid')
print({k:len(v) for k,v in tr.items()},total,'bars',round(mf.length,1),'s')
