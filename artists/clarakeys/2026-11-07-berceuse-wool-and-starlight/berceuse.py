# Berceuse in E-flat major for clarinet and piano, "Wool and Starlight" (Clara Keys). 6/8, ternary ABA' + coda.
from lib import *
import sys, json
from collections import Counter
E=PPQ//2; BAR=6*E; H=3*E
NM=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']
nm=lambda m: NM[m%12]+str(m//12-1)
def tones(P,lo,hi): return [x for x in range(lo,hi+1) if x%12 in P]
def low(bs,lo): return lo+((bs-lo)%12)
A1_C=['Eb:M','Ab:M/Eb','Eb:M','Bb:7']; A1_M='G5:3 F5:1 Eb5:1 F5:1 Ab5:3 C6:2 Bb5:1 G5:2 Bb5:1 Eb5:2 G5:1 F5:5 r:1'
A2_C=['Eb:M','Ab:M/Eb','Bb:7','Eb:M']; A2_M='G5:3 F5:1 Eb5:1 F5:1 Ab5:2 C6:1 Eb6:2 D6:1 D6:1 C6:1 Bb5:1 Ab5:2 F5:1 Eb5:5 r:1'
A3_C=['C:m','Ab:M','F:m7','Bb:7']; A3_M='Eb5:2 G5:1 C6:3 C6:2 Eb6:1 Ab5:3 Ab5:2 C6:1 F5:2 Ab5:1 G5:1 F5:1 Eb5:1 D5:2 Bb4:1'
A4_C=['Eb:M','Ab:m/Eb','Eb:M/Bb|Bb:7','Eb:M']; A4_M='G5:3 Bb5:2 Eb6:1 Eb6:3 Cb6:2 Ab5:1 G5:2 Eb5:1 F5:2 D5:1 Eb5:5 r:1'
B1_C=['C:m','F:m/C','G:7/B','C:m']; B1_M='G4:3 Ab4:1 G4:1 F4:1 F4:2 G4:1 Ab4:3 G4:2 F4:1 D4:2 B3:1 C4:5 r:1'
B2_C=['C:m','Bb:7','Eb:M','Ab:M']; B2_M='C5:3 D5:1 Eb5:1 G5:1 F5:3 D5:2 Bb4:1 Eb5:2 G5:1 Bb5:3 Ab5:2 G5:1 C6:3'
B3_C=['Ab:M','Db:M','G:7','C:m']; B3_M='C6:2 Eb6:1 Ab6:3 Ab6:3 F6:2 Db6:1 D6:2 F6:1 B5:2 G5:1 C6:3 Eb6:1 D6:1 C6:1'
B4_C=['Ab:M','F:m7','Bb:7','Bb:7']; B4_M='Ab5:3 G5:1 F5:1 Eb5:1 C5:3 Eb5:2 D5:1 D5:3 F5:1 Ab5:1 G5:1 F5:6'
CN='Bb4:3 G4:2 Bb4:1 C5:3 Eb5:2 D5:1 Eb5:2 D5:1 Bb4:2 G4:1 D5:3 C5:1 Bb4:1 Ab4:1 G4:3 Bb4:2 Eb5:1 Eb5:3 Ab4:2 C5:1 Bb4:2 D5:1 F4:2 Ab4:1 G4:5 r:1'
K_C=['Eb:M','Ab:m/Eb','Eb:M','Ab:m/Eb','Eb:M','Eb:M']; K_M='G5:3 F5:1 Eb5:1 F5:1 Eb5:3 Cb5:3 Bb4:6 Ab5:3 Cb6:3 Bb5:6 r:6'
plan=[dict(n='Introduction',ch=['Eb:M','Ab:M/Eb'],sty='rock',v=(48,50),bpm=76),
 dict(n='A: lullaby (clarinet)',ch=A1_C+A2_C,vm=A1_M+' '+A2_M,sty='rock',v=(50,56),bpm=78),
 dict(n='A: middle phrase and return',ch=A3_C+A4_C,vm=A3_M+' '+A4_M,sty='rock',v=(54,52),bpm=78),
 dict(n='B: C minor, chalumeau',ch=B1_C+B2_C,vm=B1_M+' '+B2_M,sty='agit',v=(56,68),bpm=86),
 dict(n='B: climax and retransition',ch=B3_C+B4_C,vm=B3_M+' '+B4_M,sty=['agit']*5+['rock','pedal','pedal'],v=[76,82,84,74,64,58,52,46],bpm=88,tempo=[None]*5+[80,74,66]),
 dict(n="A': lullaby in the piano",ch=A1_C+A2_C,pm=A1_M+' '+A2_M,cnt=CN,sty='rock',v=(52,54),bpm=76),
 dict(n="A': clarinet returns",ch=A3_C+A4_C,vm=A3_M+' '+A4_M,sty='rock',v=(50,44),bpm=76,tempo=[None]*6+[70,64]),
 dict(n='Coda',ch=K_C,vm=K_M,sty=['rock']*4+['sweep','final'],v=[42,40,38,38,36,34],bpm=72,tempo=[72,70,68,64,58,50])]
V=[];PN=[];vcc=[(91,0,52),(10,0,52)];pcc=[(91,0,46),(10,0,76)];tempos=[];chords=[];sections=[];bar=0
for S_ in plan:
    n=len(S_['ch']); t0=bar*BAR; sections.append({'name':S_['n'],'startBar':bar+1,'bars':n})
    v=S_['v']; vb=[v[0]+(v[1]-v[0])*k/max(1,n-1) for k in range(n)] if isinstance(v,tuple) else v
    sty=S_['sty'] if isinstance(S_['sty'],list) else [S_['sty']]*n
    halves=[]
    for k,c in enumerate(S_['ch']):
        hs=c.split('|'); hs=hs*2 if len(hs)==1 else hs
        for j,h in enumerate(hs): halves.append((t0+k*BAR+j*H,h,k,j)); chords.append((t0+k*BAR+j*H,t0+k*BAR+(j+1)*H,h))
        bpm=S_['bpm']+[0,1,1,-3][k%4]-(3 if k==n-1 else 0)
        if S_.get('tempo') and S_['tempo'][k]: bpm=S_['tempo'][k]
        tempos.append((t0+k*BAR,bpm))
    def vel(t,t0=t0,vb=vb,n=n):
        k=(t-t0)//BAR; x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[min(k,n-1)]+12-6+12*a+(5 if (t-t0)%BAR==0 else 2 if (t-t0)%H==0 else 0))
    vm=[];pm=[]
    for key,dst in (('vm',vm),('pm',pm)):
        if key in S_:
            ns,te=mel(S_[key],t0,E,vel); assert te==t0+n*BAR,(S_['n'],key,(te-t0)/E)
            for x in ns: x[1]=int(x[1]/0.95*0.98); dst.append(x)
    if 'cnt' in S_:
        ns,te=mel(S_['cnt'],t0,E,lambda t:vel(t)-12); assert te==t0+n*BAR
        vm+=[[x[0],int(x[1]/0.95*0.98),x[2],x[3]] for x in ns]
    V+=vm; PN+=[[a,b,c,d+4] for a,b,c,d in pm]
    for t,c,k,j in halves:
        P,bs=chord(c); s=sty[k]; lv=int(vb[k])-(6 if 'cnt' in S_ else 8)
        mm=[x[2] for x in vm+pm if t-E<x[0]<t+H] or [84]; top=min(mm)-2
        if s=='rock':
            b=low(bs,39); up=[x for x in tones(P,b+5,b+22) if x<top] or tones(P,b+5,b+22)
            seq=[b,up[0],up[1]] if j==0 else [up[min(2,len(up)-1)],up[1],up[0]]
            for i,x in enumerate(seq): PN.append([t+i*E,int(E*2.2),x,lv+(6 if i==0 and j==0 else 0)-(3 if i else 0)])
            if j==0: pcc+=[(64,max(0,t-10),0),(64,t+30,96)]
        elif s=='agit':
            b=low(bs,36); rh=[x for x in tones(P,50,72) if x<top][-3:]
            PN+=[[t,int(H*0.9),b,lv+4],[t,int(H*0.9),b+12,lv]]
            for i in (1,2): PN+=[[t+i*E,int(E*0.7),x,lv-10+(2 if i==1 else -2)] for x in rh]
            if j==0: pcc+=[(64,max(0,t-10),0),(64,t+30,70)]
        elif s=='pedal':
            b=low(bs,34); rh=[x for x in tones(P,55,72) if x<top][-3:]
            for i in range(3): PN.append([t+i*E,int(E*0.9),b,lv+(4 if i==0 else -2)])
            if j==0: PN+=[[t,int(BAR*0.95),x,lv-6] for x in rh]
            if j==0: pcc+=[(64,max(0,t-10),0)]
        elif s=='sweep' and j==0:
            seq=tones(P,39,87)[:13]
            for i,x in enumerate(seq): PN.append([t+i*E//2,BAR*2-i*E//2,x,lv+i])
            pcc+=[(64,max(0,t-10),0),(64,t+30,110)]
        elif s=='final' and j==0:
            PN+=[[t,int(BAR*0.95),x,lv+4] for x in (39,51,58,63,67,70,75)]
    bar+=n
for nn in PN:
    if any(nn[2]==x[2] and x[0]<nn[0]+nn[1] and nn[0]<x[0]+x[1] for x in V): nn[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
last={}
for nn in sorted(PN,key=lambda q:(q[2],q[0])):
    q=last.get(nn[2])
    if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
    last[nn[2]]=nn
for t,d,pt,v in sorted(V):
    if d>=int(E*2.8): vcc+=[(11,t,84),(11,t+d//3,110),(11,t+2*d//3,104),(11,t+d-20,86)]
    else: vcc+=[(11,t,100)]
pcc+=[(64,bar*BAR,0)]
A_=[a for a in sys.argv[1:] if a.isdigit()]; VOLV=int(A_[0]) if A_ else 104; VOLP=int(A_[1]) if len(A_)>1 else 100
S={'ts':(6,8),'tempos':tempos,'tracks':[
   {'name':'Clarinet','program':71,'notes':sorted(V),'ccs':vcc+[(7,0,VOLV)],'role':'melody','pan':52},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':pcc+[(7,0,VOLP)],'role':'accompaniment','pan':76}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('berceuse.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'berceuse.mid'),bar))
bad=[]
for t,d,pt,v in V+[x for x in PN if x[3]>0 and False]:
    if (t%BAR) in (0,H) and d>=E*1.8:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,nm(pt),c))
print('clarinet strong-beat NCT',bad)
uni=[(t//BAR+1,nm(pt)) for t,d,pt,v in V for a,b,c,w in PN if c==pt and a<t+d and t<a+b]
print('unisons',len(uni),uni[:12])
print('cl range',nm(min(x[2] for x in V)),nm(max(x[2] for x in V)),'pno range',nm(min(x[2] for x in PN)),nm(max(x[2] for x in PN)))
print('notes',len(V),len(PN),'vel',min(n[3] for n in V+PN),max(n[3] for n in V+PN))
if '--render' in sys.argv: print(render('berceuse.mid','berceuse.mp3'))
