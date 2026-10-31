from lib import *
import math
U=PPQ//2; BAR=6*U
SC=[6,8,10,11,1,3,5]  # F# major pcs
P1c=['F#:M','C#:7/E#','F#:M','B:M','G#:m7','D#:m','G#:7','C#:7']
P1m='C#5:3 A#4:2 C#5:1 E#5:3 D#5:2 C#5:1 A#4:2 C#5:1 F#5:3 F#5:2 D#5:1 B4:3 B4:2 D#5:1 G#5:3 F#5:3 D#5:2 C#5:1 B#4:3 D#5:2 F#5:1 E#5:3 r:3'
P2c=['F#:M','C#:7/E#','D#:m','B:M','G#:m7','C#:7','F#:M','F#:M']
P2m='C#5:3 A#4:2 C#5:1 E#5:3 G#5:2 B5:1 A#5:3 F#5:2 D#5:1 F#5:3 D#5:2 B4:1 D#5:3 F#5:2 G#5:1 C#5:3 B4:3 A#4:6 r:6'
B1c=['D#:m','A#:7','D#:m','G#:m','E:M','A#:7','D#:m','C#:7']
B1m='A#5:2 G#5:1 F#5:2 D#5:1 G#5:3 E#5:2 D5:1 D#5:3 F#5:2 A#5:1 B5:3 A#5:2 G#5:1 G#5:2 B5:1 E6:3 D6:3 A#5:2 G#5:1 F#5:3 D#5:3 E#5:3 G#5:3'
B2c=['B:M','F#:M/A#','G#:m','D#:m/F#','E:M','E:M7','C#:7','C#:7']
B2m='D#6:3 C#6:2 B5:1 C#6:3 A#5:2 F#5:1 B5:3 G#5:2 D#5:1 F#5:3 D#5:2 A#4:1 G#5:3 E5:2 B4:1 D#5:3 G#5:3 E#5:3 G#5:2 B5:1 E#5:3 C#5:3'
Coc=['F#:M','B:M/F#','B:m/F#','F#:M','F#:M','F#:M']
Com='A#5:6 B5:3 D#5:3 D5:3 B4:3 A#4:6 r:6 r:6'
Ic=['F#:M','F#:M']; Im='r:6 r:6'
plan=[('Intro',Ic,Im,None,40),('A',P1c,P1m,None,56),(None,P2c,P2m,'3rd',60),('B',B1c,B1m,None,70),(None,B2c,B2m,'6th',80),
      ("A'",P1c,P1m,'6th',62),(None,P2c,P2m,'3rd',58),('Coda',Coc,Com,'3rd',46)]
def below(pt,steps):
    # diatonic interval below in F# major (steps=2 -> third, 5 -> sixth)
    pcs=sorted(set(SC)); 
    cands=[x for x in range(pt-11,pt) if x%12 in SC]
    return cands[-steps] if len(cands)>=steps else None
R=[];L=[];ccs=[];tempos=[];chords=[];sections=[];bar=0
for sec,chs,m,dbl,dv in plan:
    if sec: sections.append({'name':sec,'startBar':bar+1,'bars':0})
    sections[-1]['bars']+=len(chs); t0=bar*BAR
    for k,c in enumerate(chs):
        chords.append((t0+k*BAR,t0+(k+1)*BAR,c))
        bpm=75+(3 if sections[-1]['name']=='B' else 0)-(5 if k==len(chs)-1 else 0)
        if sections[-1]['name']=='Coda': bpm=[70,66,62,58,52,46][k]
        tempos.append((t0+k*BAR,bpm))
    vel=lambda t,dv=dv,t0=t0,n=len(chs): int(dv-6+12*math.sin(math.pi*(t-t0)/(n*BAR)))
    mn,_=mel(m,t0,U,vel)
    for x in mn:
        R.append(x)
        if dbl and x[1]>=U*1.8:
            y=below(x[2],2 if dbl=='3rd' else 5)
            # keep doubling consonant with chord
            P,_=chord([c for a,b,c in chords if a<=x[0]<b][-1])
            if y and y%12 in P: R.append([x[0],x[1],y,x[3]-12])
    for k,c in enumerate(chs):
        P,bs=chord(c); tb=t0+k*BAR; bass=34+((bs-34)%12)
        top=min([r[2] for r in R if tb<=r[0]<tb+BAR] or [70])
        tones=[x for x in range(bass+7,bass+30) if x%12 in P and x<top-3]
        sel=[]
        for x in tones:
            if not sel or x-sel[-1]>=3: sel.append(x)
        while len(sel)<3: sel.append(sel[-1]+12 if sel else bass+12)
        # rocking barcarolle LH: low bass, then up and back
        pat=[bass,sel[0],sel[1],sel[2],sel[1],sel[0]]
        if sections[-1]['name']=='B': pat=[bass,sel[1],sel[2],bass+12,sel[2],sel[1]]
        last=(sections[-1]['name']=='Coda' and k>=4)
        if last and k==5:
            for j,x in enumerate([30,42,49,54,58,61,66,70]): L.append([tb+j*50,BAR*2,x,40-j])
        else:
            for j,x in enumerate(pat):
                L.append([tb+j*U,(BAR if j==0 else int(U*1.5)),x,dv-18+(8 if j==0 else 2 if j==3 else 0)+((bar+k+j)%3-1)])
        ccs+=[(64,max(0,tb-10),0),(64,tb+30,100)]
    bar+=len(chs)
S={'ts':(6,8),'tempos':tempos,'tracks':[{'name':'Piano','program':0,'notes':L+R,'ccs':ccs}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('barc.json','w'))
print(to_midi(S,'barc.mid'))
# strong beats in 6/8 = every 3 eighths
bad=[]
for t,d,pt,v in R:
    if t%(3*U)==0 and d>=U*1.8:
        c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
        if pt%12 not in P: bad.append((t//BAR+1,pt,c))
print('NCT',bad)
print('unis',sum(1 for l in L for r in R if r[2]==l[2] and r[0]<l[0]+l[1] and l[0]<r[0]+r[1]))
print(render('barc.mid','barc.mp3'))
