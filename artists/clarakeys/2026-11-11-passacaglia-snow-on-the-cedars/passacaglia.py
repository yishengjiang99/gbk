# Passacaglia in F-sharp minor for cello and piano, "Snow on the Cedars" (Clara Keys). 3/4, ground bass + 10 variations + coda.
from lib import *
import sys, json
Qn=PPQ; BAR=3*PPQ; E=PPQ//2
NM=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']
nm=lambda m: NM[m%12]+str(m//12-1)
def tones(P,lo,hi): return [x for x in range(lo,hi+1) if x%12 in P]
MIN=dict(ch=['F#:m','F#:m7/E','D:M','C#:7','B:m','G#:hd7/D','C#:7','F#:m'],g=[42,40,38,37,35,38,37,30])
MAJ=dict(ch=['F#:M','C#:M/E#','D#:m','A#:m/C#','B:M','D#:m7','C#:7','F#:M'],g=[42,41,39,37,35,39,37,30])
CODA=dict(ch=MIN['ch']+['F#:m','F#:m'],g=MIN['g']+[30,30])
# melodies in quarter units: (track, text)
V={
1:('c',"C#4:2 D4:1 E4:2 C#4:1 F#4:3 E#4:2 C#4:1 D4:2 B3:1 F#4:1.5 E4:0.5 D4:1 C#4:2 B3:1 A3:3"),
2:('c',"A4:1.5 G#4:0.5 F#4:1 C#5:1 B4:0.5 A4:0.5 E4:1 D5:2 A4:1 G#4:1.5 A4:0.5 B4:1 B4:1 A4:0.5 G#4:0.5 F#4:1 G#4:1 B4:1 D5:1 E#4:1.5 F#4:0.5 G#4:1 F#4:3"),
3:('p',"C#6:0.5 B5:0.5 A5:0.5 G#5:0.5 A5:0.5 C#6:0.5 E6:1 D6:0.5 C#6:0.5 B5:0.5 A5:0.5 F#5:0.5 A5:0.5 D6:1 C#6:0.5 D6:0.5 E#5:0.5 G#5:0.5 B5:1 G#5:1 D6:0.5 C#6:0.5 B5:0.5 A5:0.5 B5:0.5 D6:0.5 F#6:1 D6:0.5 B5:0.5 G#5:1 G#5:0.5 F#5:0.5 E#5:0.5 F#5:0.5 G#5:1 F#5:3"),
4:('c',"F#5:2 C#5:1 E5:1.5 D5:0.5 C#5:1 D5:1 F#5:1 A5:1 G#5:2 E#5:1 F#5:1.5 E5:0.5 D5:1 B4:1 D5:1 G#5:1 G#5:1.5 F#5:0.5 E#5:1 F#5:3"),
5:('c',"A#4:2 C#5:1 E#4:2 G#4:1 F#4:1.5 A#4:0.5 D#5:1 C#5:2 A#4:1 D#5:1.5 C#5:0.5 B4:1 A#4:2 F#4:1 G#4:1.5 E#4:0.5 G#4:1 F#4:3"),
6:('p',"A#5:1 C#6:1 F#6:1 G#6:1.5 F#6:0.5 E#6:1 F#6:2 D#6:1 E#6:1 C#6:1 A#5:1 D#6:1.5 F#6:0.5 D#6:1 C#6:2 A#5:1 B5:1 A#5:0.5 G#5:0.5 E#5:1 F#5:3"),
7:('c',"C#5:1 F#5:1 A5:1 C#6:2 B5:1 A5:1.5 G#5:0.5 F#5:1 G#5:2 B5:1 D6:2 C#6:0.5 B5:0.5 D6:1.5 C#6:0.5 B5:1 C#6:1 B5:1 G#5:1 A5:3"),
8:('p',"A5:2 C#6:1 E6:2 C#6:1 F#6:2 A5:1 E#6:2 C#6:1 D6:2 F#6:1 G#5:1 B5:1 D6:1 C#6:2 B5:1 C#6:3"),
9:('c',"A3:2 G#3:1 C#4:2 B3:1 A3:2 F#3:1 G#3:2 E#3:1 F#3:1.5 E3:0.5 D3:1 B3:2 G#3:1 E#3:2 C#3:1 F#3:3"),
}
V2={6:('c',"A#3:3 G#3:3 F#3:3 E#3:3 D#3:3 C#4:3 B3:3 A#3:3"),
    8:('c',"F#4:1 G#4:1 A4:1 C#5:1 B4:1 A4:1 F#4:1 A4:1 D5:1 E#4:1 G#4:1 C#5:1 D5:1 C#5:1 B4:1 G#4:1 F#4:1 D4:1 E#4:2 G#4:1 F#4:3"),
    10:('c',"C#4:3 E4:3 F#4:3 E#4:3 D4:3 B3:3 C#4:3 A3:3 F#3:6")}
#      name, harmony, piano style, cello-ground?, dyn (start,end), tempo
plan=[('Theme: the ground alone',MIN,'theme',False,(54,58),58),
 ('Variation 1: the cello enters',MIN,'beats',False,(46,54),60),
 ('Variation 2: rising motion',MIN,'beats',False,(54,62),62),
 ('Variation 3: piano sings, cello carries the ground',MIN,'mid',True,(56,64),64),
 ('Variation 4: high cantabile over arpeggios',MIN,'arp',False,(62,74),64),
 ('Variation 5: F-sharp major, dolce',MAJ,'arp',False,(48,56),60),
 ('Variation 6: major, piano melody, cello descant below',MAJ,'arpsoft',False,(54,62),62),
 ('Variation 7: F-sharp minor, climbing',MIN,'block',False,(70,84),66),
 ('Variation 8: climax, ground in octaves',MIN,'blockbig',False,(86,92),64),
 ('Variation 9: falling away',MIN,'beats',False,(66,48),60),
 ('Coda',CODA,'coda',False,(44,30),56)]
C=[];PM=[];PN=[];tempos=[];chords=[];sections=[];bar=0
ccC=[(91,0,50)];ccP=[(91,0,44)]
for vi,(name,H,sty,cg,dyn,bpm) in enumerate(plan):
    n=len(H['ch']); t0=bar*BAR; sections.append({'name':name,'startBar':bar+1,'bars':n})
    vb=[dyn[0]+(dyn[1]-dyn[0])*k/max(1,n-1) for k in range(n)]
    for k in range(n):
        b=bpm+[0,1,2,1,0,1,-1,-3][k%8] if k<8 else bpm-6-4*(k-8)
        if vi==len(plan)-1: b=[56,55,54,53,52,50,48,46,42,38][k]
        if vi==len(plan)-2 and k==7: b=bpm-5
        tempos.append((t0+k*BAR,b)); chords.append((t0+k*BAR,t0+(k+1)*BAR,H['ch'][k]))
    def vel(t,t0=t0,vb=vb,n=n):
        k=min((t-t0)//BAR,n-1); x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[k]+14+10*a+(4 if (t-t0)%BAR==0 else 0))
    mm=[]
    for src in (V.get(vi),V2.get(vi)):
        if not src: continue
        trk,txt=src; ns,te=mel(txt,t0,Qn,vel); assert te==t0+n*BAR,(name,(te-t0)/Qn)
        for x in ns: x[1]=int(x[1]/0.95*0.98)  # legato
        if src is V2.get(vi) and vi==6:
            for x in ns: x[3]-=26
        if trk=='c': C.extend(ns)
        else:
            for x in ns: x[3]+=8
            PM.extend(ns); mm+=ns
            if vi==8: PM.extend([[x[0],x[1],x[2]-12,x[3]-12] for x in ns])
    # cello expression: phrase swell per 4 bars
    for k in range(0,n*4):
        t=t0+k*BAR//4; x=(k%16)/16; ccC.append((11,t,int(92+28*(x/0.6 if x<0.6 else (1-x)/0.4))))
    for k,c in enumerate(H['ch']):
        t=t0+k*BAR; P,bs=chord(c); g=H['g'][k]; lv=int(vb[k])-6
        top=min([x[2] for x in mm if t-E<x[0]<t+BAR] or [80])-2
        if cg: C.append([t,int(BAR*0.97),g+12,int(vb[k])-4])
        ccP+=[(64,max(0,t-10),0),(64,t+30,100)]
        if sty in('theme','beats','block','blockbig','coda','arp','arpsoft') and not cg:
            PN.append([t,int(BAR*0.97),g,lv+10]); PN.append([t,int(BAR*0.97),g+12,lv+4])
        rh=[x for x in tones(P,53,72) if x<top][-3:]
        if sty in ('theme','beats','coda'):
            if sty=='coda' and k>=8:
                if k==8: PN+=[[t+i*60,BAR*2-200,x,lv] for i,x in enumerate(tones(P,45,61)[:4])]
                continue
            for j in (1,2): PN+=[[t+j*Qn,int(Qn*0.85),x,lv-6-(j-1)*3] for x in rh]
        elif sty=='mid':
            for j in (1,2): PN+=[[t+j*Qn,int(Qn*0.85),x,lv-8] for x in tones(P,50,66)[-3:] if x<top]
        elif sty in ('arp','arpsoft'):
            up=[x for x in tones(P,g+7,g+31)][:6]
            seq=[up[0],up[1],up[2],up[3] if len(up)>3 else up[2],up[2],up[1]]
            for i,x in enumerate(seq[1:],1): PN.append([t+i*E,BAR-i*E,x,lv-(10 if sty=='arpsoft' else 6)-(i%2)*3])
        elif sty in ('block','blockbig'):
            PN.append([t-(0),int(BAR*0.97),g-12 if g-12>=28 else g,lv+6]) if sty=='blockbig' else None
            ch3=[x for x in tones(P,52,76) if x<top][-4:] if sty=='blockbig' else rh
            PN+=[[t,int(Qn*0.95),x,lv-6] for x in ch3]
            for j in (1,2): PN+=[[t+j*Qn,int(Qn*0.8),x,lv-14] for x in ch3]
    bar+=n
ccP+=[(64,bar*BAR+PPQ,0)]
for nn in PN:
    if any(nn[2]==x[2] and x[0]<nn[0]+nn[1] and nn[0]<x[0]+x[1] for x in PM): nn[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
last={}
for nn in sorted(PN,key=lambda q:(q[2],q[0])):
    q=last.get(nn[2])
    if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
    last[nn[2]]=nn
S={'ts':(3,4),'tempos':tempos,'tracks':[
   {'name':'Cello','program':42,'notes':sorted(C),'ccs':ccC,'role':'melody','pan':54},
   {'name':'Piano RH melody','program':0,'notes':sorted(PM),'ccs':ccP,'role':'melody','pan':72},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':ccP,'role':'accompaniment','pan':72}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('passacaglia.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'passacaglia.mid'),bar))
bad=[]
for T in (C,PM):
    for t,d,pt,v in T:
        if t%BAR==0 and d>=E*1.5:
            c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
            if pt%12 not in P: bad.append((t//BAR+1,nm(pt),c))
print('strong-beat NCT',bad)
print('cello',nm(min(x[2] for x in C)),nm(max(x[2] for x in C)),'pm',nm(min(x[2] for x in PM)),nm(max(x[2] for x in PM)),'acc',nm(min(x[2] for x in PN)),nm(max(x[2] for x in PN)))
print('notes',len(C),len(PM),len(PN),'vel',min(n[3] for n in C+PM+PN),max(n[3] for n in C+PM+PN))
if '--render' in sys.argv: print(render('passacaglia.mid','passacaglia.mp3'))
