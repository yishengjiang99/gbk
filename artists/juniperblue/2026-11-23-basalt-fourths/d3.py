# Draft 3 "Guava Lantern": charanga-style Latin jazz cha-cha in F, 116 BPM straight. Flute, violins, piano montuno, bass tumbao, Latin percussion.
import sys,json
from extra2 import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(116,240,1162)
A=chart('Fmaj7 | Gm7 C7 | Fmaj7 | Am7 D7 | Gm7 | C7 | Am7 D7 | Gm7 C7')
B=chart('Bbmaj7 | Bbm6 Eb7 | Am7 | D7b9 | Gm7 | C7 | Fmaj7 D7 | Gm7 C7')
MA=('>A5:3 G5:1 F5:2 C5:2 D5:2 F5:2 >E5:2 G5:1 G5:1 '
    '>A5:3 C6:1 A5:2 F5:2 E5:2 G5:2 >F#5:2 A5:1 A5:1 '
    '>Bb5:3 A5:1 G5:2 D5:2 E5:2 G5:2 >Bb5:2 A5:1 G5:1 '
    '>A5:2 C6:2 F#5:2 A5:1 C6:1 >Bb5:3 A5:1 G5:2 E5:2 ')
MB=('>D6:3 C6:1 A5:2 F5:2 Db6:2 Bb5:2 >G5:2 Bb5:1 Db6:1 '
    '>C6:3 B5:1 A5:2 E5:2 F#5:2 Eb5:2 >C5:2 D5:1 Eb5:1 '
    '>D5:3 F5:1 Bb5:2 A5:2 G5:2 E5:2 >Bb4:2 C5:1 D5:1 '
    '>F5:2 A5:2 F#5:2 A5:1 C6:1 >Bb5:3 A5:1 G5:2 E5:2 ')
S.section('Intro',chart('Gm7 C7 x4 | Gm7 | C7 | Gm7 | C7'),'intro',0.4)
h=S.section('Head A',A,'head',0.55); S.section('Head B',B,'head',0.6)
h2=S.section('Head A2',A,'head2',0.6); S.section('Head B2',B,'head2',0.65)
f=S.section('Flute solo',A+B+A+B,'solo',0.8)
p=S.section('Piano solo',A+B,'psolo',0.7)
o=S.section('Head out',A+B,'out',0.7)
cd=S.section('Coda',chart('Gm7 C7 | Gm7 C7 | Gm7 C7 | Fmaj7'),'out',0.6); S.bars[-1]=(S.bars[-1][0],'Coda','final')
fl=lambda b0,m,v: S.mel('flute',b0,melody(m),v,late=4,legato=0.85)
fl(h,MA,96); fl(h+8,MB,98); fl(h2,MA,100); fl(h2+8,MB,100)
harm(S,'violin',h2,melody(MA+MB),78,late=6,legato=0.85)
# violins: intro riff and cha-cha-cha hits in head 1
RIFF='r:6 C5:1 C5:1 >D5:2 r:2 Bb4:2 r:2 '
for b in range(0,8,2): S.mel('violin',b,melody(RIFF),86,late=4,legato=0.6)
for b in range(h,h+16,2): S.mel('violin',b,melody('r:6 F4:1 F4:1 r:8'.replace('F4',['A4','G4','A4','A4','D5','C5','A4','G4'][(b-h)//2])),70,legato=0.6)
S.solo('flute',f,32,65,93,90,72,arc=(0.3,0.95),late=4)
guide(S,'violin',f+16,16,58,lo=62,hi=76)
S.solo('piano',p,16,62,86,84,74,arc=(0.35,0.85),late=2)
fl(o,MA+MB,102); harm(S,'violin',o,melody(MA+MB),80,late=6,legato=0.85)
fl(cd,'>Bb5:3 A5:1 G5:2 E5:2 >Bb5:3 A5:1 G5:2 E5:2 >Bb5:3 A5:1 G5:2 E5:1 E5:1 >F5:8',100)
S.mel('violin',cd,melody('G5:3 F5:1 E5:2 C5:2 G5:3 F5:1 E5:2 C5:2 G5:3 F5:1 E5:2 C5:1 C5:1 >A5:8'),82)
tumbao(S,'bass',90)
montuno(S,'piano',66,skip_modes=('psolo',),sparse_modes=())
S.comp(k='piano',vel=58,modes_vel={},lo=48,hi=58) if False else None
for b in range(p,p+16):  # left-hand stabs under piano solo
  c=S.bars[b][0]; v=S.voicing(c[0],55,50,60)
  for e in (0,3) if b%2==0 else (2,6):
    cc=c[0] if (len(c)==1 or e<4) else c[1]; v=S.voicing(cc,55,50,60)
    for x in v: S.add('piano',b*BAR+S.et(e),Q*0.7,x,60,3)
chachaperc(S,84,modes_vel={'intro':-6,'head':-2,'head2':0,'solo':2,'psolo':-2,'out':2},timb_modes=('solo','out'))
meta=dict(title='Guava Lantern',slug='guava_lantern',key='F major',form='intro-head AB x2-flute solo x2-piano solo-head out-coda',style='charanga Latin jazz cha-cha',
 mix=[["Flute","flute",0,73,100,60],["Violins","violin",1,40,80,72],["Piano","piano",3,0,82,58],["Bass","bass",2,32,70,64],["Percussion","drums",9,0,100,64]])
S.save(V,meta,ARC)
