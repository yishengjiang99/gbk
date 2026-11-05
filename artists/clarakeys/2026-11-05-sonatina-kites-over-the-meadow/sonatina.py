# Sonatina in D Major for Violin and Piano, I. Allegro grazioso (Clara Keys). Sonata form.
from lib import *
import sys
from collections import Counter
U=PPQ; BAR=4*U; H=2*U
NM=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']
nm=lambda m: NM[m%12]+str(m//12-1)
def tmel(s,k): return ' '.join(t if t[0]=='r' else nm(p(t.split(':')[0])+k)+':'+t.split(':')[1] for t in s.split())
def tch(c,k):
    o=[]
    for h in c.split('|'):
        r,rest=h.split(':'); q=rest.split('/'); s=NM[(pc(r)+k)%12]+':'+q[0]
        if len(q)>1: s+='/'+NM[(pc(q[1])+k)%12]
        o.append(s)
    return '|'.join(o)
# --- material (durations in quarters, one entry per bar, 'X|Y' = two chords per bar)
P_C=['D:M','G:M/D|D:M','E:m|E:7','A:M','D:M','G:M|B:m','E:m7/G|A:7','D:M']
P_M=('A4:1 D5:0.5 F#5:0.5 A5:1.5 F#5:0.5 B5:1.5 G5:0.5 F#5:1 D5:1 G5:1 E5:0.5 F#5:0.5 G#5:1 B5:1 A5:2 E5:1 r:1 '
     'A4:1 D5:0.5 F#5:0.5 A5:1.5 F#5:0.5 D6:1.5 B5:0.5 F#5:1.5 E5:0.5 D5:1.5 E5:0.5 G5:1 C#5:1 D5:3 r:1')
T_C=['D:M|B:m','G:M|E:m','B:m|E:7','A:M','D:M/F#|D#:d7','A:M/E|E:7','E:7','E:7']
T_M=('F#5:0.5 A5:0.5 D6:0.5 A5:0.5 B5:0.5 F#5:0.5 D5:0.5 F#5:0.5 G5:0.5 B5:0.5 D6:0.5 B5:0.5 E6:0.5 B5:0.5 G5:0.5 E5:0.5 '
     'F#5:0.5 D5:0.5 B4:0.5 D5:0.5 G#5:0.5 E5:0.5 D5:0.5 B4:0.5 C#5:0.5 E5:0.5 A5:0.5 C#6:0.5 E6:1 C#6:0.5 A5:0.5 '
     'A5:1.5 F#5:0.5 D#5:0.5 F#5:0.5 C6:1 C#6:1.5 B5:0.5 D6:1 B5:0.5 G#5:0.5 E5:0.5 G#5:0.5 B5:0.5 D6:0.5 E6:1 D6:0.5 B5:0.5 G#5:1 E5:1 B4:1 r:1')
S_C=['A:M','F#:m','B:m7|E:7','A:M','A:M','D:M|D:m','A:M/E|E:7','A:M']
S_M=('E5:2 C#5:1 D5:0.5 E5:0.5 F#5:3 E5:0.5 C#5:0.5 D5:2 B4:1 D5:1 C#5:3 r:1 '
     'E5:1 A5:2 G#5:0.5 F#5:0.5 F#5:1.5 A5:0.5 F5:2 E5:1.5 C#5:0.5 B4:1 D5:1 A4:3 r:1')
C_C=['A:M|D:M','A:M/E|E:7','A:M|D:M','E:7|A:M']
C_M='C#6:1 A5:0.5 E5:0.5 F#5:1 A5:1 E5:1 C#6:1 B5:1 G#5:0.5 B5:0.5 A5:1 E5:0.5 C#5:0.5 D5:1 F#5:1 E5:1 D5:1 A4:2'
D_C=['B:m','G:M|F#:7','B:m','B:m','E:m','C:M|B:7','E:m','E:m','A:7','D:M','G:M','C#:hd7|F#:7','B:m','G:M/A','A:7','A:7']
D_M=('F#4:1 B4:0.5 D5:0.5 F#5:1.5 D5:0.5 G5:1.5 D5:0.5 C#5:1 E5:1 D5:1 F#5:1 B5:2 B5:4 '
     'B4:1 E5:0.5 G5:0.5 B5:1.5 G5:0.5 C6:1.5 G5:0.5 F#5:1 A5:1 G5:1 B5:1 E6:2 E6:4 '
     'C#6:0.5 A5:0.5 E5:0.5 A5:0.5 G5:0.5 E5:0.5 C#5:0.5 E5:0.5 D5:0.5 F#5:0.5 A5:0.5 F#5:0.5 D6:0.5 A5:0.5 F#5:0.5 A5:0.5 '
     'B5:0.5 G5:0.5 D5:0.5 G5:0.5 B5:0.5 D6:0.5 B5:0.5 G5:0.5 C#6:1 B5:0.5 G5:0.5 A#5:1 F#5:0.5 E5:0.5 '
     'D6:2 F#6:1 D6:0.5 B5:0.5 B5:2 G5:1 D5:1 C#5:1 E5:1 G5:1 E5:1 G5:2 E5:1 C#5:1')
D_PM='r:12 F#4:1 B4:0.5 D5:0.5 F#5:1.5 D5:0.5 r:12 B4:1 E5:0.5 G5:0.5 B5:1.5 G5:0.5 r:32'
K_C=['D:M','G:M|G:m','D:M/A|A:7','D:M','D:M','D:M']
K_M='A4:1 D5:0.5 F#5:0.5 A5:2 B5:2 Bb5:2 A5:2 G5:1 E5:1 F#5:1 A5:1 D6:2 D6:4 D5:1 r:3'
PC='F#4:2 A4:1 D5:1 G4:1.5 B4:0.5 A4:2 B4:2 D5:1 E5:1 C#5:1.5 B4:0.5 A4:1 C#5:1 F#4:1 A4:1 D5:2 G4:1 B4:1 D5:1 B4:1 B4:1 G4:1 A4:1 G4:1 F#4:3 r:1'
SC='A3:1 C#4:1 E4:1 A4:1 A4:2 F#4:1 C#4:1 D4:1 F#4:1 E4:1 D4:1 C#4:1 E4:1 A4:2 C#5:3 B4:1 D4:1 F#4:1 A4:1 F4:1 E4:1 A4:1 G#4:1 B4:1 C#4:3 r:1'
R=lambda L,k:[tch(c,k) for c in L]
plan=[dict(n='Exposition: first theme',ch=P_C,vm=P_M,sty='alb',v=(60,66),bpm=120),
      dict(n="First theme (piano)",ch=P_C,pm=P_M,cnt=PC,sty='alb',v=(66,72),bpm=120),
      dict(n='Transition',ch=T_C,vm=T_M,sty='drive',v=(78,86),bpm=124),
      dict(n='Second theme (A major)',ch=S_C,vm=S_M,sty='arp',v=(54,60),bpm=110),
      dict(n="Second theme (piano)",ch=S_C,pm=S_M,cnt=SC,sty='arp',v=(60,68),bpm=112),
      dict(n='Closing',ch=C_C,vm=C_M,sty='alb',v=(74,78),bpm=120),
      dict(n='Development',ch=D_C,vm=D_M,pm=D_PM,sty=['drive']*14+['pedal']*2,
           v=[60,62,64,62,66,68,70,68,76,80,84,88,94,80,66,56],bpm=122,tempo=[None]*12+[120,114,106,96]),
      dict(n='Recapitulation: first theme',ch=P_C,vm=P_M,sty='alb',v=(64,70),bpm=120),
      dict(n='Transition (in D)',ch=R(T_C,-7),vm=tmel(T_M,-7),sty='drive',v=(78,84),bpm=124),
      dict(n='Second theme (D major)',ch=R(S_C,5),vm=tmel(S_M,5),sty='arp',v=(56,62),bpm=110),
      dict(n="Second theme (piano, D)",ch=R(S_C,5),pm=tmel(S_M,5),cnt=tmel(SC,5),sty='arp',v=(62,70),bpm=112),
      dict(n='Closing (D)',ch=R(C_C,-7),vm=tmel(C_M,-7),sty='alb',v=(76,82),bpm=120),
      dict(n='Coda',ch=K_C,vm=K_M,sty=['alb']*4+['sweep','final'],v=[70,72,76,80,84,90],bpm=118,tempo=[118,114,110,104,94,84])]
V=[];PN=[];vcc=[(91,0,50),(10,0,50)];pcc=[(91,0,42),(10,0,78)];tempos=[];chords=[];sections=[];bar=0
def tones(P,lo,hi): return [x for x in range(lo,hi+1) if x%12 in P]
def low(bs,lo): return lo+((bs-lo)%12)
for S_ in plan:
    n=len(S_['ch']); t0=bar*BAR; sections.append({'name':S_['n'],'startBar':bar+1,'bars':n})
    v=S_['v']; vb=[v[0]+(v[1]-v[0])*k/max(1,n-1) for k in range(n)] if isinstance(v,tuple) else v
    sty=S_['sty'] if isinstance(S_['sty'],list) else [S_['sty']]*n
    halves=[]
    for k,c in enumerate(S_['ch']):
        hs=c.split('|'); hs=hs*2 if len(hs)==1 else hs
        for j,h in enumerate(hs): halves.append((t0+k*BAR+j*H,h,k)); chords.append((t0+k*BAR+j*H,t0+k*BAR+(j+1)*H,h))
        bpm=S_['bpm']+[0,1,2,-3][k%4]-(4 if k==n-1 else 0)
        if S_.get('tempo') and S_['tempo'][k]: bpm=S_['tempo'][k]
        tempos.append((t0+k*BAR,bpm))
    def vel(t,t0=t0,vb=vb):
        k=(t-t0)//BAR; x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[min(k,n-1)]-5+10*a+(4 if (t-t0)%BAR==0 else 2 if (t-t0)%H==0 else 0))
    vm=[];pm=[]
    for key,dst in (('vm',vm),('pm',pm)):
        if key in S_:
            ns,te=mel(S_[key],t0,U,vel); assert te==t0+n*BAR,(S_['n'],key,(te-t0)/U)
            for x in ns:
                d=x[1]/0.95; x[1]=int(d*(0.8 if d<=U/2 and sty[0]=='drive' else 0.97)); dst.append(x)
    if 'cnt' in S_:  # violin countermelody under the piano tune
        ns,te=mel(S_['cnt'],t0,U,lambda t:vel(t)-10); assert te==t0+n*BAR
        vm+=[[x[0],int(x[1]/0.95*0.97),x[2],x[3]] for x in ns]
    V+=vm; PN+=[[a,b,c,d+2] for a,b,c,d in pm]
    for t,c,k in halves:
        P,bs=chord(c); s=sty[k]; lv=int(vb[k])-(18 if 'cnt' in S_ else 21); first=(t-t0)%BAR==0
        mm=[x[2] for x in vm+pm if t-U//2<x[0]<t+H] or [84]; top=min(mm)-2
        newch=(t-t0)%BAR==0 or c!=[h for h in halves if h[0]==t-H][0][1]
        if s=='alb':
            lo_=low(bs,45); up=tones(P,lo_+1,lo_+12); mid=up[0]; tp=up[2] if len(P)==4 and len(up)>2 else up[1]
            for i,x in enumerate([lo_,tp,mid,tp]): PN.append([t+i*U//2,int(U/2*0.92),x,lv+(4 if i==0 else 0)])
            if newch: PN.append([t,int(H*0.95),lo_-12,lv+2])
            if newch: pcc+=[(64,max(0,t-10),0),(64,t+30,90)]
        elif s=='arp':
            b=low(bs,38); seq=[x for x in tones(P,b,b+26) if x<top]
            idx=[0,2,3,4] if (t-t0)%BAR==0 and c==[h for h in halves if h[0]==t+H][0][1] else [0,2,3,2]
            if (t-t0)%BAR: idx=[5,4,3,2] if c==[h for h in halves if h[0]==t-H][0][1] else [0,2,3,2]
            for i,j in enumerate(idx): PN.append([t+i*U//2,int(U*1.4),seq[min(j,len(seq)-1)],lv+(3 if 'cnt' in S_ else 6)+(5 if i==0 else 0)])
            if newch: pcc+=[(64,max(0,t-10),0),(64,t+30,100)]
        elif s=='drive':
            b=low(bs,36); rh=[x for x in tones(P,55,74) if x<top][-2:]
            for i in range(2):
                PN+= [[t+i*U,int(U*0.6),b,lv+2],[t+i*U,int(U*0.6),b+12,lv-3]]
            for i in range(4): PN+=[[t+i*U//2,int(U*0.42),x,lv-12+(4 if i%2==0 else -3)] for x in rh]
            if first: pcc+=[(64,max(0,t-10),0)]
        elif s=='pedal':
            b=low(bs,33); rh=[x for x in tones(P,55,74) if x<top][-3:]
            for i in range(4): PN.append([t+i*U//2,int(U*0.45),b,lv+(4 if i==0 else 0)])
            PN+=[[t,int(H*0.95),x,lv-4] for x in rh]
        elif s=='sweep' and first:
            seq=tones(P,38,81)[:12]
            for i,x in enumerate(seq): PN.append([t+i*U//3,BAR-i*U//3,x,lv+i])
            pcc+=[(64,max(0,t-10),0),(64,t+30,110)]
        elif s=='final' and first:
            PN+=[[t,int(U*1.6),x,lv+14] for x in (38,50,57,62,66,69)]
            pcc+=[(64,max(0,t-10),0),(64,t+30,100),(64,t+BAR,0)]
    bar+=n
# cleanup: move accompaniment unisons with the violin down an octave, drop dups, trim same-pitch overlaps
for n in PN:
    if any(n[2]==x[2] and x[0]<n[0]+n[1] and n[0]<x[0]+x[1] for x in V): n[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda n:n[3])}.values())
last={}
for n in sorted(PN,key=lambda n:(n[2],n[0])):
    q=last.get(n[2])
    if q and n[0]<q[0]+q[1]: q[1]=max(30,n[0]-q[0]-10)
    last[n[2]]=n
# violin expression swells on long notes
for t,d,pt,v in sorted(V):
    if d>=int(U*1.4): vcc+=[(11,t,86),(11,t+d//3,112),(11,t+2*d//3,108),(11,t+d-20,92)]
    else: vcc+=[(11,t,104)]
A_=[a for a in sys.argv[1:] if a.isdigit()]; VOLV=int(A_[0]) if A_ else 112; VOLP=int(A_[1]) if len(A_)>1 else 96
S={'ts':(4,4),'tempos':tempos,'tracks':[
   {'name':'Violin','program':40,'notes':sorted(V),'ccs':vcc+[(7,0,VOLV)],'role':'melody','pan':50},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':pcc+[(7,0,VOLP)],'role':'accompaniment','pan':78}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('sonatina.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'sonatina.mid'),bar))
bad=[]
for name,ns in (('vln',V),('pno-mel',[x for x in PN if x[3]>0])):
    pass
for t,d,pt,v in V:
    if t%H==0 and d>=U*0.9:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,nm(pt),c))
print('violin strong-beat NCT',bad)
uni=[(t//BAR+1,nm(pt)) for t,d,pt,v in V for a,b,c,w in PN if c==pt and a<t+d and t<a+b]
print('violin/piano unisons',len(uni),uni[:12])
ns=sorted(PN,key=lambda n:(n[2],n[0])); ov=sum(1 for a,b in zip(ns,ns[1:]) if a[2]==b[2] and b[0]<a[0]+a[1])
print('piano same-pitch overlaps',ov,'dups',sum(v-1 for v in Counter((n[0],n[2]) for n in PN).values() if v>1))
print('vln range',nm(min(x[2] for x in V)),nm(max(x[2] for x in V)),'pno range',nm(min(x[2] for x in PN)),nm(max(x[2] for x in PN)))
print('notes',len(V),len(PN),'vel',min(n[3] for n in V+PN),max(n[3] for n in V+PN))
if '--render' in sys.argv: print(render('sonatina.mid','sonatina.mp3'))
