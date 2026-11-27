# Draft 3 "Mulberry Porch": slow 12/8-feel blues in G, 66 BPM, triplet swing. Clarinet, piano, upright bass, brushes.
import sys,json
from jazz import *
from lint import lint
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
S=Song(66,320,6602)
C1=chart('G13 | C7 | G13 | Dm7 G7alt | C7 | C#dim7 | G13 | Bm7b5 E7alt | Am7 | D7alt | G13 E7alt | Am7 D7alt')
CF=chart('G13 | C7 | G13 | Dm7 G7alt | C7 | C#dim7 | G13 | Bm7b5 E7alt | Am7 | D7alt | G13 | Am7 D7alt | G13 | Ab7#11 | G13')
M=('r:1 Bb4:0.5 B4:0.5 >D5:2 E5:1 D5:1 >G5:2 >Bb5:3 A5:0.5 G5:0.5 >E5:2 r:2 r:4 D5:1 E5:1 G5:1 A5:1 >C6:2 A5:1 F5:1 >Ab5:2 F5:1 Eb5:1 '
   '>E5:3 G5:0.5 Bb5:0.5 >D6:2 C6:1 Bb5:1 >Bb5:2 G5:1 E5:1 >C#5:2 r:2 r:1 D5:0.5 E5:0.5 >G5:2 Bb5:0.5 B5:0.5 D6:1 >E6:2 >D6:2 A5:1 F5:1 >G#5:2 F5:1 D5:1 '
   '>E5:3 G5:0.5 A5:0.5 >C6:2 B5:1 A5:1 >C6:2 Bb5:1 Ab5:1 >F#5:2 F5:1 Eb5:1 ')
M1=M+'>D5:3 B4:1 >G#4:2 C5:1 D5:1 >C5:2 E5:1 G5:1 >F#5:2 r:2 '
MF=M+'>D5:2 E5:0.5 G5:0.5 A5:1 >B5:4 r:2 >C6:2 Bb5:1 Ab5:1 >F#5:2 >G5:4 D6:1 E6:1 r:2 >Eb6:3 D6:1 >C6:2 Bb5:1 Gb5:1 >B5:8 '
if V=='lint': lint('M1',C1,M1);lint('MF',CF,MF);sys.exit()
S.section('Intro',chart('G13 E7alt | Am7 D7alt')*2,'intro',0.35)
h1=S.section('Head 1',C1,'head',0.5);h2=S.section('Head 2',C1,'head',0.55)
cs=S.section('Clarinet solo',C1,'solo',0.8);ps=S.section('Piano solo',C1,'psolo',0.7)
o=S.section('Head out',CF,'head',0.55);S.bars[-1]=(S.bars[-1][0],'Head out','final')
S.mel('cl',h1,melody(M1),88,late=12,legato=0.93);S.mel('cl',h2,melody(M1),92,late=12,legato=0.93)
S.solo('cl',cs,12,55,84,84,67,arc=(0.45,1.0),late=10)
S.solo('piano',ps,12,62,86,72,72,arc=(0.4,0.9),late=4)
S.mel('cl',o,melody(MF),90,late=12,legato=0.93)
S.mel('piano',0,melody('r:2 >B5:1 D6:1 E6:2 D6:1 B5:1 >C6:2 A5:1 F#5:1 >A5:2 r:2 r:2 B5:1 D6:1 >E6:2 D6:1 Bb5:1 >A5:2 F#5:1 D5:1 >F#5:4'),66,late=4)
S.bass(vel=86)
S.comp(vel=54,modes_vel={'intro':0,'head':0,'solo':2,'psolo':-6},lo=50,hi=60)
S.drums(vel=64,modes_vel={'intro':-6,'head':-2,'solo':4,'psolo':0},brush_modes=('intro','head','solo','psolo'))
meta=dict(title='Mulberry Porch',slug='mulberry_porch',key='G major',form='intro-head twice (12-bar blues)-clarinet solo-piano solo-head out with tag',style='slow blues',
 mix=[["Clarinet","cl",0,71,100,62],["Piano","piano",1,0,80,64],["Upright Bass","bass",2,32,48,64],["Drums","drums",9,0,96,64]])
S.save(V,meta,ARC)
