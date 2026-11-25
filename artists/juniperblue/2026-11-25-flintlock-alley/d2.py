# Draft 2 "Hollyhock Stride": stride-piano-led trio in G, 132 BPM swing. Piano (stride LH), upright bass, brushes.
import sys,json
from extra3 import *
from lint import lint
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(132,310,1325)
A1=chart('G6 E7 | Am7 D7 | Bm7 Bbdim7 | Am7 D7 | G6 G7 | C6 C#dim7 | G6 E7 | Am7 D7')
A2=chart('G6 E7 | Am7 D7 | Bm7 Bbdim7 | Am7 D7 | G6 G7 | C6 C#dim7 | Am7 D7 | G6')
B=chart('Cmaj7 | Cm6 F7 | Bm7 | Em7 | Am7 | D7 | Bm7 E7 | Am7 D7')
MA=('r:1 D5:1 E5:1 >G5:3 E5:1 G#5:1 >A5:3 G5:1 E5:1 D5:1 >F#5:2 '
    'r:1 D5:1 F#5:1 >A5:3 G5:1 E5:1 >E5:3 C5:1 A4:1 B4:1 C5:1 C#5:1 '
    '>D5:2 E5:1 G5:1 >B5:2 F5:2 >E5:3 G5:1 >Bb5:2 G5:1 E5:1 ')
MA1=MA+'>D5:3 E5:1 D5:1 B4:1 >G#4:2 >A4:3 C5:1 E5:1 F#5:1 >A5:2 '
MA2=MA+'r:1 C5:1 E5:1 >A5:3 F#5:1 D5:1 >G5:6 r:2 '
MB=('r:2 E5:1 G5:1 >B5:4 >A5:2 G5:1 Eb5:1 C5:2 >A4:2 r:2 D5:1 F#5:1 >A5:4 >G5:2 F#5:1 D5:1 B4:2 r:2 '
    'r:2 C5:1 E5:1 >G5:4 >F#5:2 E5:1 C5:1 A4:2 r:2 r:1 D5:1 F#5:1 A5:1 >G#5:2 E5:1 D5:1 C5:1 E5:1 G5:1 B5:1 A5:1 F#5:1 D5:1 C#5:1 ')
if V=='lint': lint('A1',A1,MA1); lint('A2',A2,MA2); lint('B',B,MB); sys.exit()
S.section('Intro',chart('Am7 D7 | Bm7 E7 | Am7 D7 | G6 D7'),'intro',0.4)
h=S.section('Head A1',A1,'head',0.5); S.section('Head A2',A2,'head',0.55); S.section('Head B',B,'head2',0.6); S.section('Head A3',A2,'head2',0.6)
ps=S.section('Piano solo',A1+A2+B+A2,'solo',0.8)
o=S.section('Head out B',B,'out',0.7); o2=S.section('Head out A',A2,'out',0.65)
cd=S.section('Tag',chart('Am7 D7 | Bm7 E7 | Am7 D7 | G6'),'out',0.5); S.bars[-1]=(S.bars[-1][0],'Tag','final')
def rh(b0,m,v,dbl=True):
  S.mel('piano',b0,melody(m),v,late=6,legato=0.85)
  if dbl: harm(S,'piano',b0,melody(m),v-18,late=8,legato=0.8)   # thirds/sixths under the tune
rh(h,MA1,96); rh(h+8,MA2,96); rh(h+16,MB,98); rh(h+24,MA2,100)
S.solo('piano',ps,32,62,89,94,72,arc=(0.35,0.95),late=4)
rh(o,MB,100); rh(o2,MA2,100)
rh(0,'r:1 E5:1 G5:1 A5:1 >C6:2 A5:1 G5:1 r:1 D5:1 F#5:1 A5:1 >G#5:2 E5:1 D5:1 r:1 C5:1 E5:1 G5:1 >F#5:2 D5:1 C5:1 >B4:2 D5:1 B4:1 >G4:4',90)
rh(cd,'r:1 C5:1 E5:1 A5:1 >C6:2 A5:1 F#5:1 r:1 D5:1 F#5:1 B5:1 >G#5:2 E5:1 D5:1 r:1 C5:1 E5:1 A5:1 >F#5:2 C5:1 A4:1 >B4:2 D5:1 E5:1 >G5:12',98)
# stride LH in the A sections and first half of the solo; walking bass + LH comping in the bridges and second half of the solo
for b0,n in ((0,4+16),(h+24,8),(ps,16),(o2,8),(cd,3)): stride(S,'piano',b0,n,74)
walk=set(range(h+16,h+24))|set(range(ps+16,ps+32))|set(range(o,o+8))
S.bass(vel=80)
S.tr['bass']=[n for n in S.tr['bass'] if n['tick']//BAR in walk]
keep=S.tr['piano']; S.tr['piano']=[]
S.comp(k='piano',vel=56,lo=48,hi=58)
S.tr['piano']=keep+[n for n in S.tr['piano'] if n['tick']//BAR in walk]
S.drums(vel=64,modes_vel={'intro':-10,'head':-8,'head2':-4,'solo':0,'out':-2},brush_modes=('intro','head','head2','solo','out'))
meta=dict(title='Hollyhock Stride',slug='hollyhock_stride',key='G major',form='intro-head AABA-piano solo-head out BA-tag',style='stride piano trio, swing',
 mix=[["Piano","piano",0,0,110,62],["Upright Bass","bass",1,32,58,66],["Drums","drums",9,0,100,64]])
S.save(V,meta,ARC)
