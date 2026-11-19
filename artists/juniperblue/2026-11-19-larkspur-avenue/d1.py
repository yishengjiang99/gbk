# Draft 1 "Coalyard Blues": medium swing minor blues in G minor, 138 BPM. Tenor sax + piano trio.
import sys,json
from jazz import *
V=sys.argv[1]; ARC=json.loads(sys.argv[2]) if len(sys.argv)>2 else None
S=Song(138,310,1119)
BL=chart('Gm7 | Cm7 | Gm7 | Dm7b5 G7alt | Cm7 | Cm7 | Gm7 | Bbm7 Eb7 | Ebmaj7 | D7alt | Gm7 Eb7 | Am7b5 D7alt')
TAIL=BL[8:]
HEAD1=melody('r:1 D5:1 F5:1 >G5:2 F5:1 D5:1 Bb4:1 >C5:3 Eb5:1 r:1 Bb4:1 G4:2 '
 'r:1 D5:1 F5:1 >G5:2 Bb5:1 A5:1 G5:1 F5:2 D5:1 C5:1 >B4:2 Ab4:1 F4:1 '
 'r:1 G5:1 Bb5:1 >C6:2 Bb5:1 G5:1 Eb5:1 F5:3 D5:1 r:2 C5:1 D5:1 '
 'Eb5:1 D5:1 Bb4:1 G4:3 r:2 r:1 Db5:1 F5:1 Ab5:1 >G5:2 Db5:1 Bb4:1 '
 '>D5:3 Bb4:1 G4:1 F4:1 G4:1 Bb4:1 C5:2 Bb4:1 F#4:1 F4:1 Eb4:3 '
 'D5:2 r:1 G4:1 Bb4:1 G4:1 r:1 Db5:1 C5:2 Eb5:1 C5:1 >F#4:3 r:1')
h2='r:1 D5:1 F5:1 >G5:2 F5:1 D5:1 Bb4:1 >C5:3 Eb5:1 r:1 Bb4:1 G4:2 r:1 D5:1 F5:1 >G5:2 Bb5:1 A5:1 G5:1 F5:2 D5:1 C5:1 >B4:2 Ab4:1 F4:1 r:1 G5:1 Bb5:1 >C6:2 Bb5:1 G5:1 Eb5:1 F5:3 D5:1 r:2 C5:1 D5:1 Eb5:1 D5:1 Bb4:1 G4:3 r:2 r:1 Db5:1 F5:1 Ab5:1 >G5:2 Db5:1 Bb4:1 >D5:3 Bb4:1 G4:1 F4:1 G4:1 Bb4:1 C5:2 Bb4:1 F#4:1 F4:1 Eb4:3 '
HEAD2=melody(h2+'>G4:6 r:2 r:8')
TAG=melody('>D5:3 Bb4:1 G4:1 F4:1 G4:1 Bb4:1 C5:2 Bb4:1 F#4:1 F4:1 Eb4:3 D5:2 r:1 G4:1 Bb4:1 G4:1 r:1 Db5:1 C5:2 Eb5:1 C5:1 >F#4:3 r:1')
END=melody('>D5:3 Bb4:1 G4:1 F4:1 G4:1 Bb4:1 C5:2 Bb4:1 F#4:1 F4:1 Eb4:3 >D5:16')
S.section('Intro',TAIL,'intro',0.4)
h1=S.section('Head 1',BL,'head',0.6); h2b=S.section('Head 2',BL,'head',0.65)
s1=S.section('Tenor solo',BL*3,'solo',0.8)
p1=S.section('Piano solo',BL*2,'psolo',0.7)
tr=S.section('Trading fours',BL,'trade',0.85)
o1=S.section('Head out 1',BL,'out',0.8); o2=S.section('Head out 2',BL,'out',0.8)
tg=S.section('Tag',TAIL[:3]+[[ch('Gm6')]],'tag',0.6)
# trades: tenor 4, drums 4, tenor 4 -> make bars 5-8 drum solo
for i in range(4,8): c,n,m=S.bars[tr+i]; S.bars[tr+i]=(c,n,'drumsolo')
S.bars[-1]=(S.bars[-1][0],'Tag','final')
T=-12
S.mel('tenor',h1,HEAD1,88,T); S.mel('tenor',h2b,HEAD2,90,T)
S.solo('tenor',s1,36,50,77,84,62,arc=(0.3,0.95))
S.solo('piano',p1,24,62,86,78,72,arc=(0.35,0.85),late=0)
S.solo('tenor',tr,4,50,77,92,67,arc=(0.9,0.9)); S.solo('tenor',tr+8,4,50,77,92,70,arc=(0.9,0.95))
S.mel('tenor',o1,HEAD1,94,T); S.mel('tenor',o2,HEAD2,92,T); S.mel('tenor',tg,END,86,T)
S.bass(vel=90)
S.comp(vel=58,modes_vel={'intro':2,'head':0,'solo':2,'psolo':-8,'trade':0,'out':3,'tag':0},shell_modes=('psolo',),skip_modes=('drumsolo',))
S.drums(vel=66,modes_vel={'intro':-12,'head':-4,'solo':2,'psolo':-4,'trade':4,'out':4,'tag':-4},tacet_modes=())
# bass drops out on drum solo bars
S.tr['bass']=[n for n in S.tr['bass'] if S.bars[min(n['tick']//BAR,len(S.bars)-1)][2]!='drumsolo']
# drums tacet first 2 intro bars
S.tr['drums']=[n for n in S.tr['drums'] if n['tick']>=2*BAR]
meta=dict(title='Coalyard Blues',slug='coalyard_blues',key='G minor',form='intro-head x2-tenor solo 3 choruses-piano solo 2-trading fours-head out x2-tag',style='medium swing minor blues',
 mix=[["Tenor Sax","tenor",0,66,102,60],["Piano","piano",1,0,92,74],["Upright Bass","bass",2,32,84,64],["Drums","drums",9,0,84,64]])
S.save(V,meta,ARC)
