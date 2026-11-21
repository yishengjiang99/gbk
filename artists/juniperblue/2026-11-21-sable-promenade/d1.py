# Draft 1 "Chicory Second Line": New Orleans second-line in F, 104 BPM. Trumpet, clarinet, trombone, tuba, banjo, street drums.
import sys,json
from jazz import *
from extra import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(104,300,1121)
A=chart('F | F | C7 | C7 | C7 | C7 | F | F7 | Bb | Bbm6 | F | D7 | G7 | C7 | F | C7')
B=chart('Bb | Bb | F | F | G7 | G7 | C7 | C7 | Bb | Bdim7 | F | D7 | Gm7 | C7 | F | F')
MA=('r:1 C5:1 >A4:2 C5:1 D5:1 >F5:2 D5:1 C5:1 A4:2 F4:3 r:1 '
    'r:1 E5:1 >G5:2 E5:1 C5:1 Bb4:2 A4:1 G4:1 E4:2 G4:3 r:1 '
    'r:1 Bb4:1 C5:1 D5:1 E5:2 G5:2 >Bb5:3 A5:1 G5:2 E5:2 '
    '>F5:4 C5:2 A4:2 Eb5:3 D5:1 C5:2 A4:2 '
    '>D5:3 F5:1 Bb5:2 F5:2 >Db5:3 F5:1 Bb4:2 Db5:2 '
    'C5:2 A4:1 F4:1 A4:2 C5:2 >F#5:3 D5:1 C5:2 A4:2 '
    'B4:1 D5:1 F5:1 G5:1 >A5:2 G5:2 E5:1 G5:1 Bb5:1 G5:1 E5:2 C5:2 ')
MA_END1='>F5:4 r:2 A4:1 Bb4:1 B4:1 C5:1 r:1 C5:1 r:1 E5:1 G5:2 '
MA_END2='>F5:6 r:2 r:8 '
MB=('r:2 >D5:2 F5:2 D5:1 Bb4:1 >G5:4 F5:2 D5:2 '
    'r:2 >C5:2 F5:2 C5:1 A4:1 >D5:4 C5:2 A4:2 '
    'r:1 B4:1 D5:1 F5:1 >A5:3 G5:1 F5:2 D5:2 B4:2 G4:2 '
    '>Bb4:3 C5:1 E5:2 G5:2 >Bb5:4 A5:1 G5:1 E5:2 '
    'r:2 >D5:2 F5:2 D5:1 Bb4:1 >Ab5:4 F5:2 D5:2 '
    '>A5:3 G5:1 F5:2 C5:2 >F#5:3 E5:1 D5:2 C5:2 '
    'Bb4:2 D5:2 F5:1 G5:1 Bb5:2 >A5:3 G5:1 E5:2 Bb4:2 '
    '>F5:6 r:2 r:4 C5:1 D5:1 E5:1 G5:1 ')
TAGM='>A5:3 G5:1 F5:2 C5:2 >F#5:3 E5:1 D5:2 C5:2 B4:1 D5:1 F5:1 G5:1 >A5:2 G5:1 E5:1 >F5:16 '
INTRO=chart('C7 | C7 | C7 | C7 | C7 | C7 | C7 | C7')
S.section('Street beat',INTRO[:4],'street',0.4); S.section('Intro',INTRO[4:],'intro',0.5)
hA=S.section('Head A',A,'head',0.6); hB=S.section('Head B',B,'head',0.65)
cs=S.section('Clarinet solo',A,'solo',0.7); ts=S.section('Trumpet solo',B,'solo',0.8)
oA=S.section('Out chorus',A,'out',0.9); tg=S.section('Tag',chart('Bb | D7 | G7 C7 | F'),'out',0.85)
S.bars[-1]=(S.bars[-1][0],'Tag','final')
def harm(k,b0,M,vel,octave=0,lo=3,hi=9):
  notes,_=M
  for pos,p,l,acc in notes:
    b=b0+int(pos//8); r,q=S.chord_at(b,int(pos%8))
    cts=[(r+x)%12 for x in CT[q][:4]]
    h=min([y for y in range(p+lo,p+hi+1) if y%12 in cts] or [p+4])
    S.mel(k,b0,([(pos,h+octave,l,acc)],0),vel,legato=0.85,late=2)
# intro: horns riff on C7
IR=melody('r:1 G4:1 Bb4:1 C5:1 >E5:3 r:1 r:1 G4:1 Bb4:1 C5:1 >D5:3 r:1 r:1 G4:1 Bb4:1 C5:1 >E5:2 G5:2 >Bb5:4 r:4')
S.mel('trumpet',4,IR,84,late=6); S.mel('trombone',4,melody('r:1 E3:1 G3:1 Bb3:1 >C4:3 r:1 r:1 E3:1 G3:1 Bb3:1 >Bb3:3 r:1 r:1 E3:1 G3:1 Bb3:1 >C4:4 >E4:8'),80,late=8)
S.mel('trumpet',hA,melody(MA+MA_END1),90,late=8); S.mel('trumpet',hB,melody(MB),92,late=8)
harm('clarinet',hA,melody(MA+MA_END1),70); 
S.solo('clarinet',hB,16,74,91,66,66,arc=(0.3,0.5),late=0,motif_p=0.3)  # obbligato over B
S.solo('clarinet',cs,16,62,89,80,74,arc=(0.4,0.9),late=0)
S.solo('trumpet',ts,16,62,84,82,74,arc=(0.4,0.95),late=8)
S.mel('trumpet',oA,melody(MA+MA_END2),96,late=8); S.solo('clarinet',oA,16,74,92,72,72,arc=(0.6,0.9),late=0,motif_p=0.35)
S.mel('trumpet',tg,melody(TAGM),94,late=8); harm('clarinet',tg,melody(TAGM),78)
guide(S,'trombone',hA,32,70,lo=46,hi=60)
guide(S,'trombone',cs,32,60,lo=46,hi=60)
guide(S,'trombone',oA,16,74,lo=46,hi=60)
S.mel('trombone',tg,melody('>A3:4 C4:4 >F#3:8 F3:4 E3:4 >A3:16'),80,late=8)
tuba(S,'tuba',88,skip_modes=('street',))
strum(S,'banjo',58,skip_modes=('street',))
secondline(S,vel=86,modes_vel={'street':-4,'intro':0,'head':0,'solo':-2,'out':4})
meta=dict(title='Chicory Second Line',slug='chicory_second_line',key='F major',form='street beat-intro riff-head AB-clarinet solo-trumpet solo-out chorus-tag',style='New Orleans second line',
 mix=[["Trumpet","trumpet",0,56,100,60],["Clarinet","clarinet",1,71,84,78],["Trombone","trombone",3,57,80,48],["Tuba","tuba",2,58,80,64],["Banjo","banjo",4,105,62,84],["Drums","drums",9,0,104,64]])
S.save(V,meta,ARC)
