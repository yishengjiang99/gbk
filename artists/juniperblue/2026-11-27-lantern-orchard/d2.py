# Draft 2 "Pale Meridian": ECM-style chamber jazz, B minor / lydian colours, 100 BPM straight eighths. Soprano sax, cello, piano ostinato, bass, mallets and cymbals.
import sys,json,jazz
from jazz import *
from lint import lint
for d,v in ((jazz.CT,[0,5,7,10]),(jazz.TEN,[2,9]),(jazz.SC,[0,2,4,5,7,9,10]),(jazz.VA,[5,10,14,19]),(jazz.VB,[10,14,17,21])): d['sus']=v
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
S=Song(100,240,5301)
A=chart('Bm9 | Gmaj7#11 | Dmaj7 | Asus | Bm9 | Gmaj7#11 | Em9 | F#sus')
B=chart('Gmaj7#11 x2 | Fmaj7#11 x2 | Ebmaj7#11 x2 | Em9 | F#sus')
MA=('>C#6:6 B5:1 A5:1 >F#5:3 E5:1 >C#6:4 >A5:6 F#5:1 E5:1 >E5:6 r:2 '
    '>C#6:3 D6:1 >E6:4 >F#6:4 E6:1 D6:1 C#6:2 >B5:6 A5:1 G5:1 >C#6:8 ')
MB=('>D6:4 C#6:2 A5:2 >B5:8 >C6:4 B5:2 G5:2 >A5:8 >Bb5:4 A5:2 F5:2 >G5:6 r:2 >F#5:3 G5:1 >B5:4 >E5:4 F#5:2 B5:2 ')
CEL_A='>B3:8 >G3:8 >F#3:8 >E3:8 >D3:8 >B3:8 >G3:8 >C#4:8 '   # cello counter-line (long tones, inner voice)
CEL_B='>D4:8 >C#4:8 >C4:8 >A3:8 >G3:8 >Bb3:8 >B3:8 >C#4:8 '
if V=='lint': lint('A',A,MA);lint('B',B,MB);lint('CA',A,CEL_A);lint('CB',B,CEL_B);sys.exit()
def ost(k,vel,lo=50,skip=()):
  low=lo+4
  for b,(c,name,mode) in enumerate(S.bars):
    if mode in skip: continue
    t0=b*BAR;r,q=c[0];last=b==len(S.bars)-1
    R=S.near(40,[r],35,46)
    if last or mode=='final':
      v=S.voicing(c[0],low,lo,lo+10)
      for j,p in enumerate([R,R+7]+v): S.add(k,t0+j*40,BAR*2,p,vel+2,2)
      continue
    v=S.voicing(c[0],low,lo,lo+10);low=v[0]
    up=v+[v[1]+12]; seq=[0,2,1,3,4,3,1,2] if b%2==0 else [0,2,1,3,4,2,3,1]
    S.add(k,t0,BAR*0.95,R,vel+2,3); S.add(k,t0+2,BAR*0.9,R+7 if R+7<48 else R-5,vel-6,3)
    for i,j in enumerate(seq):
      S.add(k,t0+i*240,330,up[j],vel-4+(6 if i in(0,3,6) else 0)+S.R.randint(-4,3),4)
def pbass(k,vel,skip=()):
  prev=40
  for b,(c,name,mode) in enumerate(S.bars):
    if mode in skip: continue
    t0=b*BAR;r,q=c[0];last=b==len(S.bars)-1;R=S.near(prev,[r],31,45)
    if last or mode=='final': S.add(k,t0,BAR*2,R,vel+4,2);continue
    nxt=S.bars[b+1][0][0][0]
    f=S.near(R+7,[(r+7)%12],R+3,R+8) if S.R.random()<.6 else S.near(R+10,[(r+CT[q][3])%12],R+2,R+12)
    S.add(k,t0,Q*2.6,R,vel,4);S.add(k,t0+Q*3-60 if S.R.random()<.5 else t0+Q*2,Q*0.95,f,vel-8,4)
    if mode=='move' and S.R.random()<.5: S.add(k,t0+int(Q*3.5),Q*0.45,S.near(f,[(nxt+1)%12,(nxt-1)%12],31,48),vel-14,3)
    prev=R
def kit(vel,modes_vel=None,tacet=()):
  starts=[x['startBar']-1 for x in S.sections]
  for b,(c,name,mode) in enumerate(S.bars):
    if mode in tacet: continue
    t0=b*BAR;dv=(modes_vel or {}).get(mode,0);last=b==len(S.bars)-1
    if b in starts and b>0: S.add('drums',t0,3000,52 if mode!='move' else 49,vel+dv-4,2)
    if last or mode=='final': S.add('drums',t0,3500,51,vel+dv,0);S.add('drums',t0,600,41,vel+dv-10,0);continue
    for i in range(8):
      if i%2==0 or S.R.random()<(.55 if mode=='move' else .3): S.add('drums',t0+i*240,150,51,vel+dv-(0 if i%2==0 else 10)+(4 if i in(0,4) else 0)+S.R.randint(-4,3),4)
    S.add('drums',t0,600,41,vel+dv-20,3)
    if S.R.random()<.4: S.add('drums',t0+5*240,300,45 if S.R.random()<.5 else 47,vel+dv-24,3)
    S.add('drums',t0+2*Q,80,44,vel+dv-18,3);S.add('drums',t0+3*Q+240 if S.R.random()<.3 else t0+3*Q,80,44,vel+dv-20,3)
    if mode=='move': S.add('drums',t0+S.R.choice([3,5,7])*240,90,37,vel+dv-20,3)
INTRO=chart('Bm9')*4+chart('Bm9 | Gmaj7#11')*2
S.section('Intro',INTRO,'still',0.3)
h=S.section('Head A1',A,'still',0.45);S.section('Head A2',A,'move',0.55);S.section('Head B',B,'move',0.6);S.section('Head A3',A,'move',0.55)
ps=S.section('Piano solo',A+A,'move',0.7)
ss=S.section('Soprano solo',B+A,'move',0.8)
o=S.section('Head out B',B,'move',0.6);S.section('Head out A',A,'still',0.45)
cd=S.section('Coda',chart('Bm9 | Gmaj7#11')*2+chart('Bm9 | Bm9'),'still',0.3);S.bars[-1]=(S.bars[-1][0],'Coda','final')
for off,m,c in ((0,MA,CEL_A),(8,MA,CEL_A),(16,MB,CEL_B),(24,MA,CEL_A)):
  S.mel('sop',h+off,melody(m),88,late=6,legato=0.95)
  if off>0: S.mel('cello',h+off,melody(c),70,late=0)
S.solo('piano',ps,16,62,86,74,71,arc=(0.3,0.8),late=0)
S.solo('sop',ss,16,62,89,86,73,arc=(0.4,0.95),late=6)
S.mel('cello',ss,melody(CEL_B+CEL_A),64,late=0)
for off,m,c in ((0,MB,CEL_B),(8,MA,CEL_A)):
  S.mel('sop',o+off,melody(m),88,late=6,legato=0.95);S.mel('cello',o+off,melody(c),70,late=0)
S.mel('sop',cd,melody('>C#6:6 B5:1 A5:1 >F#5:3 E5:1 >C#6:4 >C#6:6 B5:1 A5:1 >F#5:4 >C#6:4 >D6:16'),80,late=6,legato=0.95)
S.mel('cello',4,melody('>F#3:8 >E3:8 >D3:8 >C#3:8'),60,late=0)
ost('piano',58,skip=())
pbass('bass',86,skip=('x',))
S.tr['bass']=[n for n in S.tr['bass'] if n['tick']>=4*BAR]
kit(62,modes_vel={'still':-10,'move':0},tacet=())
S.tr['drums']=[n for n in S.tr['drums'] if n['tick']>=4*BAR]
meta=dict(title='Pale Meridian',slug='pale_meridian',key='B minor',form='intro-head AABA-piano solo-soprano solo-head out from the bridge-coda',style='ECM chamber jazz',
 mix=[["Soprano Sax","sop",0,64,100,62],["Cello","cello",1,42,80,58],["Piano","piano",2,0,82,68],["Upright Bass","bass",3,32,52,64],["Drums","drums",9,0,96,64]])
S.save(V,meta,ARC)
