# Draft 2 "Quarry Lights": Rhodes jazz-funk boogaloo in G minor (dorian), 100 BPM straight 16ths. Trumpet + tenor unison, Rhodes, electric bass, funk kit.
import sys,json
from jazz import *
from extra import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(100,240,2111)
A=chart('Gm7 | Gm7 C7 | Gm7 | Gm7 C7 | Bbm7 Eb7 | Abmaj7 | Gm7 | Am7b5 D7alt')
B=chart('Ebmaj7 | D7alt | Cm7 | F7 | Bbmaj7 | Ebmaj7 | Am7b5 | D7alt')
MA7=('r:1 >G4:0.5 Bb4:0.5 C5:1 D5:1 r:1 F5:1 >D5:2 '
     'r:1 C5:0.5 D5:0.5 F5:1 G5:1 >E5:2 r:2 '
     'r:1 >G4:0.5 Bb4:0.5 C5:1 D5:1 r:1 F5:1 >A5:2 '
     'G5:1 F5:1 D5:1 C5:1 >Bb4:1.5 A4:0.5 G4:2 '
     'r:1 Db5:1 F5:1 Ab5:1 >G5:2 Db5:1 Bb4:1 '
     '>C5:3 Eb5:1 G5:2 F5:1 Eb5:1 '
     '>D5:3 Bb4:1 G4:2 F4:1 G4:1 ')
MA1=MA7+'Bb4:1 C5:1 Eb5:1 C5:1 >F#5:2 Eb5:1 C5:1 '
MA2=MA7+'Bb4:1 A4:1 >G4:4 r:2 '
MB=('r:1 Bb4:1 >G5:4 F5:1 D5:1 >Eb5:3 C5:1 F#4:2 Bb4:2 '
    'r:1 G4:1 >Eb5:4 D5:1 C5:1 >A4:3 C5:1 Eb5:2 F5:2 '
    'r:1 F5:1 >A5:4 G5:1 F5:1 >G5:3 Eb5:1 D5:2 Bb4:2 '
    'r:1 C5:1 Eb5:1 G5:1 >F5:2 Eb5:1 C5:1 >F#5:3 Eb5:1 C5:1 Bb4:1 Ab4:1 F#4:1 ')
VAMP=chart('Gm7 | Gm7 C7')*2
S.section('Intro',VAMP*2,'intro',0.4)
h1=S.section('Head A1',A,'head',0.6); h2=S.section('Head A2',A,'head',0.6); hb=S.section('Head B',B,'bridge',0.65); h3=S.section('Head A3',A,'head',0.65)
ts=S.section('Tenor solo',A+A,'solo',0.8); rs=S.section('Rhodes solo',B+A,'rsolo',0.75)
ob=S.section('Head out B',B,'bridge',0.75); oa=S.section('Head out A',A,'head',0.8)
ot=S.section('Outro',VAMP+chart('Gm7 | Gm7 C7 | Gm7 | Gm9'),'outro',0.6)
S.bars[-1]=(S.bars[-1][0],'Outro','final')
def horns(b0,M,vel):
  S.mel('trumpet',b0,melody(M),vel,legato=0.86,late=4,hum=3); S.mel('tenor',b0,melody(M),vel-4,trans=-12,legato=0.86,late=6,hum=3)
horns(h1,MA1,90); horns(h2,MA2,90); horns(hb,MB,92); horns(h3,MA2,92)
S.solo('tenor',ts,16,50,75,84,62,arc=(0.35,0.95),late=6)
S.solo('rhodes',rs,16,62,86,82,74,arc=(0.35,0.9),late=0)
horns(ob,MB,94); horns(oa,MA2,94)
OUT=melody('r:1 >G4:0.5 Bb4:0.5 C5:1 D5:1 r:1 F5:1 >D5:2 r:1 C5:0.5 D5:0.5 F5:1 G5:1 >E5:2 r:2 r:8 r:8 r:8 r:8 r:1 >G4:0.5 Bb4:0.5 C5:1 D5:1 r:1 F5:1 >A5:2 >G5:8')
S.mel('trumpet',ot,OUT,88,late=4); S.mel('tenor',ot,OUT,84,trans=-12,late=6)
funkbass(S,'bass',92)
S.tr['bass']=[n for n in S.tr['bass'] if n['tick']>=2*BAR]
rhodes(S,'rhodes',62,sparse_modes=('head','bridge'),skip_modes=())
S.tr['rhodes']=[n for n in S.tr['rhodes'] if n['tick']>=4*BAR or n['tick']<0]
funkdrums(S,vel=88,modes_vel={'intro':-4,'head':0,'bridge':-2,'solo':2,'rsolo':-2,'outro':-2})
meta=dict(title='Quarry Lights',slug='quarry_lights',key='G minor',form='vamp intro-head AABA-tenor solo-Rhodes solo-head out BA-vamp outro',style='jazz-funk boogaloo',
 mix=[["Trumpet","trumpet",0,56,96,58],["Tenor Sax","tenor",1,66,96,72],["Rhodes","rhodes",3,4,92,52],["Electric Bass","bass",2,33,62,64],["Drums","drums",9,0,108,64]])
S.save(V,meta,ARC)
