# Impromptu in B minor, solo piano, "Rain on the Glasshouse" (Clara Keys). 4/4, ternary ABA' + coda, triplet LH.
from lib import *
import sys, json
E=PPQ//2; T3=PPQ//3; BAR=4*PPQ; H=2*PPQ
NM=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']
nm=lambda m: NM[m%12]+str(m//12-1)
def tones(P,lo,hi): return [x for x in range(lo,hi+1) if x%12 in P]
def low(bs,lo): return lo+((bs-lo)%12)
a1=(['B:m','E:m/G','B:m/F#|E:m','F#:7'],'F#5:3 G5:1 F#5:2 D5:2 E5:3 G5:1 B5:4 D5:2 B4:2 G5:2 E5:2 C#5:3 D5:1 A#4:4')
a2=(['B:m','G:M7','E:m7|F#:7','B:m'],'F#5:3 G5:1 F#5:2 B5:2 B5:3 A5:1 F#5:2 D5:2 G5:2 E5:2 E5:2 C#5:1 A#4:1 B4:6 r:2')
b1=(['G:M','A:7','D:M','F#:7/A#'],'B5:3 A5:1 G5:2 D5:2 E5:3 G5:1 C#6:2 A5:2 F#5:3 E5:1 D5:2 A5:2 C#6:3 B5:1 A#5:4')
a3=(['B:m','E:m','C#:hd7|F#:7','B:m'],'F#5:3 G5:1 F#5:2 D5:2 G5:3 F#5:1 E5:2 B4:2 E5:2 G5:2 F#5:2 E5:1 C#5:1 D5:2 C#5:2 B4:4')
B1=(['D:M','B:m','G:M','A:7'],'A5:4 F#5:2 G5:2 F#5:4 D5:4 B5:3 A5:1 G5:2 B5:2 A5:6 r:2')
B2=(['D:M','F#:7/A#','B:m','E:7|A:7'],'A5:3 B5:1 A5:2 D6:2 C#6:4 A#5:4 B5:3 D6:1 F#6:2 D6:2 E6:2 D6:1 B5:1 C#6:2 A5:2')
B3=(['G:M','G:m','D:M/A','B:7'],'D6:4 B5:2 G5:2 Bb5:4 G5:2 D6:2 F#6:3 E6:1 D6:2 A5:2 D#6:3 E6:1 F#6:4')
B4=(['E:m','C:M','F#:sus4|F#:7','F#:7'],'G6:3 F#6:1 E6:2 B5:2 C6:4 E6:2 G5:2 F#5:2 B5:2 A#5:2 C#6:2 F#5:6 r:2')
K=(['B:m','E:m/G','G:M|F#:7','B:m','E:m/B','B:M'],'F#5:3 G5:1 F#5:2 D5:2 E5:4 B4:4 D5:2 B4:2 C#5:2 A#4:2 B4:8 G5:4 E5:4 D#5:8')
cat=lambda *ps:([c for p in ps for c in p[0]],' '.join(p[1] for p in ps))
plan=[dict(n='Introduction',ch=['B:m','F#:7'],sty='trip',v=(56,60),bpm=100),
 dict(n='A: B minor, agitato',ch=cat(a1,a2)[0],m=cat(a1,a2)[1],sty='trip',v=(56,64),bpm=104),
 dict(n='A: D major turn and return',ch=cat(b1,a3)[0],m=cat(b1,a3)[1],sty='trip',v=(66,58),bpm=104,tempo=[None]*7+[96]),
 dict(n='B: D major, cantabile',ch=cat(B1,B2)[0],m=cat(B1,B2)[1],oct=True,sty='flow',v=(54,64),bpm=92),
 dict(n='B: climax, Neapolitan, retransition',ch=cat(B3,B4)[0],m=cat(B3,B4)[1],oct=True,sty=['flow']*4+['trip']*2+['sus']*2,v=[70,78,84,88,80,70,60,52],bpm=96,tempo=[96,98,100,98,94,88,80,72]),
 dict(n="A': B minor, fuller",ch=cat(a1,a2)[0],m=cat(a1,a2)[1],oct=True,sty='trip',v=(64,72),bpm=106),
 dict(n="A': return and close",ch=cat(b1,a3)[0],m=cat(b1,a3)[1],oct=[True]*4+[False]*4,sty='trip',v=(74,56),bpm=104,tempo=[None]*6+[96,90]),
 dict(n='Coda',ch=K[0],m=K[1],sty=['trip']*4+['sus','final'],v=[52,48,46,42,38,34],bpm=96,tempo=[96,92,88,80,72,60])]
M=[];PN=[];mcc=[(91,0,40)];pcc=[(91,0,40)];tempos=[];chords=[];sections=[];bar=0
for S_ in plan:
    n=len(S_['ch']); t0=bar*BAR; sections.append({'name':S_['n'],'startBar':bar+1,'bars':n})
    v=S_['v']; vb=[v[0]+(v[1]-v[0])*k/max(1,n-1) for k in range(n)] if isinstance(v,tuple) else v
    sty=S_['sty'] if isinstance(S_['sty'],list) else [S_['sty']]*n
    octs=S_.get('oct',False); octs=octs if isinstance(octs,list) else [octs]*n
    halves=[]
    for k,c in enumerate(S_['ch']):
        hs=c.split('|'); hs=hs*2 if len(hs)==1 else hs
        for j,h in enumerate(hs): halves.append((t0+k*BAR+j*H,h,k,j)); chords.append((t0+k*BAR+j*H,t0+k*BAR+(j+1)*H,h))
        bpm=S_['bpm']+[0,2,1,-3][k%4]-(4 if k==n-1 else 0)
        if S_.get('tempo') and S_['tempo'][k]: bpm=S_['tempo'][k]
        tempos.append((t0+k*BAR,bpm))
    def vel(t,t0=t0,vb=vb,n=n):
        k=(t-t0)//BAR; x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[min(k,n-1)]+18+12*a+(5 if (t-t0)%BAR==0 else 2 if (t-t0)%PPQ==0 else 0))
    mm=[]
    if 'm' in S_:
        ns,te=mel(S_['m'],t0,E,vel); assert te==t0+n*BAR,(S_['n'],(te-t0)/E)
        for x in ns:
            mm.append(x); k=(x[0]-t0)//BAR
            if octs[k]: mm.append([x[0],x[1],x[2]-12,x[3]-14])
    M+=mm
    for t,c,k,j in halves:
        P,bs=chord(c); s=sty[k]; lv=int(vb[k])-8
        top=min([x[2] for x in mm if t-E<x[0]<t+H] or [86])-2
        if s=='trip':
            b=low(bs,35); up=[x for x in tones(P,b+7,b+26) if x<top] or tones(P,b+7,b+26)
            seq=[b,up[0],up[1],up[min(2,len(up)-1)],up[1],up[0]]
            for i,x in enumerate(seq): PN.append([t+i*T3,int(T3*1.6) if i else H,x,lv+(8 if i==0 else 0)-(7 if i%3 else 0)])
            pcc+=[(64,max(0,t-10),0),(64,t+30,90)]
        elif s=='flow':
            b=low(bs,33); up=[x for x in tones(P,b+7,b+31) if x<top][:5]
            seq=[b]+up
            for i,x in enumerate(seq): PN.append([t+i*T3,H-i*T3,x,lv+(8 if i==0 else -2)-(i==len(seq)-1)*4])
            pcc+=[(64,max(0,t-10),0),(64,t+30,100)]
        elif s=='sus' and j==0:
            b=low(bs,33); rh=[x for x in tones(P,52,70) if x<top][-3:]
            PN+=[[t,int(BAR*0.95),b,lv+6],[t,int(BAR*0.95),b+12,lv]]+[[t+T3*(i+1),int(BAR*0.9),x,lv-6] for i,x in enumerate(rh)]
            pcc+=[(64,max(0,t-10),0),(64,t+30,110)]
        elif s=='final' and j==0:
            seq=[35,47,54,59,63,66,71]
            PN+=[[t+i*40,int(BAR*1.5),x,lv+6] for i,x in enumerate(seq)]
            pcc+=[(64,max(0,t-10),0),(64,t+30,120)]
    bar+=n
for nn in PN:
    if any(nn[2]==x[2] and x[0]<nn[0]+nn[1] and nn[0]<x[0]+x[1] for x in M): nn[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
last={}
for nn in sorted(PN,key=lambda q:(q[2],q[0])):
    q=last.get(nn[2])
    if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
    last[nn[2]]=nn
pcc+=[(64,bar*BAR+PPQ*4,0)]
S={'ts':(4,4),'tempos':tempos,'tracks':[
   {'name':'Piano RH melody','program':0,'notes':sorted(M),'ccs':mcc,'role':'melody','pan':60},
   {'name':'Piano accompaniment','program':0,'notes':sorted(PN),'ccs':pcc,'role':'accompaniment','pan':68}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('impromptu.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'impromptu.mid'),bar))
bad=[]
for t,d,pt,v in M:
    if (t%BAR) in (0,H) and d>=E*1.8:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,nm(pt),c))
print('strong-beat NCT',bad)
print('mel range',nm(min(x[2] for x in M)),nm(max(x[2] for x in M)),'acc range',nm(min(x[2] for x in PN)),nm(max(x[2] for x in PN)))
cross=[(t//BAR+1,nm(pt)) for t,d,pt,v in M if v>0 and any(a<=t<a+b and c>pt and c not in [y[2] for y in M] for a,b,c,w in PN) and pt>=max(y[2] for y in M if y[0]==t)]
print('acc above melody',len(cross),cross[:10])
print('notes',len(M),len(PN),'vel',min(n[3] for n in M+PN),max(n[3] for n in M+PN))
if '--render' in sys.argv: print(render('impromptu.mid','impromptu.mp3'))
