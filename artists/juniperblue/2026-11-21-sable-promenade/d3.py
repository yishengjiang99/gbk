# Draft 3 "Sable Promenade": Ellington-style mid-tempo swing AABA in Db, 112 BPM. Trumpet, clarinet, trombone, piano, bass, drums.
import sys,json
from jazz import *
from extra import guide
import os
V=sys.argv[1]; LP=int(os.environ.get('LEADPROG','56')); LV=int(os.environ.get('LEADVEL','-12')); ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(112,315,3111)
A1=chart('Db6 | Db7 | Gbmaj7 | Gbm6 | Fm7 | Bb7alt | Ebm7 | Ab7')
A2=chart('Db6 | Db7 | Gbmaj7 | Gbm6 | Fm7 | Bb7alt | Ebm7 Ab7 | Db6')
BR=chart('F#m7 B7 | Emaj7 | Em7 A7 | Dmaj7 | Dm7 G7 | Cmaj7 | Ebm7 | Ab7alt')
M6=('r:1 Ab4:1 >F5:4 Eb5:1 Db5:1 >B4:3 Ab4:1 F4:2 Ab4:2 '
    'r:1 Bb4:1 >Db5:2 F5:3 Eb5:1 >Eb5:3 Db5:1 A4:2 Gb4:2 '
    'r:1 C5:1 >Eb5:2 Ab5:3 G5:1 >Gb5:3 E5:1 Db5:2 B4:2 ')
MA1=M6+'>Bb4:4 Db5:2 Gb5:2 >F5:4 Eb5:1 C5:1 Ab4:1 r:1 '
MA2=M6+'Gb5:2 F5:1 Eb5:1 C5:2 Eb5:2 >Db5:6 r:2 '
MBR=('r:1 C#5:1 E5:1 A5:1 >G#5:2 F#5:1 D#5:1 >E5:3 B4:1 D#5:4 '
     'r:1 B4:1 D5:1 G5:1 >F#5:2 E5:1 C#5:1 >D5:3 A4:1 C#5:4 '
     'r:1 A4:1 C5:1 F5:1 >E5:2 D5:1 B4:1 >C5:3 G4:1 B4:4 '
     'r:1 Bb4:1 Db5:1 F5:1 >Gb5:4 >E5:3 C5:1 B4:2 A4:2 ')
INTRO=chart('Ebm7 Ab7 | Db6 | Ebm7 Ab7 | Db6 | Gbm6 | Db6 | Ebm7 | Ab7alt')
S.section('Intro',INTRO,'intro2',0.35)
a1=S.section('Head A1',A1,'two',0.5); a2=S.section('Head A2',A2,'head',0.55); b=S.section('Head B',BR,'head',0.6); a3=S.section('Head A3',A2,'head',0.6)
ts=S.section('Trumpet solo',A1+A2+BR+A2,'solo',0.75)
cs=S.section('Clarinet solo',A1+A2,'solo2',0.8)
ob=S.section('Head out B',BR,'out',0.7); oa=S.section('Head out A',A1[:6]+chart('Ebm7 Ab7 | Ebm7 Ab7'),'out',0.7)
tg=S.section('Tag',chart('Ebm7 Ab7 | Db6 | Ebm7 Ab7 | Db6'),'out',0.55)
S.bars[-1]=(S.bars[-1][0],'Tag','final')
def harm(k,b0,M,vel,below=False,octave=0):
  notes,_=M
  for pos,p,l,acc in notes:
    bb=b0+int(pos//8); r,q=S.chord_at(bb,int(pos%8))
    cts=[(r+x)%12 for x in CT[q][:4]]+[(r+x)%12 for x in TEN[q]]
    if below: h=max([y for y in range(p-9,p-2) if y%12 in cts] or [p-3])
    else: h=min([y for y in range(p+3,p+10) if y%12 in cts] or [p+4])
    S.mel(k,b0,([(pos,h+octave,l,acc)],0),vel,legato=0.9,late=6)
# intro: piano alone 4 bars (stride-ish), then clarinet low pickup line
IP=melody('r:2 Bb4:1 Db5:1 >Gb5:2 F5:1 Eb5:1 >F5:6 r:2 r:2 Bb4:1 Db5:1 >Gb5:2 F5:1 Eb5:1 >Db5:6 r:2')
S.mel('piano',0,IP,90,late=0); S.mel('clarinet',4,melody('r:8 r:8 r:2 A4:1 Bb4:1 >Db5:2 Eb5:1 E5:1 >F5:3 E5:1 Eb5:1 C5:1 A4:2'),70,late=4)
S.mel('trumpet',a1,melody(MA1),(100+LV)); harm('clarinet',a1,melody(MA1),66,below=True)
S.mel('trumpet',a2,melody(MA2),(100+LV)); harm('clarinet',a2,melody(MA2),70)
S.mel('clarinet',b,melody(MBR),88,late=4)
S.mel('trumpet',a3,melody(MA2),(102+LV)); harm('clarinet',a3,melody(MA2),72)
guide(S,'trombone',a1,32,64,lo=46,hi=60); 
# trombone: bridge pads under clarinet with trumpet doubling a 3rd below clarinet
harm('trumpet',b,melody(MBR),68,below=True)
S.solo('trumpet',ts,32,61,82,92+LV,64,arc=(0.3,0.9),late=10)
guide(S,'clarinet',ts+24,8,54,lo=62,hi=74); guide(S,'trombone',ts+24,8,56,lo=46,hi=60)
guide(S,'clarinet',ts+16,8,56,lo=62,hi=74); guide(S,'trombone',ts+16,8,58,lo=46,hi=60)
S.solo('clarinet',cs,16,62,89,84,74,arc=(0.45,0.9),late=0)
guide(S,'trumpet',cs+8,8,66,lo=60,hi=72); guide(S,'trombone',cs+8,8,58,lo=46,hi=60)
S.mel('clarinet',ob,melody(MBR),90,late=4); harm('trumpet',ob,melody(MBR),72,below=True); guide(S,'trombone',ob,8,66,lo=46,hi=60)
OA=M6+'Gb5:2 F5:1 Eb5:1 C5:2 Eb5:2 Gb5:2 F5:1 Eb5:1 C5:2 Ab4:2 '
S.mel('trumpet',oa,melody(OA),(102+LV)); harm('clarinet',oa,melody(OA),74); guide(S,'trombone',oa,8,68,lo=46,hi=60)
TG='Gb5:2 F5:1 Eb5:1 C5:2 Eb5:2 >F5:6 r:2 Gb5:2 F5:1 Eb5:1 C5:2 Eb5:2 >Db5:12'
S.mel('trumpet',tg,melody(TG),(96+LV)); harm('clarinet',tg,melody(TG),70); guide(S,'trombone',tg,4,62,lo=46,hi=60)
S.bass(vel=88)
S.tr['bass']=[n for n in S.tr['bass'] if n['tick']>=4*BAR]
S.comp(vel=56,modes_vel={'intro2':8,'two':-2,'head':-2,'solo':0,'solo2':-4,'out':0})
S.drums(vel=62,modes_vel={'intro2':-10,'two':-8,'head':-4,'solo':0,'solo2':2,'out':0},brush_modes=('intro2','two','head'))
S.tr['drums']=[n for n in S.tr['drums'] if n['tick']>=4*BAR]
meta=dict(title='Sable Promenade',slug='sable_promenade',key='Db major',form='piano intro-head AABA (clarinet bridge)-trumpet solo-clarinet solo-head out BA-tag',style='Ellington-style mid-tempo swing',
 mix=[["Muted Trumpet" if LP==59 else "Trumpet","trumpet",0,LP,127 if LP==59 else 88,63],["Clarinet","clarinet",1,71,72,68],["Trombone","trombone",3,57,86,60],["Piano","piano",4,0,80,68],["Upright Bass","bass",2,32,50,64],["Drums","drums",9,0,100,64]])
S.save(V,meta,ARC)
