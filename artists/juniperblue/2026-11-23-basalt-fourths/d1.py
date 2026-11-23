# Draft 1 "Basalt Fourths": modal post-bop AABA in F dorian, 144 BPM. Tenor sax, quartal piano, bass, drums.
import sys,json
from extra2 import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(144,300,2311)
A=chart('Fm9 x4 | Dbmaj7#11 x2 | Ebm9 | C7alt')
B=chart('Abm9 x2 | Emaj7#11 x2 | Am9 x2 | Bbm9 | C7alt')
MA=('r:2 C5:1 F5:1 >Bb5:3 Ab5:1 G5:2 Eb5:2 F5:4 '
    'r:2 C5:1 F5:1 >Bb5:2 C6:1 Bb5:1 Ab5:1 G5:1 Eb5:1 C5:1 >D5:4 '
    'r:1 Ab4:1 C5:1 F5:1 >G5:4 F5:1 Eb5:1 C5:2 Ab4:4 ')
MA1=MA+'r:1 Bb4:1 Db5:1 F5:1 >Gb5:3 F5:1 >E5:3 Db5:1 Bb4:2 Ab4:2 '
MA2=MA+'r:1 Bb4:1 Db5:1 F5:1 >Ab5:4 Gb5:1 E5:1 Db5:1 Bb4:1 >C5:4 '
MB=('r:2 Eb5:1 Gb5:1 >Bb5:4 Ab5:1 Gb5:1 Eb5:1 Db5:1 >Eb5:4 '
    'r:2 B4:1 D#5:1 >G#5:4 F#5:1 E5:1 D#5:1 B4:1 >A#4:4 '
    'r:2 E5:1 G5:1 >B5:4 A5:1 G5:1 E5:1 D5:1 >E5:4 '
    'r:1 F5:1 Ab5:1 Db6:1 >C6:4 Bb5:1 Ab5:1 E5:1 Db5:1 >Eb5:2 C5:2 ')
S.section('Intro',chart('Fm9 x8'),'intro',0.35)
h=S.section('Head A1',A,'head',0.55); S.section('Head A2',A,'head',0.55); S.section('Head B',B,'head',0.6); S.section('Head A3',A,'head',0.6)
ts=S.section('Tenor solo',A+A+B+A,'solo',0.8)
ps=S.section('Piano solo',A+A,'psolo',0.7)
o=S.section('Head out B',B,'out',0.7); o2=S.section('Head out A',A,'out',0.7)
tg=S.section('Coda',chart('Fm9 x3 | Fm9'),'out',0.5); S.bars[-1]=(S.bars[-1][0],'Coda','final')
lead=lambda b0,m,v: S.mel('tenor',b0,melody(m),v+8,trans=-12,late=12)  # v2: head an octave down (tenor's home register), +8 vel
lead(h,MA1,96); lead(h+8,MA2,98); lead(h+16,MB,100); lead(h+24,MA2,100)
S.solo('tenor',ts,32,51,77,98,58,arc=(0.3,0.95),late=12)
S.solo('piano',ps,16,62,86,92,70,arc=(0.35,0.85),late=4)
T='r:2 C5:1 F5:1 >Bb5:3 Ab5:1 G5:2 Eb5:2 F5:4 '
S.mel('piano',4,melody(T+T),84,late=2)  # v3: intro teases the fourths motif
lead(o,MB,102); lead(o2,MA2,100)
lead(tg,'r:2 C5:1 F5:1 >Bb5:3 Ab5:1 G5:2 Eb5:2 >F5:20',94)
# intro: bass pedal + piano quartal stabs; head/out bass pedals on long Fm9 vamps
S.bass(vel=86)
ped=set(range(0,8))|set(x for b0 in (h,h+8,h+24,o2) for x in range(b0,b0+4))
S.tr['bass']=[n for n in S.tr['bass'] if n['tick']//BAR not in ped]
pedal(S,'bass',0,8,5,88)
for b0 in (h,h+8,h+24,o2): pedal(S,'bass',b0,4,5,86)
qcomp(S,'piano',62,modes_vel={'intro':4,'head':0,'solo':0,'psolo':-10,'out':2},sparse_modes=('intro',))
S.drums(vel=66,modes_vel={'intro':-12,'head':-4,'solo':4,'psolo':-6,'out':0})
meta=dict(title='Basalt Fourths',slug='basalt_fourths',key='F minor',form='intro vamp-head AABA-tenor solo-piano solo-head out BA-coda',style='modal post-bop, quartal piano',
 mix=[["Tenor Sax","tenor",0,66,127,64],["Piano","piano",1,0,80,58],["Upright Bass","bass",2,32,48,64],["Drums","drums",9,0,100,62]])
S.save(V,meta,ARC)
