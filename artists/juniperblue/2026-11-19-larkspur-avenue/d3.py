# Draft 3 "Marigold Sprint": medium-up piano trio, AABA in D major, 160 BPM. Piano melody, block-chord bridge.
import sys,json
from jazz import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(160,300,1121)
A1=chart('Dmaj7 | Fmaj7 | Em7 | A7alt | Dmaj7 | Cm7 F7 | Bbmaj7 | Em7 A7')
BR=chart('F#m7b5 | B7alt | Em7 | Em7 | Gm7 | C7 | F#m7 B7 | Em7 A7alt')
FORM=A1+A1+BR+A1
MA='r:1 F#5:1 A5:1 >C#6:3 B5:1 A5:1 r:1 A5:1 C6:1 >E6:3 D6:1 C6:1 B5:2 G5:1 E5:1 D5:1 E5:1 G5:1 B5:1 >Bb5:2 G5:1 F5:1 C#5:3 r:1 r:1 F#5:1 A5:1 >C#6:3 B5:1 A5:1 Bb5:2 G5:1 Eb5:1 A5:2 F5:1 Eb5:1 D5:3 F5:1 A5:2 G5:1 F5:1 '
MA1=MA+'G5:2 E5:1 D5:1 C#5:2 E5:1 G5:1 '
MA2=MA+'G5:2 B5:1 D6:1 >C#6:3 r:1 '
MBR='>A5:3 C6:1 E6:2 r:2 >D#6:3 C6:1 A5:2 G5:2 F#5:6 r:2 r:1 G5:1 B5:1 D6:1 >F#6:2 E6:1 D6:1 >Bb5:3 A5:1 F5:2 D5:2 E5:3 G5:1 Bb5:2 A5:2 A5:2 C#6:2 D#6:2 A5:2 G5:3 E5:1 Bb5:1 G5:1 F5:1 C#5:1 '
MA3=MA+'G5:2 E5:1 C#5:1 A4:2 C#5:1 E5:1 '
END=melody(MA.replace('D5:3 F5:1 A5:2 G5:1 F5:1 ','')+'D5:3 F5:1 A5:2 G5:1 F5:1 G5:2 E5:1 C#5:1 A4:2 C#5:1 E5:1 >D5:2 r:6 r:8 r:8 r:8 >A5:16')
def block(b0,M,vel):
  notes,_=M
  for pos,p,l,acc in notes:
    b=b0+int(pos//8); r,q=S.chord_at(b,int(pos%8)); pcs=[(r+x)%12 for x in CT[q][:4]]
    if p%12 not in pcs: pcs=pcs+[(r+x)%12 for x in TEN[q]]
    below=[y for y in range(p-11,p) if y%12 in pcs and y%12!=p%12][::-1][:3]
    S.mel('piano',b0,([(pos,p,l,acc)]+[(pos,y,l,False) for y in below]+[(pos,p-12,l,False)],0),vel,legato=0.85,late=0,hum=3)
def melo(b0,M,vel,octave=True):
  notes,_=M
  S.mel('piano',b0,M,vel,late=0,hum=3)
  if octave: S.mel('piano',b0,([(a,p-12,l,c) for a,p,l,c in notes],0),vel-14,late=0,hum=3)
S.section('Intro',chart('Em7 A7alt')*4+chart('Em7 | A7alt | Dmaj7 | Em7 A7alt'),'intro',0.4)
h=S.section('Head',FORM,'head',0.65)
p=S.section('Piano solo',FORM*2,'psolo',0.8)
t=S.section('Trading fours',FORM,'trade',0.85)
o=S.section('Head out',A1+A1+BR+A1[:6]+chart('Bbmaj7 | Em7 A7alt | Dmaj7 | Em7 A7alt | Bbmaj7 | Em7 A7alt | Dmaj7#11 | Dmaj7#11'),'out',0.75)
for i in range(len(S.bars)-6,len(S.bars)): S.bars[i]=(S.bars[i][0],'Head out','tag')
S.bars[-1]=(S.bars[-1][0],'Head out','final')
for i in range(32):
  if (i//4)%2==1: c,n,m=S.bars[t+i]; S.bars[t+i]=(c,n,'drumsolo')
# head
melo(h,melody(MA1),84); melo(h+8,melody(MA2),86); block(h+16,melody(MBR),80); melo(h+24,melody(MA3),88)
S.solo('piano',p,64,62,88,80,74,arc=(0.3,0.95),late=0)
for i in range(0,32,8): S.solo('piano',t+i,4,62,88,90,76,arc=(0.9,0.95),late=0)
melo(o,melody(MA1),88); melo(o+8,melody(MA2),88); block(o+16,melody(MBR),84); melo(o+24,END,88)
# left hand: shells while RH plays lines/melody; skip under block chords
S.comp(vel=56,modes_vel={'intro':6,'head':-4,'psolo':-4,'trade':0,'out':-2,'tag':4},shell_modes=('head','psolo','trade','out'),skip_modes=('drumsolo',),lo=48,hi=58)
S.tr['piano']=[n for n in S.tr['piano'] if not ((h+16)*BAR<=n['tick']<(h+24)*BAR and n['pitch']<60 and n['velocity']<75) and not ((o+16)*BAR<=n['tick']<(o+24)*BAR and n['pitch']<60 and n['velocity']<75)]
S.bass(vel=92)
S.tr['bass']=[n for n in S.tr['bass'] if S.bars[min(n['tick']//BAR,len(S.bars)-1)][2]!='drumsolo']
S.drums(vel=64,modes_vel={'intro':-10,'head':-4,'psolo':0,'trade':4,'out':2},brush_modes=('intro','head'))
meta=dict(title='Marigold Sprint',slug='marigold_sprint',key='D major',form='intro-head AABA-piano solo 2 choruses-trading fours with drums-head out-tag',style='medium-up swing piano trio',
 mix=[["Piano","piano",0,0,104,66],["Upright Bass","bass",2,32,90,64],["Drums","drums",9,0,84,64]])
S.save(V,meta,ARC)
