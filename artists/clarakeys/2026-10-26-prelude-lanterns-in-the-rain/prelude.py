from lib import *
import math
prog=['G:m','C:m/Eb','D:7/F#','G:m','Eb:M','C:m','A:hd7','D:7',
'C:m7','F:7','Bb:M7','Eb:M7','A:hd7','D:7','G:m','G:7/B',
'C:m','Ab:M/C','Ab:M/C','D:7','Eb:M/D','D:7','C:m7/D','D:7','Eb:M','A:hd7/C','D:7','G:m','C:m/G','G:m','G:M']
n=len(prog)
cent=[70,71,72,70,72,74,75,74, 76,77,78,79,80,79,78,80, 82,84,85,82,78,76,75,74,76,74,72, 72,70,68,67]
dyn=[52,54,56,54,58,60,62,64, 62,64,66,68,72,74,72,76, 84,92,96,86,78,72,66,60,64,58,54, 56,52,48,44]
B=PPQ*4; R=[];L=[];ccs=[];tempos=[];chords=[]
prev=None
for i,ch in enumerate(prog):
    t0=i*B; P,bs=chord(ch)
    chords.append((t0,t0+B,ch))
    bpm=76 + (2 if 8<=i<16 else 0) + (3 if 16<=i<19 else 0) - (6 if i==19 else 0) - [0,0,4,8,14,20][max(0,i-n+6)]
    tempos.append((t0,bpm))
    c=cent[i]
    tones=sorted([x for x in range(c-9,c+6) if x%12 in P],key=lambda x:abs(x-c))[:3]; a,b2,cc=sorted(tones)
    figs=[[a,cc,b2,cc],[a,b2,cc,b2],[cc,a,b2,a],[a,cc,b2,cc]]
    f=figs[0] if i<8 else figs[1] if i<16 else figs[2] if i<20 else figs[0]
    last=(i==n-1)
    for beat in range(4):
        if last:
            if beat==0:
                for k,x in enumerate([a,b2,cc,cc+5 if (cc+5)%12 in P else cc]): R.append([t0+k*40,B*2,x,dyn[i]-k*2])
            continue
        ff=f if beat%2==0 else (f[::-1] if i%3==2 else f)
        for k,x in enumerate(ff):
            t=t0+beat*PPQ+k*PPQ//4
            acc=10 if k==0 and beat==0 else 4 if k==0 else 0
            # top note of figure sings a bit
            v=dyn[i]-12+acc+(6 if x==max(ff) else 0)+int(6*math.sin(math.pi*(beat*4+k)/16))
            R.append([t,PPQ//4*2,x,v])
    lo=36+((bs-36)%12)
    if lo>45: lo-=12
    if last:
        L.append([t0,B*2,lo-12 if lo-12>=28 else lo,dyn[i]]);L.append([t0,B*2,lo,dyn[i]-6])
    else:
        L.append([t0,B,lo,dyn[i]-4]); L.append([t0,B,lo+12,dyn[i]-10])
        fifth=[x for x in range(lo+5,lo+12) if x%12 in P and x!=lo]
        if fifth: L.append([t0+2*PPQ,PPQ*2-20,fifth[0]+12 if fifth[0]+12<a-2 else fifth[0],dyn[i]-14])
    ccs+= [(64,max(0,t0-10),0),(64,t0+30,110)]
S={'ts':(4,4),'tempos':tempos,'tracks':[{'name':'Piano','program':0,'notes':L+R,'ccs':ccs}]}
json.dump({'S':S,'chords':chords},open('prelude.json','w'))
print(to_midi(S,'prelude.mid'))
for x in check({'ts':(4,4),'tracks':[{'name':'RH','notes':R}]},chords,['RH']): print(x)
print(render('prelude.mid','prelude.mp3'))
