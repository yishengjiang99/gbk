from lib import *
import sys
U=PPQ; BAR=3*U
# Valse mélancolique in A minor, solo piano. Durations in quarters.
Ac=['A:m','A:m','D:m','E:7','E:7','A:m','B:hd7','E:7','A:m','A:m','A:7','D:m','D:m','A:m/E','E:7','A:m']
Am_='E5:2 C5:1 A4:1 C5:1 E5:1 F5:2 E5:0.5 D5:0.5 D5:2 B4:1 G#4:1 B4:1 D5:1 C5:2 A4:1 D5:1 F5:1 A5:1 G#5:2 r:1 '\
    'E5:2 C5:1 A4:1 C5:1 E5:1 G5:2 E5:1 F5:1.5 E5:0.5 D5:1 A5:2 F5:1 E5:2 C5:1 B4:1 D5:1 G#4:1 A4:2 r:1'
Bc=['C:M','C:M/E','F:M','G:7','E:m','A:m','D:7','G:7','C:M','C:7','F:M','F:m','C:M/G','G:7','C:M','E:7']
Bm='G5:2 E5:1 C6:2 G5:1 A5:2 F5:1 D5:1 F5:1 B5:1 B5:2 G5:1 A5:1.5 G5:0.5 E5:1 F#5:2 A5:1 G5:2 r:1 '\
   'G5:2 E5:1 Bb5:2 G5:1 A5:2 C6:1 Ab5:2 F5:1 E5:2 G5:1 F5:1 D5:1 B4:1 C5:2 E5:1 G#5:2 B5:1'
Tc=['A:M','A:M','D:M/F#','E:7','F#:m','B:m7','E:7','A:M','A:M','A:7','D:M','D:m','A:M/E','E:7','A:M','E:7']
Tm='C#5:2 E5:1 A5:2 E5:1 F#5:2 D5:1 E5:1 G#5:1 B5:1 A5:2 C#5:1 D5:1 F#5:1 A5:1 G#5:2 D5:1 C#5:2 r:1 '\
   'C#5:2 E5:1 G5:2 E5:1 F#5:2 A5:1 F5:2 A5:1 E5:2 C#5:1 D5:1 B4:1 G#4:1 A4:2 C#5:1 G#4:1 B4:1 D5:1'
Cc=['A:m','D:m/A','A:m','D:m/A','A:m/E','E:7','A:m','A:m']
Cm='E5:3 F5:2 D5:1 C5:3 A5:2 F5:1 E5:2 C5:1 B4:2 G#4:1 A4:3 r:3'
Ic=['A:m','A:m','A:m','E:7/G#']
# name, chords, melody, base velocity, melody octave shift, harmony doubling, base bpm
plan=[('Intro',Ic,'r:12',60,0,False,120),('A',Ac,Am_,66,0,False,126),('B',Bc,Bm,76,0,True,132),
      ("A'",Ac,Am_,72,0,True,126),('Trio',Tc,Tm,62,0,False,112),("Trio'",Tc,Tm,70,12,True,116),
      ("A''",Ac,Am_,60,0,False,122),('Coda',Cc,Cm,52,0,False,112)]
REV=int(sys.argv[1]) if len(sys.argv)>1 else 1
M=[];L=[];R=[];ccs=[];tempos=[];chords=[];sections=[];bar=0
for sec,chs,m,dv,osh,dbl,bpm0 in plan:
    sections.append({'name':sec,'startBar':bar+1,'bars':len(chs)}); t0=bar*BAR; n=len(chs)
    tot=sum(float(x.split(':')[1]) for x in m.split()); assert tot==3*n,(sec,tot)
    for k,c in enumerate(chs):
        chords.append((t0+k*BAR,t0+(k+1)*BAR,c))
        ph=k%8  # rubato: push into the phrase middle, broaden the last bar
        bpm=bpm0+[0,1,2,3,3,2,0,-6][ph]
        if sec=='Coda': bpm=[112,108,104,98,90,80,70,60][k]
        if sec=='Intro' and k==3: bpm=114
        tempos.append((t0+k*BAR,bpm))
    def vel(t,dv=dv,t0=t0):  # arch over each 8-bar phrase, peak ~bar 6
        x=((t-t0)%(8*BAR))/(8*BAR); a=x/0.65 if x<0.65 else (1-x)/0.35
        return int(dv-7+14*a+(5 if (t-t0)%BAR==0 else 0))
    mn,_=mel(m,t0,U,vel)
    for x in mn:
        x[2]+=osh; x[1]=int(x[1]/0.95*(0.97 if x[1]>=U else 0.9)); M.append(x)
        if dbl:  # inner third/sixth under the tune
            c=[c for a,b,c in chords if a<=x[0]<b][0]; P,_=chord(c)
            lo=[y for y in range(x[2]-9,x[2]-2) if y%12 in P]
            if lo: R.append([x[0],x[1],lo[-1],x[3]-16])
        if osh: R.append([x[0],x[1],x[2]-12,x[3]-18])
    for k,c in enumerate(chs):
        P,bs=chord(c); tb=t0+k*BAR; bass=31+((bs-31)%12)  # G1..F#2
        hi=min([v[2] for v in M if tb<=v[0]<tb+BAR] or [72])
        if dbl or osh: hi=min([hi]+[r[2] for r in R if tb<=r[0]<tb+BAR])
        tones=[x for x in range(50,66) if x%12 in P and x<hi-2][:3]
        if len(tones)<3: tones=[x for x in range(45,66) if x%12 in P and x<hi-2][-3:]
        if k%2==0 and sec!='Intro': tones=[x for x in tones if x!=bass+12]
        lv=dv-26; last=(sec=='Coda' and k>=6)
        if last:
            if k==7:
                for j,x in enumerate([33,45,52,57,60,64,69]): L.append([tb+j*50,BAR*2,x,46-j*2])
        else:
            L.append([tb,int(U*1.8),bass,lv+12])
            if k%2==0 and sec not in ('Intro',): L.append([tb,int(U*1.8),bass+12,lv+2])
            lilt=-24 if sec.startswith('A') else (-12 if sec=='Intro' else 0)
            for b,acc in ((1,4),(2,0)):
                for x in tones: L.append([tb+b*U+(lilt if b==1 else 0),int(U*0.55),x,lv+acc])
        ccs+=[(64,max(0,tb-12),0),(64,tb+40,110)]
    bar+=n
S={'ts':(3,4),'tempos':tempos,'tracks':[{'name':'Piano','program':0,'notes':sorted(M+R+L),'ccs':ccs+[(91,0,45)],'role':'melody','pan':64}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('waltz.json','w'))
print('len',to_midi(S,'waltz.mid'),'bars',bar)
bad=[]
for t,d,pt,v in M:
    if t%BAR==0 and d>=U*0.9:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,pt,c))
print('NCT',bad)
print('mel range',min(v[2] for v in M),max(v[2] for v in M),'acc range',min(v[2] for v in L),max(v[2] for v in L))
cross=sum(1 for l in L for m in M if l[0]<=m[0]<l[0]+l[1] and l[2]>=m[2])
print('LH above/at melody',cross)
from collections import Counter
k=Counter((n[0],n[2]) for n in S['tracks'][0]['notes']); print('dup notes',sum(v-1 for v in k.values() if v>1))
ns=S['tracks'][0]['notes']; print('notes',len(ns),'vel',min(n[3] for n in ns),max(n[3] for n in ns))
print(render('waltz.mid','waltz.mp3'))
