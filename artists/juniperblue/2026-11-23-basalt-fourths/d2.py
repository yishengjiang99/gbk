# Draft 2 "Lamplighter's Blues": slow minor blues in C minor, 66 BPM, triplet swing. Jazz guitar lead, piano, bass, brushes.
import sys,json
from extra2 import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(66,320,6611)
BL=chart('Cm9 | Fm9 | Cm9 | C7alt | Fm9 | Fm9 | Cm9 | Cm9 | Ab7 | G7alt | Cm9 Ab7 | Dm7b5 G7alt')
M=('r:1 G4:1 >Bb4:1 C5:3 Eb5:1 C5:1 >Ab5:3 G5:1 F5:1 Eb5:1 C5:2 '
   'Eb5:1 F5:1 >Gb5:1 F5:1 Eb5:2 C5:2 >Bb4:6 r:2 '
   'r:1 C5:1 >Eb5:1 F5:3 Ab5:1 F5:1 >C6:3 Bb5:1 Ab5:1 F5:1 Eb5:2 '
   'Eb5:1 F5:1 >Gb5:1 F5:1 Eb5:2 C5:2 G4:6 r:2 '
   'r:1 Eb5:1 >Gb5:2 F5:1 Eb5:1 C5:2 >B4:3 Ab4:1 F4:1 Ab4:1 B4:2 '
   'C5:3 Eb5:1 >Gb5:3 F5:1 Eb5:2 D5:1 C5:1 >B4:4 ')
S.section('Intro',chart('Ab7 | G7alt | Cm9 Ab7 | Dm7b5 G7alt'),'intro',0.3)
h=S.section('Head 1',BL,'two',0.45); h2=S.section('Head 2',BL,'head',0.55)
g=S.section('Guitar solo',BL+BL,'solo',0.75)
p=S.section('Piano solo',BL,'solo2',0.65)
o=S.section('Head out',BL,'out',0.6)
tg=S.section('Coda',chart('Ab7 | G7alt | Cm9 | Cm9'),'out',0.4); S.bars[-1]=(S.bars[-1][0],'Coda','final')
S.mel('guitar',h,melody(M),92,late=8); S.mel('guitar',h2,melody(M),96,late=8)
harm(S,'piano',h2,melody(M),58)
S.solo('guitar',g,24,55,79,88,67,arc=(0.3,0.95),late=8)
S.solo('piano',p,12,60,84,82,72,arc=(0.35,0.8),late=4)
S.mel('guitar',o,melody(M),98,late=8)
S.mel('guitar',tg,melody('r:1 Eb5:1 >Gb5:2 F5:1 Eb5:1 C5:2 >B4:3 Ab4:1 F4:1 Ab4:1 B4:2 >C5:16'),90,late=8)
S.mel('piano',0,melody('r:1 Eb5:1 >Gb5:2 F5:1 Eb5:1 C5:2 >B4:3 Ab4:1 F4:1 Ab4:1 B4:2 C5:3 Eb5:1 >Gb5:3 F5:1 Eb5:2 D5:1 C5:1 >B4:4'),80,late=2)
S.bass(vel=84)
S.comp(vel=56,modes_vel={'intro':4,'two':-4,'head':-2,'solo':0,'solo2':-6,'out':0},lo=48,hi=58)
S.drums(vel=60,modes_vel={'intro':-14,'two':-8,'head':-6,'solo':0,'solo2':-4,'out':-2},brush_modes=('intro','two','head','solo2','out'))
meta=dict(title="Lamplighter's Blues",slug='lamplighters_blues',key='C minor',form='intro-head x2-guitar solo x2-piano solo-head out-coda',style='slow minor blues, 12/8 feel',
 mix=[["Jazz Guitar","guitar",0,26,100,58],["Piano","piano",1,0,80,70],["Upright Bass","bass",2,32,58,64],["Drums","drums",9,0,100,64]])
S.save(V,meta,ARC)
