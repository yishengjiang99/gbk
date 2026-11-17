# Minuet and Trio in G Major, "The Orchard Dance" (Clara Keys). Piano trio, 3/4.
# Minuet ||: A :||: B A' :||, Trio in C ||: a :||: b a' :||, Minuet da capo (no repeats), coda.
from lib import *
import sys, json
E=PPQ//2; BAR=6*E
MA=[('G:M',"D5:2 G5:1 A5:1 B5:2"),('C:M',"C6:2 B5:1 A5:1 G5:2"),('D:7',"A5:2 F#5:1 G5:1 A5:2"),('G:M',"B5:3 A5:1 G5:2"),
    ('E:m',"G5:2 E5:1 F#5:1 G5:2"),('C:M',"E5:2 C6:1 B5:1 A5:2"),('A:7',"C#5:2 E5:1 G5:1 F#5:1 E5:1"),('D:M',"D5:4 r:2")]
MB=[('D:M',"F#5:2 A5:1 D6:1 A5:2"),('G:M',"B5:2 G5:1 B5:1 D6:2"),('C:M',"E6:2 C6:1 G5:1 E5:2"),('D:7',"F#5:2 A5:1 C6:1 A5:2"),
    ('G:M',"D5:2 G5:1 A5:1 B5:2"),('C:M',"C6:2 E6:1 D6:1 C6:2"),('D:7',"A5:2 C6:1 B5:1 A5:2"),('G:M',"G5:4 r:2")]
TA=[('C:M',"G3:2 C4:2 E4:2"),('F:M',"A4:3 G4:1 F4:2"),('G:7',"D4:2 G4:2 F4:2"),('C:M',"E4:4 r:2"),
    ('A:m',"E4:2 A4:2 C4:2"),('D:7',"D4:2 F#4:2 A4:2"),('G:7',"G4:3 F4:1 D4:2"),('C:M',"C4:4 r:2")]
TB=[('A:m',"C4:2 E4:2 A4:2"),('E:7',"G#4:3 A4:1 B4:2"),('A:m',"C5:2 B4:1 A4:1 E4:2"),('G:7',"D4:2 F4:2 B4:2"),
    ('C:M',"G3:2 C4:2 E4:2"),('F:M',"A4:2 C5:2 A4:2"),('G:7',"G4:2 F4:1 D4:1 B3:2"),('C:M',"C4:4 r:2")]
CO=[('C:M',"E5:2 G5:2 C6:2"),('D:7',"C6:2 A5:2 F#5:2"),('G:M',"B5:2 D6:2 G6:2"),('G:M',"G6:2 r:4")]
GS=[0,2,4,5,7,9,11]
def tenth_below(pt):
    c=pt%12; c=c-1 if c not in GS else c
    i=GS.index(c); o=pt//12; i-=2
    if i<0: i+=7; o-=1
    return 12*o+GS[i]-12
# (name, bars, melody track, style, (vel start, vel end), bpm, extra)
plan=[('Minuet A',MA,'V','min',(62,70),116,''),('Minuet A repeat',MA,'V','min',(66,72),116,'tenths'),
 ('Minuet B',MB,'V','min',(70,82),116,''),('Minuet B repeat',MB,'V','min',(74,84),116,'tenths'),
 ('Trio a, C major (cello)',TA,'C','trio',(50,56),104,''),('Trio a repeat (violin joins)',TA,'C','trio',(54,60),104,'vdouble'),
 ('Trio b',TB,'C','trio',(56,62),104,''),('Trio b repeat',TB,'C','trio',(58,52),102,'vdouble'),
 ('Minuet da capo A',MA,'V','min',(64,70),116,''),('Minuet da capo B',MB,'V','min',(72,84),116,'tenths'),
 ('Coda',CO,'V','coda',(84,92),112,'')]
V=[];C=[];PN=[];tempos=[];chords=[];sections=[];bar=0
ccV=[(91,0,40),(7,0,104)];ccC=[(91,0,40),(7,0,108)];ccP=[(91,0,36)]
for name,M,lead,sty,dyn,bpm,ex in plan:
    n=len(M); t0=bar*BAR; sections.append({'name':name,'startBar':bar+1,'bars':n})
    vb=[dyn[0]+(dyn[1]-dyn[0])*k/max(1,n-1) for k in range(n)]
    for k in range(n):
        b=bpm-(4 if k==n-2 else 0)-(10 if k==n-1 else 0)
        if sty=='coda': b=[112,106,96,80][k]
        tempos.append((t0+k*BAR,b)); chords.append((t0+k*BAR,t0+(k+1)*BAR,M[k][0]))
    def vel(t,t0=t0,vb=vb,n=n):
        k=min((t-t0)//BAR,n-1); x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[k]+10+8*a+(5 if (t-t0)%BAR==0 else 0))
    for k,(c,txt) in enumerate(M):
        ns,te=mel(txt,t0+k*BAR,E,vel); assert te==t0+(k+1)*BAR,(name,k)
        for x in ns: x[1]=int(x[1]/0.95*(0.82 if sty in('min','coda') and x[1]<2*E else 0.97))
        if lead=='V':
            V.extend(ns)
            if ex=='tenths':
                P_,_=chord(c)
                for a,b,p_,v in ns:
                    q=tenth_below(p_)
                    if b>=E*1.5 and q%12 not in P_: q=max(x for x in range(36,p_-14) if x%12 in P_)
                    C.append([a,b,q,v-10])
        else:
            C.extend([[a,b,p_,v+4] for a,b,p_,v in ns])
            if ex=='vdouble': V.extend([[a,b,p_+12,v-8] for a,b,p_,v in ns])
    for k,(c,_) in enumerate(M):
        t=t0+k*BAR; P,bs=chord(c); lv=int(vb[k])
        g=[x for x in range(36,48) if x%12==bs][0]
        mt=[x[2] for x in V+C if t<=x[0]<t+BAR and x[2]>=60]; top=min(mt)-3 if mt else 72
        top=min(top,74)
        if sty=='min':
            PN.append([t,2*E-40,g,lv+2]); PN.append([t,2*E-40,g+12,lv-4])
            rh=[x for x in range(55,top+1) if x%12 in P][-3:]
            for j in (2,4): PN+=[[t+j*E,int(E*1.2),x,lv-12+(2 if j==2 else 0)] for x in rh]
            # cello support when not doubling: dotted-half chord tone
            if ex!='tenths':
                ct=[x for x in range(48,60) if x%12==P[1]][0]
                C.append([t,BAR-40,ct if k%2==0 else [x for x in range(45,57) if x%12==bs][0],lv-12])
        elif sty=='trio':
            ccP+=[(64,max(0,t-12),0),(64,t+40,100)]
            PN.append([t,BAR-30,g-12 if g-12>=28 else g,lv])
            tl=[x for x in range(60,top+8) if x%12 in P][:4]
            if not tl: tl=[64]
            for i,j in enumerate((1,2,3,4,5)): PN.append([t+j*E,int(E*1.6),tl[[0,1,2,1,0][i]%len(tl)],lv-14])
            if ex!='vdouble':
                vt=[x for x in range(67,79) if x%12 in P]
                V.append([t,BAR-40,vt[k%2] if len(vt)>1 else vt[0],lv-16])
        elif sty=='coda':
            PN.append([t,2*E,g,lv]); PN.append([t,2*E,g-12 if g-12>=28 else g,lv-4])
            rh=[x for x in range(55,72) if x%12 in P][-4:]
            fin = k==n-1
            for j in ((0,) if fin else (2,4)): PN+=[[t+j*E+i*(30 if fin else 0),(BAR if fin else int(E*1.3)),x,lv-8] for i,x in enumerate(rh)]
            ct=[x for x in range(43,55) if x%12==bs][0]
            C.append([t,(3*E if fin else BAR-40),ct,lv-6])
            if fin: ccP+=[(64,t-12,0),(64,t+20,100)]
    if sty=='trio': ccP+=[(64,(bar+n)*BAR-12,0)]
    bar+=n
ccP+=[(64,bar*BAR+PPQ*2,0)]
for nn in PN:
    if any(nn[2]==x[2] and x[0]<nn[0]+nn[1] and nn[0]<x[0]+x[1] for x in V+C): nn[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
for arr in (PN,C,V):
    last={}
    for nn in sorted(arr,key=lambda q:(q[2],q[0])):
        q=last.get(nn[2])
        if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
        last[nn[2]]=nn
S={'ts':(3,4),'tempos':sorted(set(tempos)),'tracks':[
   {'name':'Violin','program':40,'notes':sorted(V),'ccs':ccV,'role':'melody','pan':44},
   {'name':'Cello','program':42,'notes':sorted(C),'ccs':ccC,'role':'bass','pan':84},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':ccP,'role':'accompaniment','pan':64}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('minuet.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'minuet.mid'),bar))
bad=[]
for T in S['tracks'][:2]:
  for t,d,pt,v in T['notes']:
    if t%BAR==0 and d>=E*1.5:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((T['name'],t//BAR+1,pt,c))
print('downbeat NCT',bad)
for T in S['tracks']:
    ps=[x[2] for x in T['notes']]; print(T['name'],len(ps),min(ps),max(ps),'vel',min(x[3] for x in T['notes']),max(x[3] for x in T['notes']))
if '--render' in sys.argv: print(render('minuet.mid','minuet.mp3'))
