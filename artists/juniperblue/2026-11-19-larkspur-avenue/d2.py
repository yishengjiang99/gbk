# Draft 2 "Larkspur Avenue": medium swing ABAC in Bb, 120 BPM. Trombone + vibes + piano trio.
import sys,json
from jazz import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(120,320,1120)
A=chart('Bbmaj7 | Bbm7 Eb7 | Abmaj7 | Am7b5 D7alt | Gm7 | C7#11 | Cm7 | F7')
B=chart('Dm7 | G7alt | Cm7 | Cm7 | Ebm7 | Ab7 | Dm7 G7 | Cm7 F7')
C=chart('Ebmaj7 | Ab7#11 | Dm7 | G7alt | Cm7 | F7 | Bb6 | Cm7 F7')
FORM=A+B+A+C
MA='r:1 F3:1 >D4:4 C4:1 Bb3:1 Db4:3 C4:1 Bb3:2 G3:2 >G3:6 r:1 Eb3:1 C4:3 A3:1 F#3:2 Bb3:2 r:1 D3:1 >Bb3:4 A3:1 G3:1 >F#3:3 E3:1 G3:2 Bb3:2 Eb4:2 D4:1 C4:1 A3:4 r:2 A3:1 C4:1 Eb4:1 D4:1 C4:1 A3:1 '
MB='r:1 A3:1 C4:1 E4:1 >F4:4 Eb4:3 Db4:1 B3:2 Ab3:2 G3:4 r:2 Bb3:1 C4:1 D4:3 C4:1 Bb3:2 G3:2 r:1 Gb3:1 Bb3:1 >Db4:4 C4:1 C4:3 Bb3:1 Gb3:2 Eb3:2 F3:2 A3:2 B3:2 D4:2 Eb4:3 D4:1 C4:1 A3:1 F3:2 '
MC='r:1 Bb3:1 >G4:4 F4:1 D4:1 D4:3 C4:1 Eb4:2 Gb4:2 >F4:4 E4:1 D4:1 C4:1 A3:1 Ab3:2 B3:1 Eb4:1 F4:3 r:1 Eb4:2 D4:1 C4:1 Bb3:1 G3:1 Eb3:2 A3:3 C4:1 Eb4:3 D4:1 >D4:8 '
HEAD=melody(MA+MB+MA+MC+'r:8')
HEADA=melody(MA); HEADB=melody(MB); HEADC=melody(MC+'r:8')
END=melody(MC.replace('>D4:8 ','')+'D4:8 r:5 A3:1 C4:1 A3:1 >Bb3:16')
INTRO=chart('Cm7 F7 | Dm7 G7alt | Cm7 F7 | Bb6 | Cm7 F7 | Dm7 G7alt | Cm7 | F7')
S.section('Intro',INTRO,'intro2',0.35)
hA1=S.section('Head A1',A,'two',0.5); hB=S.section('Head B',B,'head',0.6); hA2=S.section('Head A2',A,'head',0.6); hC=S.section('Head C',C,'head',0.65)
ts=S.section('Trombone solo',FORM,'solo',0.75)
vs=S.section('Vibes solo',A+B,'solo2',0.8)
oA=S.section('Head out A',A,'out',0.7); oC=S.section('Head out C',C[:6]+chart('Bb6 | Cm7 F7 | Bb6'),'out',0.7)
S.bars[-1]=(S.bars[-1][0],'Head out C','final')
# vibes harmony: chord tone a 3rd-6th above melody, one octave up
def harm(b0,M,vel,octave=12):
  notes,_=M
  for pos,p,l,acc in notes:
    b=b0+int(pos//8); c=S.chord_at(b,int(pos%8)); r,q=c
    cts=[(r+x)%12 for x in CT[q][:4]]+[(r+x)%12 for x in TEN[q]]
    h=min([y for y in range(p+3,p+10) if y%12 in cts] or [p+4])
    S.mel('vibes',b0,([(pos,h+octave,l,acc)],0),vel,legato=0.9,late=4)
S.mel('trombone',hA1,HEADA,86); S.mel('trombone',hB,HEADB,88); S.mel('trombone',hA2,HEADA,88); S.mel('trombone',hC,HEADC,90)
for i in range(8):
  for cc in S.bars[hA1+i][0][:1]:
    r,q=cc; sh=[S.near(66,[(r+CT[q][1])%12],62,72)]; sh.append(S.near(sh[0]+5,[(r+CT[q][3])%12],sh[0]+1,sh[0]+10))
    for j,pp in enumerate(sh): S.add('vibes',(hA1+i)*BAR+j*12,BAR*0.95,pp,50,4)
harm(hB,HEADB,72); harm(hA2,HEADA,72); harm(hC,HEADC,74)
S.solo('trombone',ts,32,46,67,82,58,arc=(0.3,0.9),late=10)
S.solo('vibes',vs,16,62,89,78,77,arc=(0.45,0.9),late=0)
S.mel('trombone',oA,HEADA,90); harm(oA,HEADA,74); S.mel('trombone',oC,END,90); harm(oC,END,74)
S.bass(vel=90)
S.comp(vel=56,modes_vel={'intro2':0,'two':-2,'head':-2,'solo':0,'solo2':-6,'out':0},skip_modes=())
S.drums(vel=62,modes_vel={'intro2':-10,'two':-8,'head':-4,'solo':0,'solo2':2,'out':0},brush_modes=('intro2','two'))
meta=dict(title='Larkspur Avenue',slug='larkspur_avenue',key='Bb major',form='intro-head ABAC-trombone solo-vibes solo-head out AC',style='medium swing',
 mix=[["Trombone","trombone",0,57,102,62],["Vibraphone","vibes",3,11,62,67],["Piano","piano",1,0,92,70],["Upright Bass","bass",2,32,55,64],["Drums","drums",9,0,110,64]])
S.save(V,meta,ARC)
