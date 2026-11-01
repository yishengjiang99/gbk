from lib import *
import math
U=PPQ; BAR=4*U
# Romance in A-flat major for cello and piano. Melody durations in quarters.
A1c=['Ab:M','Ab:M/C','Db:M','Bb:m7','Eb:7','F:m','Bb:7','Eb:7']
A1m='Eb3:2 Ab3:1 C4:1 Eb4:3 Db4:1 F4:2 Ab4:1 F4:1 Db4:3 C4:1 Bb3:2 G3:1 Bb3:1 C4:2 Ab3:1 F3:1 D4:2 F4:1 Ab4:1 G4:3 r:1'
A2c=['Ab:M','Ab:7/Gb','Db:M/F','Db:m/Fb','Ab:M/Eb','Eb:7','Ab:M','Ab:M']
A2m='Eb3:2 Ab3:1 C4:1 Eb4:2 Gb4:1 Eb4:1 Ab4:3 F4:1 Ab4:2 Fb4:1 Db4:1 C4:2 Eb4:1 Ab3:1 Bb3:2 Db4:1 G3:1 Ab3:4 r:4'
Bc=['F:m','C:7/E','F:m','Bb:m','Db:M','G:hd7','C:7','F:m','Db:M','Bb:m7','Eb:7','Eb:7']
Bm='C4:1 F4:1 Ab4:2 G4:2 E4:1 Bb3:1 Ab4:3 G4:0.5 F4:0.5 F4:2 Db4:1 Bb3:1 Ab4:1.5 Bb4:0.5 Ab4:1 F4:1 Bb4:2 G4:1 F4:1 E4:2 G4:1 Bb4:1 Ab4:2 C5:2 Db5:3 C5:1 Bb4:2 F4:1 Db4:1 Eb4:2 G4:1 Bb4:1 Db4:2 Bb3:1 G3:1'
Cc=['Db:M/Ab','Db:m/Ab','Ab:M','Ab:M']
Cm='F4:4 Fb4:4 Eb4:4 Ab3:4'
Ic=['Ab:M','Ab:M']
plan=[('Intro',Ic,'r:4 r:4',50,False),('A',A1c,A1m,64,False),(None,A2c,A2m,62,False),('B',Bc,Bm,80,False),
      ("A'",A1c,A1m,70,True),(None,A2c,A2m,64,True),('Coda',Cc,Cm,52,False)]
VC=[];L=[];R=[];pccs=[];vccs=[];tempos=[];chords=[];sections=[];bar=0
for sec,chs,m,dv,dbl in plan:
    if sec: sections.append({'name':sec,'startBar':bar+1,'bars':0})
    sn=sections[-1]['name']; sections[-1]['bars']+=len(chs); t0=bar*BAR; n=len(chs)
    for k,c in enumerate(chs):
        chords.append((t0+k*BAR,t0+(k+1)*BAR,c))
        bpm={'B':78}.get(sn,72)-(4 if k==n-1 else 0)
        if sn=='Coda': bpm=[64,58,52,46][k]
        tempos.append((t0+k*BAR,bpm))
    # arch dynamic over each phrase; B peaks at its bar 9
    peak=8.5/12 if sn=='B' else 0.6
    def vel(t,dv=dv,t0=t0,n=n,peak=peak):
        x=(t-t0)/(n*BAR); return int(dv-8+16*(x/peak if x<peak else (1-x)/(1-peak)))
    mn,_=mel(m,t0,U,vel)
    for x in mn:
        x[1]=int(x[1]/0.95*0.98)  # legato bowing
        VC.append(x)
        if dbl: R.append([x[0],int(x[1]*0.9),x[2]+12,min(100,x[3]-14)])
    for k,c in enumerate(chs):
        P,bs=chord(c); tb=t0+k*BAR; bass=36+((bs-36)%12)
        vin=[v[2] for v in VC if tb<=v[0]<tb+BAR]
        lo=min(vin or [60]); hi=max(vin or [55])
        tones=[x for x in range(bass+7,bass+24) if x%12 in P and x<lo-1]
        if len(tones)<3: tones=[x for x in range(bass+7,bass+24) if x%12 in P][:4]
        sel=tones[:4]
        while len(sel)<4: sel.append(sel[-1]+12)
        pat=[bass,sel[0],sel[1],sel[2],sel[3],sel[2],sel[1],sel[0]]
        if sn=='B': pat=[bass,sel[1],sel[3],bass+12,sel[3],sel[1],bass+12,sel[0]]
        lv=dv-32
        if sn=='Coda' and k==3:
            for j,x in enumerate([32,44,51,56,60,63,68,72]): L.append([tb+j*60,BAR*2,x,44-j*2])
        else:
            for j,x in enumerate(pat): L.append([tb+j*U//2,BAR//2 if j==0 else int(U*0.9),x,lv+(10 if j==0 else 0)+((bar+k+j)%3-1)])
        # RH: offbeat chord pulses above the cello (or melody doubling in A')
        rtop=max(hi+3,62); rt=[x for x in range(rtop,rtop+12) if x%12 in P][:3]
        if not (sn=='Coda' and k==3) and sn!='Intro' or (sn=='Intro' and k==1):
            offs=[1,3,5,7] if not dbl else [2,6]
            for o in offs:
                for x in (rt if not dbl else [y for y in rt if y<min([r[2] for r in R if tb<=r[0]<tb+BAR] or [99])-2][:2]):
                    R.append([tb+o*U//2,int(U*(0.45 if not dbl else 0.9)),x,dv-38+(6 if sn=='B' else 0)])
        pccs+=[(64,max(0,tb-10),0),(64,tb+30,100)]
        # cello expression swell per bar
        for j,e in enumerate([92,104,110,100]): vccs.append((11,tb+j*U,e))
    bar+=len(chs)
def clash(l): return any(r[2]==l[2] and r[0]<l[0]+l[1] and l[0]<r[0]+r[1] for r in VC)
for l in L:
    if clash(l): l[2]-=12
L=[l for l in L if not clash(l)]
S={'ts':(4,4),'tempos':tempos,'tracks':[{'name':'Piano','program':0,'notes':L+R,'ccs':pccs,'role':'harmony','pan':58},
   {'name':'Cello','program':42,'notes':VC,'ccs':vccs+[(91,0,60)],'role':'melody','pan':74}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('romance.json','w'))
print('len',to_midi(S,'romance.mid'),'bars',bar,sections)
bad=[]
for t,d,pt,v in VC:
    if t%(2*U)==0 and d>=U*0.9:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,pt,c))
print('NCT',bad)
print('unis',sum(1 for l in L+R for r in VC if r[2]==l[2] and r[0]<l[0]+l[1] and l[0]<r[0]+r[1]))
print('cello range',min(v[2] for v in VC),max(v[2] for v in VC))
print(render('romance.mid','romance.mp3'))
