# Draft 1 "Tamarind Steps": jazz-samba in A minor, 192 BPM straight eighths. Soprano sax, piano partido-alto, bass, samba kit.
import sys,json
from extra3 import *
from lint import lint
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(192,240,2511)
A=chart('Am9 x2 | Dm9 | G13 | Cmaj7 | Fmaj7#11 | Bm7b5 | E7alt | Am9 x2 | Gm9 | C13 | Fmaj7#11 | Bb7#11 | Bm7b5 | E7alt')
B=chart('Fmaj7 x2 | Em9 | A7alt | Dm9 | G13 | Cmaj7 | E7alt')
MA=('r:2 E5:1 >B5:3 A5:1 >C6:5 B5:1 A5:1 E5:2 '
    'r:1 F5:1 A5:1 >E5:3 D5:1 >B4:5 D5:1 E5:1 G5:1 >B5:4 G5:1 E5:1 C5:1 >B4:2 '
    'r:1 A4:1 C5:1 >E5:3 G5:1 >F5:5 D5:1 B4:1 A4:1 >G#4:5 r:1 B4:1 C5:1 >E5:5 D5:1 C5:1 A4:2 '
    'r:2 E5:1 >B5:3 A5:1 >Bb5:5 A5:1 G5:1 D5:2 r:2 E5:1 >A5:3 G5:1 >A5:5 G5:1 E5:1 C5:2 '
    'r:1 D5:1 F5:1 >E5:3 D5:1 >F5:5 D5:1 C5:1 B4:1 >G#4:5 r:1 B4:1 C5:1 D5:1 ')
MB=('>E5:6 F5:1 G5:1 >A5:6 G5:1 >B5:5 A5:1 G5:1 F#5:1 >G5:5 F5:1 Eb5:1 C#5:1 >F5:5 '
    'E5:1 D5:1 A4:1 >B4:5 D5:1 E5:1 F5:1 >E5:5 D5:1 C5:1 B4:1 >G#4:5 r:1 B4:1 D5:1 F5:1 ')
if V=='lint': lint('A',A,MA); lint('B',B,MB); sys.exit()
VAMP=chart('Am9 | Bb7#11')
S.section('Intro',VAMP*4,'intro',0.4)
h=S.section('Head A',A,'head',0.6); hb=S.section('Head B',B,'head',0.65)
ss=S.section('Soprano solo',A+B,'solo',0.8)
ps=S.section('Piano solo',A,'psolo',0.7)
o=S.section('Head out A',A,'out',0.7); ob=S.section('Head out B',B,'out',0.7)
cd=S.section('Coda',VAMP*3+chart('Am9 | Am9'),'coda',0.55); S.bars[-1]=(S.bars[-1][0],'Coda','final')
sop=lambda b0,m,v: S.mel('sop',b0,melody(m),v,late=6,legato=0.9)
sop(h,MA,98); sop(hb,MB,100)
S.solo('sop',ss,24,62,88,94,72,arc=(0.35,0.95),late=6)
S.solo('piano',ps,16,64,86,88,72,arc=(0.35,0.85),late=3)
sop(o,MA,102); sop(ob,MB,102)
HOOK='r:2 E5:1 >B5:3 A5:1 >C6:5 B5:1 A5:1 E5:2 '
sop(cd+2,HOOK+'r:8 '+HOOK+'r:2 E5:1 >B5:3 A5:1 >A5:24',96)
S.mel('piano',2,melody(HOOK+'r:8 '+HOOK),80,late=2)
sambabass(S,'bass',84)
partido(S,'piano',62,modes_vel={'intro':2,'head':0,'solo':0,'psolo':-10,'out':2,'coda':0},sparse_modes=('psolo',))
sambakit(S,82,modes_vel={'intro':-8,'head':-2,'solo':2,'psolo':-2,'out':2,'coda':-4},ride_modes=('solo','out'))
meta=dict(title='Tamarind Steps',slug='tamarind_steps',key='A minor',form='intro vamp-head AB-soprano solo-piano solo-head out AB-coda',style='jazz samba, straight eighths',
 mix=[["Soprano Sax","sop",0,64,115,64],["Piano","piano",1,0,80,60],["Upright Bass","bass",2,32,52,64],["Drums","drums",9,0,100,64]])
S.save(V,meta,ARC)
