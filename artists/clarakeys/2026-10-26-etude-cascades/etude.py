from lib import *
import math
A=['E:M','C#:m','A:M','B:7','E:M/G#','A:M','F#:7','B:7','E:M','G#:7/B#','C#:m','A:M','F#:m7','B:7','E:M','E:7']
Bs=['C#:m','G#:7','C#:m','A:M','F#:m','G#:7','C#:m','G#:7','A:M','D#:hd7','G#:7','C#:m','F#:m/A','G#:7','B:7','B:7']
A2=['E:M','C#:m','A:M','B:7','E:M/G#','A:M','C:M','B:7','E:M','A:M','A:m/E','F#:m7','B:7','E:M/B','B:7','E:M']
prog=[(c,'A') for c in A]+[(c,'B') for c in Bs]+[(c,'A2') for c in A2]
n=len(prog); B=PPQ*4; R=[];L=[];ccs=[];tempos=[];chords=[]
ten=59
for i,(ch,sec) in enumerate(prog):
    t0=i*B; P,bs=chord(ch); chords.append((t0,t0+B,ch))
    ph=(i%8)/8
    dyn={'A':66,'B':74,'A2':72}[sec]+int(14*math.sin(math.pi*ph))+(10 if sec=='B' and i>=24 else 0)
    if i>=n-3: dyn-= (i-(n-4))*6
    bpm=96-(4 if i%8==7 else 0)-(8 if i in(30,31) else 0)-[0,0,6,14][max(0,i-n+4)]
    tempos.append((t0,bpm))
    last=i==n-1
    if sec=='B' and i<30:
        # broken octaves sweeping
        start=66+ (i%4)*2
        tones=[x for x in range(start,start+20) if x%12 in P][:5]
        seq=tones+tones[-2:0:-1]  # 8 tones up/down
        for k,x in enumerate(seq):
            for h,(pt) in enumerate((x-12,x)):
                t=t0+(k*2+h)*PPQ//4
                R.append([t,PPQ//4,pt,dyn-10+(8 if h==1 and k==len(tones)-1 else 0)+(4 if h==1 else 0)])
    elif last:
        for k,x in enumerate([x for x in range(64,101) if x%12 in P]):
            R.append([t0+k*PPQ//4,B*2-k*PPQ//4,x,min(100,dyn-6+k)])
    else:
        lo=64 if sec=='A' else 66 if sec=='A2' else 64
        tones=[x for x in range(lo,lo+40) if x%12 in P][:9]
        seq=tones[:9]+tones[7:0:-1]  # 16
        if i%2==1 and sec!='B': seq=seq[::-1][1:]+[seq[0]]  # vary direction
        for k,x in enumerate(seq[:16]):
            v=dyn-12+(10 if x==max(seq) else 0)+(4 if k%4==0 else 0)
            R.append([t0+k*PPQ//4,int(PPQ//4*1.3),x,v])
    # LH: bass + tenor melody
    lo=28+((bs-28)%12)
    L.append([t0,B if not last else B*2,lo,dyn-6]); 
    if not last: L.append([t0,B-PPQ,lo+12,dyn-14])
    rh=[(0,2),(2,1),(3,1)] if i%2==0 else [(0,1),(1,1),(2,2)]
    if sec=='B' and i<30: rh=[(0,4)]
    if last: rh=[(0,4)]
    for st,du in rh:
        rng=(43,55) if sec=='B' else (48,62)
        cand=[x for x in range(*rng) if x%12 in P and x>lo+6]
        nx=min(cand,key=lambda x:(abs(x-ten)==0, abs(x-ten)))
        ten=nx
        L.append([t0+st*PPQ,du*PPQ-30,nx,dyn-2])
    ccs+=[(64,max(0,t0-10),0),(64,t0+30,100)]
    if sec=='B': ccs+=[(64,t0+2*PPQ-10,0),(64,t0+2*PPQ+30,100)]
S={'ts':(4,4),'tempos':tempos,'tracks':[{'name':'Piano','program':0,'notes':L+R,'ccs':ccs}]}
json.dump({'S':S,'chords':chords},open('etude.json','w'))
print(to_midi(S,'etude.mid'))
for x in check({'ts':(4,4),'tracks':[{'name':'LHmel','notes':[l for l in L if 43<=l[2]<62]}]},chords,['LHmel']): print(x)
# crossing check: tenor vs RH lowest simultaneous
cr=sum(1 for l in L if l[2]>=50 for r in R if r[0]<l[0]+l[1] and l[0]<r[0]+r[1] and r[2]==l[2])
print('unisons',cr)
print(render('etude.mid','etude.mp3'))
