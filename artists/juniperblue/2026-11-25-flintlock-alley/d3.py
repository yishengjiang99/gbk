# Draft 3 "Flintlock Alley": uptempo bebop in Ab, 208 BPM. Muted trumpet + vibes unison head, piano, bass, drums, fours with drums.
import sys,json
from extra3 import *
from lint import lint
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(208,290,2083)
A1=chart('Abmaj7 | Bbm7 Eb7 | Cm7 F7alt | Bbm7 Eb7 | Abmaj7 Ab7 | Dbmaj7 Gb7 | Cm7 F7alt | Bbm7 Eb7')
A2=chart('Abmaj7 | Bbm7 Eb7 | Cm7 F7alt | Bbm7 Eb7 | Abmaj7 Ab7 | Dbmaj7 Gb7 | Bbm7 Eb7 | Ab6')
B=chart('Em7 A7 | Dmaj7 | Ebm7 Ab7 | Dbmaj7 | Dm7 G7 | Cm7 F7 | Bbm7 | Eb7alt')
MA=('r:1 Eb5:1 F5:1 G5:1 >Ab5:1 C6:1 Bb5:1 Ab5:1 Ab5:1 F5:1 Db5:1 Bb4:1 Db5:1 Eb5:1 >G5:2 '
    'r:1 Eb5:1 D5:1 C5:1 B4:1 >Eb5:1 Db5:1 A4:1 >C5:2 Bb4:1 Db5:1 F5:1 Ab5:1 >G5:2 '
    'r:1 Eb5:1 F5:1 G5:1 >Ab5:1 C6:1 Bb5:1 Gb5:1 >F5:3 Eb5:1 Db5:1 Bb4:1 >E5:2 ')
MA1=MA+'Eb5:1 G5:1 Bb5:1 G5:1 >Ab5:1 Gb5:1 Eb5:1 Db5:1 >C5:2 Db5:1 F5:1 G5:1 Bb5:1 G5:1 Db5:1 '
MA2=MA+'Db5:1 F5:1 Ab5:1 C6:1 >B5:1 G5:1 F5:1 Db5:1 >C5:3 Ab4:1 >Eb5:2 r:2 '
MB=('r:1 B4:1 D5:1 E5:1 >G5:2 E5:1 C#5:1 >F#5:5 r:1 E5:1 F5:1 >Gb5:2 Bb5:1 Db6:1 C6:1 Bb5:1 Gb5:1 Eb5:1 >F5:6 Eb5:1 E5:1 '
    '>F5:2 A5:1 C6:1 B5:1 A5:1 F5:1 D5:1 >Eb5:2 G5:1 Bb5:1 A5:1 G5:1 Eb5:1 C5:1 >Db5:3 F5:1 Ab5:1 C6:1 Bb5:1 Ab5:1 '
    'G5:1 Gb5:1 E5:1 Db5:1 >B4:2 D5:2 ')
if V=='lint': lint('A1',A1,MA1); lint('A2',A2,MA2); lint('B',B,MB); sys.exit()
INTRO=chart('Cm7 F7alt | Bbm7 Eb7')*4
S.section('Intro',INTRO,'intro',0.45)
h=S.section('Head A1',A1,'head',0.6); S.section('Head A2',A2,'head',0.6); S.section('Head B',B,'head',0.65); S.section('Head A3',A2,'head',0.65)
ts=S.section('Trumpet solo',A1+A2+B+A2,'solo',0.85)
vs=S.section('Vibes solo',A1+A2+B+A2,'vsolo',0.75)
tr=[]
for i,(ch,who) in enumerate(((A1[:4],'Fours trumpet'),(A1[4:],'Fours drums'),(A2[:4],'Fours vibes'),(A2[4:],'Fours drums '))):
  tr.append(S.section(who.strip()+' '+str(i+1),ch,'drumsolo' if 'drums' in who else 'trade',0.85))
o=S.section('Head out A1',A1,'out',0.7); S.section('Head out A2',A2,'out',0.7); S.section('Head out B',B,'out',0.7); S.section('Head out A3',A2,'out',0.7)
cd=S.section('Coda',chart('Bbm7 Eb7 | Bbm7 Eb7 | Bbm7 Eb7 | Ab6'),'out',0.6); S.bars[-1]=(S.bars[-1][0],'Coda','final')
def head(b0,v):
  for off,m in ((0,MA1),(8,MA2),(16,MB),(24,MA2)):
    S.mel('tpt',b0+off,melody(m),v,late=8,legato=0.88)
    S.mel('vibes',b0+off,melody(m),v-14,trans=-12,late=6,legato=0.7)
head(h,98)
S.solo('tpt',ts,32,62,86,96,70,arc=(0.35,1.0),late=8)
S.solo('vibes',vs,32,60,89,88,72,arc=(0.35,0.9),late=4)
S.solo('tpt',tr[0],4,64,86,104,74,arc=(0.9,1.0),late=8)
S.solo('vibes',tr[2],4,62,89,98,74,arc=(0.9,1.0),late=4)
head(o,102)
T='r:1 Eb5:1 F5:1 G5:1 >Ab5:1 C6:1 Bb5:1 Ab5:1 Ab5:1 F5:1 Db5:1 Bb4:1 Db5:1 Eb5:1 >G5:2 '
S.mel('vibes',4,melody(T+T),80,trans=-12,late=4,legato=0.7)
for m,v,tt in ((T+T+T+'>Ab5:4 r:4',100,'tpt'),):
  S.mel('tpt',cd,melody(T+'r:1 Eb5:1 F5:1 G5:1 >Ab5:1 C6:1 Bb5:1 Ab5:1 >G5:8 >Ab5:12'),100,late=8)
  S.mel('vibes',cd,melody(T+'r:1 Eb5:1 F5:1 G5:1 >Ab5:1 C6:1 Bb5:1 Ab5:1 >G5:8 >Ab5:12'),86,trans=-12,late=6)
S.bass(vel=86)
S.comp(k='piano',vel=58,modes_vel={'intro':2,'head':0,'solo':2,'vsolo':-8,'trade':0,'out':0},skip_modes=('drumsolo',),lo=50,hi=60)
S.drums(vel=70,modes_vel={'intro':-8,'head':-2,'solo':4,'vsolo':-2,'trade':4,'out':2,'drumsolo':6})
ds=set(b for t in (tr[1],tr[3]) for b in range(t,t+4))
S.tr['bass']=[n for n in S.tr['bass'] if n['tick']//BAR not in ds]
meta=dict(title='Flintlock Alley',slug='flintlock_alley',key='Ab major',form='intro-head AABA-trumpet solo-vibes solo-fours with drums-head out-coda',style='uptempo bebop',
 mix=[["Muted Trumpet","tpt",0,59,120,58],["Vibraphone","vibes",1,11,96,74],["Piano","piano",2,0,78,54],["Upright Bass","bass",3,32,50,64],["Drums","drums",9,0,100,64]])
S.save(V,meta,ARC)
