# Revision of draft 1 "Lantern Orchard": jazz waltz in A major, 168 BPM in 3. Flute lead, piano trio with brushes.
import sys,json
from waltz import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else {"piano@Piano solo":1.12}
S=W(168,280,2711)
A1=chart('Amaj7 x2 | F#m7 x2 | Dmaj7 x2 | G#m7b5 | C#7alt | F#m7 | B7 | Bm7 | E7 | C#m7 | F#7 | Bm7 | E7')
A2=chart('Amaj7 x2 | F#m7 x2 | Dmaj7 x2 | G#m7b5 | C#7alt | F#m7 | B7 | Dm6 | G7#11 | Bm7 | E7alt | Amaj7 x2')
B=chart('Fmaj7#11 x2 | Em7 | A7 | Dmaj7 x2 | Dm7 | G7 | Cmaj7 x2 | Bm7 | E7 | C#m7 | F#7alt | Bm7 | E7alt')
M8=('>G#5:4 A5:1 B5:1 >C#6:3 B5:1 G#5:1 E5:1 >A5:4 G#5:1 F#5:1 E5:4 C#5:1 E5:1 '
    '>F#5:4 A5:1 C#6:1 >E6:3 C#6:1 A5:1 F#5:1 >F#5:3 E5:1 D5:1 B4:1 >A5:3 F5:1 E5:1 D5:1 ')
MA1=M8+('>E5:2 A5:2 C#6:2 >D#6:4 C#6:1 A5:1 >D6:3 C#6:1 B5:1 A5:1 >G#5:4 B5:1 D6:1 '
        '>C#6:4 B5:1 G#5:1 >A#5:3 G#5:1 F#5:1 E5:1 >D5:4 F#5:1 A5:1 >D6:3 B5:1 E5:1 F#5:1 ')
MA2=M8+('>E5:2 A5:2 C#6:2 >D#6:4 C#6:1 A5:1 >D6:3 B5:1 A5:1 F5:1 >C#6:3 B5:1 G5:1 F5:1 '
        '>F#5:2 A5:2 D6:2 >G5:2 Bb5:2 D6:2 >C#6:10 r:2 ')
MB=('>B5:6 A5:2 G5:2 E5:2 >D6:6 C#6:2 B5:2 G5:2 >C#6:3 A5:1 F#5:1 E5:1 >F#5:6 >F5:2 A5:2 C6:2 >B5:4 A5:1 F5:1 '
    '>E5:6 r:2 E5:1 G5:1 B5:1 D6:1 >D6:3 C#6:1 B5:1 A5:1 >G#5:4 B5:1 D6:1 >E6:3 D#6:1 C#6:1 B5:1 >A5:3 G5:1 E5:1 D5:1 >D5:2 F#5:2 A5:2 >C6:4 Bb5:1 G5:1 ')
if V=='lint': lint('A1',A1,MA1);lint('A2',A2,MA2);lint('B',B,MB);sys.exit()
INTRO=chart('Amaj7 | Fmaj7#11')*4
S.section('Intro',INTRO,'intro',0.4)
h=S.section('Head A1',A1,'one',0.55);S.section('Head A2',A2,'one',0.55);S.section('Head B',B,'walk',0.6);S.section('Head A3',A2,'walk',0.6)
fs=S.section('Flute solo',A1+A2,'solo',0.8)
ps=S.section('Piano solo',B+A2,'psolo',0.75)
o=S.section('Head out B',B,'walk',0.65);S.section('Head out A3',A2[:14],'walk',0.6)
cd=S.section('Coda',chart('Amaj7 | Fmaj7#11 | Amaj7 | Fmaj7#11 | Amaj7 | Amaj7'),'one',0.45);S.bars[-1]=(S.bars[-1][0],'Coda','final')
def head(b0,v,parts=((0,MA1),(16,MA2),(32,MB),(48,MA2))):
  for off,m in parts: S.mel('fl',b0+off,melody(m),v,late=8,legato=0.9)
head(h,92)
FO='r:2 G#5:1 A5:1 B5:1 C#6:1 >E6:3 C#6:1 B5:1 G#5:1 >A5:2 C#6:1 E6:1 F#6:1 E6:1 >C#6:4 r:2 '
FE='>E6:3 C#6:1 B5:1 G#5:1 >A5:4 r:2 '
PO='r:2 E5:1 G5:1 B5:1 D6:1 >E6:3 D6:1 B5:1 A5:1 >G5:2 B5:1 D6:1 F#6:1 E6:1 >C#6:3 B5:1 A5:1 G5:1 '
if V=='lint2': lint('FO',A1[:4],FO);lint('FE',A2[14:],FE);lint('PO',B[:4],PO);sys.exit()
S.mel('fl',fs,melody(FO),84,late=8)     # v2: solos open by developing the head, higher register, denser lines
S.solo('fl',fs+4,26,73,93,84,83,arc=(0.5,1.0),late=8,motif_p=0.35,dens=0.82)
S.mel('fl',fs+30,melody(FE),88,late=8)
S.mel('piano',ps,melody(PO),74,late=4)
S.solo('piano',ps+4,28,67,91,74,79,arc=(0.5,0.95),late=4,motif_p=0.35,dens=0.82)
head(o,94,((0,MB),(16,M8+'>E5:2 A5:2 C#6:2 >D#6:4 C#6:1 A5:1 >D6:3 B5:1 A5:1 F5:1 >C#6:3 B5:1 G5:1 F5:1 >F#5:2 A5:2 D6:2 >G5:2 Bb5:2 D6:2 '),))
CODA='>C#6:4 B5:1 G#5:1 >B5:6 >G#5:4 A5:1 B5:1 >B5:6 >E6:6 >C#6:6'
S.mel('fl',cd,melody(CODA),88,late=8)
S.mel('piano',4,melody('>G#5:4 A5:1 B5:1 >B5:6 >C#6:3 B5:1 G#5:1 E5:1 >E5:6'),66,late=4,legato=0.8)
S.bass(lo=33,hi=52,vel=88)
S.comp(vel=56,modes_vel={'intro':0,'one':-2,'walk':0,'solo':2,'psolo':-6},lo=50,hi=60)
S.drums(vel=66,modes_vel={'intro':-8,'one':-4,'walk':0,'solo':4,'psolo':0},brush_modes=('intro','one','walk','psolo'))
meta=dict(title='Lantern Orchard',slug='lantern_orchard',key='A major',form='intro-head AABA (16-bar sections)-flute solo-piano solo-head out from the bridge-coda',style='jazz waltz',
 mix=[["Flute","fl",0,73,46,64],["Piano","piano",1,0,80,62],["Upright Bass","bass",2,32,48,64],["Drums","drums",9,0,96,64]])
S.save(V,meta,ARC)
