# Song Without Words in E Major, "The Window Seat" (Clara Keys). Oboe and piano, 4/4.
# Intro, A (8), A' to B major (8), B in C-sharp minor (8), A'' (6), coda (3).
from lib import *
import sys, json
Qn=PPQ; E=PPQ//2; BAR=4*Qn
IN=[('E:M',"r:4")]
A=[('E:M',"B4:2 E5:1 F#5:1"),('C#:m',"G#5:3 E5:1"),('A:M',"C#6:2 B5:1 A5:1"),('B:7',"F#5:3 r:1"),
   ('E:M/G#',"G#5:2 B5:1 G#5:1"),('A:M',"E5:1.5 A5:0.5 C#6:2"),('B:7',"A5:2 F#5:1 D#5:1"),('E:M',"E5:3 r:1")]
A2=[('E:M',"B4:2 E5:1 G#5:1"),('C#:m7',"B5:3 G#5:1"),('A:M',"E6:2 C#6:1 A5:1"),('F#:7',"A#5:2 C#6:1 A#5:1"),
   ('B:M',"B5:2 F#5:1 D#5:1"),('G#:m',"D#5:1.5 E5:0.5 F#5:1 G#5:1"),('F#:7',"A#5:2 G#5:1 E5:1"),('B:M',"B5:3 r:1")]
B=[('C#:m',"E5:2 G#5:1 C#6:1"),('G#:7',"B#5:2 D#6:1 B#5:1"),('C#:m',"E6:3 C#6:1"),('F#:m',"A5:2 C#6:1 F#5:1"),
   ('D#:hd7',"A5:2 F#5:1 D#5:1"),('G#:7',"D#6:2 B#5:1 G#5:1"),('F#:m7',"A5:1 C#6:1 B5:1 A5:1"),('B:7',"A5:2 G#5:1 F#5:1")]
A3=[('E:M',"B4:2 E5:1 F#5:1"),('C#:m',"G#5:3 E5:1"),('A:M',"C#6:2 E6:1 C#6:1"),('E:M/B',"B5:2 G#5:1 E5:1"),
   ('B:7',"F#5:2 A5:1 D#5:1"),('E:M',"E5:4")]
CO=[('A:m',"A5:2 E5:1 C5:1"),('E:M',"B4:2 G#4:1 B4:1"),('E:M',"E5:4")]
plan=[('Intro',IN,(48,50),94),('A',A,(56,66),94),("A' (to B major)",A2,(60,72),96),
      ('B, C-sharp minor',B,(68,86),98),("A''",A3,(64,74),92),('Coda',CO,(56,44),80)]
O=[];PN=[];tempos=[];chords=[];sections=[];bar=0
ccO=[(91,0,38),(7,0,114)];ccP=[(91,0,40)]
for name,M,dyn,bpm in plan:
    n=len(M); t0=bar*BAR; sections.append({'name':name,'startBar':bar+1,'bars':n})
    vb=[dyn[0]+(dyn[1]-dyn[0])*k/max(1,n-1) for k in range(n)]
    for k in range(n):
        b=bpm
        if name.startswith('B') and k>=n-2: b=bpm-6*(k-n+3)
        if name=="A''" and k>=n-2: b=bpm-5*(k-n+3)
        if name=='Coda': b=[84,74,60][k]
        if name.startswith('A') and k==n-1 and name!="A''": b=bpm-6
        tempos.append((t0+k*BAR,b)); chords.append((t0+k*BAR,t0+(k+1)*BAR,M[k][0]))
    def vel(t,t0=t0,vb=vb,n=n):
        k=min((t-t0)//BAR,n-1); x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[k]+8+10*a)
    for k,(c,txt) in enumerate(M):
        t=t0+k*BAR
        ns,te=mel(txt,t,Qn,vel); assert te==t+BAR,(name,k)
        for x in ns: x[1]=int(x[1]/0.95*0.97)
        O.extend(ns)
        # expression swell per bar
        lv=int(vb[k]); ccO+=[(11,t,min(127,70+lv//3)),(11,t+2*Qn,min(127,82+lv//3)),(11,t+BAR-60,min(127,72+lv//3))]
        P,bs=chord(c)
        g=[x for x in range(36,48) if x%12==bs][0]
        mt=[x[2] for x in ns]; top=min(min(mt)-2 if mt else 76,74)
        tones=[x for x in range(52,top+1) if x%12 in P]
        if len(tones)<3: tones=[x for x in range(48,top+1) if x%12 in P]
        tones=tones[-3:]
        ccP+=[(64,max(0,t-10),0),(64,t+30,100)]
        last=(name=='Coda' and k==n-1)
        if last:
            PN.append([t,BAR*2,g-12,lv]); PN.append([t,BAR*2,g,lv-4])
            arp=[x for x in range(52,81) if x%12 in P]
            for i,x in enumerate(arp): PN.append([t+i*90,BAR*2-i*90,x,lv-6+i])
            continue
        PN.append([t,BAR-40,g,lv+2])
        if name.startswith('B'): PN.append([t,BAR-40,g-12 if g-12>=28 else g,lv-2]); PN.append([t+2*Qn,2*Qn-40,g+7 if (g+7)%12 in P else g+12,lv-6])
        pat=[0,1,2,1,0,1,2,1] if not name.startswith('B') else [0,1,2,1,2,1,0,1]
        for j,ix in enumerate(pat):
            if j==0: continue
            PN.append([t+j*E,int(E*1.6),tones[ix],lv-14+(4 if j==4 else 0)+(2 if j%2==0 else 0)])
        if name=="A''" and k==2:  # piano echoes the climax
            PN.append([t+3*Qn,Qn,tones[-1]+12 if tones[-1]+12<=84 else tones[-1],lv-8])
    bar+=n
ccP+=[(64,bar*BAR+BAR,0)]
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
for arr in (PN,O):
    last={}
    for nn in sorted(arr,key=lambda q:(q[2],q[0])):
        q=last.get(nn[2])
        if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
        last[nn[2]]=nn
S={'ts':(4,4),'tempos':sorted(set(tempos)),'tracks':[
   {'name':'Oboe','program':68,'notes':sorted(O),'ccs':ccO,'role':'melody','pan':52},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':ccP,'role':'accompaniment','pan':70}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('song.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'song.mid'),bar))
for r in check(S,chords,['Oboe']): print(r)
if '--render' in sys.argv: print(render('song.mid','song.mp3'))
