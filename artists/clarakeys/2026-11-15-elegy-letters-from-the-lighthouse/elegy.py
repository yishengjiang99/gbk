# Elegy in C Minor for viola and piano, "Letters from the Lighthouse" (Clara Keys). 4/4 Adagio, A A' B A'' coda.
from lib import *
import sys, json
E=PPQ//2; BAR=8*E
A1=[('C:m',"G4:3 Ab4:1 G4:2 Eb4:2"),('F:m/Ab',"F4:2 Ab4:2 C5:3 Bb4:1"),('G:7/B',"B3:2 D4:2 F4:3 Eb4:1"),('C:m',"Eb4:3 D4:1 C4:4"),
 ('Ab:M',"C5:3 Bb4:1 Ab4:2 C5:2"),('F:m7',"F5:4 Eb5:2 C5:2"),('D:hd7',"Ab4:3 G4:1 F4:2 D4:2"),('G:7',"B3:2 D4:2 G4:4")]
A2=A1[:4]+[('Ab:M',"Eb5:3 F5:1 Eb5:2 C5:2"),('F:m',"C5:3 Db5:1 C5:2 Ab4:2"),('G:7',"B4:2 D5:2 F5:3 D5:1"),('C:m',"C5:6 r:2")]
B=[('Eb:M',"Bb4:3 C5:1 Eb5:2 G5:2"),('Ab:M',"C5:4 Eb5:2 Ab4:2"),('Bb:7',"D5:3 C5:1 Bb4:2 F4:2"),('Eb:M',"G4:6 Bb4:2"),
 ('C:m',"G4:3 Ab4:1 G4:2 C5:2"),('Ab:M',"Eb5:4 C5:2 Ab4:2"),('F:m7',"F5:3 Eb5:1 C5:2 Ab4:2"),('Bb:7',"D5:4 r:2 F4:2"),
 ('Eb:M/G',"G4:3 Bb4:1 Eb5:2 G5:2"),('Ab:M7',"Ab5:4 G5:2 F5:2"),('D:hd7/Ab',"F5:4 D5:2 C5:2"),('G:7',"B4:4 D5:2 F5:2")]
A3=[('C:m',"G5:3 Ab5:1 G5:2 Eb5:2"),('F:m/Ab',"F5:2 Ab5:2 C5:3 Bb4:1"),('G:7/B',"B4:2 D5:2 F5:3 Eb5:1"),('C:m',"Eb5:3 D5:1 C5:4")]+A2[4:]
CO=[('Ab:M',"C5:4 Eb5:2 C5:2"),('G:7',"G4:4 F4:2 D4:2"),('C:M',"E4:4 G4:2 C5:2"),('C:M',"C5:8")]
INTRO=[('C:m',"r:8"),('G:7/B',"r:8")]
plan=[('Intro',INTRO,'flow',(40,46),56),('A: viola theme',A1,'flow',(42,52),58),('A repeat',A2,'flow',(48,58),58),
 ('B: E-flat major, warmer',B,'pulse',(54,76),62),('A return, an octave higher',A3,'flow2',(72,56),58),('Coda: C major',CO,'coda',(52,42),54)]
V=[];PN=[];tempos=[];chords=[];sections=[];bar=0
ccV=[(91,0,52),(7,0,108)];ccP=[(91,0,44)]
for name,M,sty,dyn,bpm in plan:
    n=len(M); t0=bar*BAR; sections.append({'name':name,'startBar':bar+1,'bars':n})
    vb=[dyn[0]+(dyn[1]-dyn[0])*k/max(1,n-1) for k in range(n)]
    for k in range(n):
        b=bpm
        if k%4==3: b=bpm-5
        if k==n-1: b=bpm-9
        if name.startswith('Coda'): b=[54,52,48,42][k]
        tempos.append((t0+k*BAR,b)); chords.append((t0+k*BAR,t0+(k+1)*BAR,M[k][0]))
        if k%4==3: tempos.append((t0+k*BAR+4*E,b-4))
    def vel(t,t0=t0,vb=vb,n=n):
        k=min((t-t0)//BAR,n-1); x=((t-t0)%(2*BAR))/(2*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[k]+14+8*a+(3 if (t-t0)%BAR==0 else 0))
    for k,(c,txt) in enumerate(M):
        ns,te=mel(txt,t0+k*BAR,E,vel); assert te==t0+(k+1)*BAR,(name,k)
        for x in ns: x[1]=int(x[1]/0.95*0.99)
        V+=ns
    for k in range(n*4):
        t=t0+k*BAR//2; x=(k%4)/4; ccV.append((11,t,int(88+34*(x/0.55 if x<0.55 else (1-x)/0.45))))
    for k,(c,_) in enumerate(M):
        t=t0+k*BAR; P,bs=chord(c); lv=int(vb[k])
        g=[x for x in range(36,48) if x%12==bs][0]
        mt=[x[2] for x in V if t<=x[0]<t+BAR]; top=min(mt)-3 if mt else 67
        top=min(top,67 if sty!='flow2' else 70)
        ccP+=[(64,max(0,t-12),0),(64,t+40,100)]
        if sty in('flow','flow2','coda'):
            PN.append([t,BAR-30,g,lv+6])
            if sty=='flow2': PN.append([t,BAR-30,g-12 if g-12>=28 else g,lv+2])
            tl=[x for x in range(g+7,top+1) if x%12 in P][:5]
            seq=tl+tl[-2:0:-1]
            last=8 if not (sty=='coda' and k==n-1) else 1
            for i in range(1,last): PN.append([t+i*E,int(E*1.9),seq[(i-1)%len(seq)],lv-6+(2 if i==4 else 0)])
            if sty=='coda' and k==n-1:
                for j,x in enumerate([x for x in range(g+7,76) if x%12 in P][:6]): PN.append([t+E+j*50,BAR-E-j*50,x,lv-2])
        elif sty=='pulse':
            PN.append([t,4*E-20,g,lv+6]); PN.append([t+4*E,4*E-20,g+12 if g+12<50 else g,lv+2])
            rh=[x for x in range(52,top+1) if x%12 in P][-3:]
            for j in range(8):
                if j%4==0: continue
                PN+=[[t+j*E,int(E*0.8),x,lv-8+(3 if j%2==0 else 0)] for x in rh]
    bar+=n
ccP+=[(64,bar*BAR+PPQ*2,0)]
for nn in PN:
    be=(nn[0]//BAR+1)*BAR
    if nn[1]<BAR and nn[0]+nn[1]>be: nn[1]=be-nn[0]-10
for nn in PN:
    if any(nn[2]==x[2] and x[0]<nn[0]+nn[1] and nn[0]<x[0]+x[1] for x in V): nn[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
last={}
for nn in sorted(PN,key=lambda q:(q[2],q[0])):
    q=last.get(nn[2])
    if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
    last[nn[2]]=nn
S={'ts':(4,4),'tempos':sorted(tempos),'tracks':[
   {'name':'Viola','program':41,'notes':sorted(V),'ccs':ccV,'role':'melody','pan':54},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':ccP,'role':'accompaniment','pan':74}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('elegy.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'elegy.mid'),bar))
bad=[]
for t,d,pt,v in V:
    if t%(2*PPQ)==0 and d>=E*1.5:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,pt,c))
print('strong-beat NCT',bad)
for T in S['tracks']:
    ps=[x[2] for x in T['notes']]; print(T['name'],len(ps),min(ps),max(ps),'vel',min(x[3] for x in T['notes']),max(x[3] for x in T['notes']))
if '--render' in sys.argv: print(render('elegy.mid','elegy.mp3'))
