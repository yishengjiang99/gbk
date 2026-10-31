from lib import *
import math
B=PPQ*4
thc=['D:m','A:7/C#','D:m','F:M','Bb:M','E:hd7','A:7','D:m']
thm='A4:2 D5:1 E5:1 E5:2 C#5:1 A4:1 F5:1.5 E5:.5 D5:1 A4:1 C5:2 F5:1 A5:1 F5:2 D5:1 Bb4:1 Bb4:2 G4:1 D5:1 E5:1 G5:1 E5:1 C#5:1 D5:4'
def parse(s): return [(None if n=='r' else p(n),float(d)) for n,d in (t.split(':') for t in s.split())]
TH=parse(thm)
majc=['D:M','A:7/C#','D:M','F#:m','B:m','E:m7','A:7','D:M']
def tomaj(pt):
    return pt+1 if pt is not None and pt%12 in (5,10,0) and False else pt
def maj(pt):
    m={5:6,10:11,0:1}  # F->F#, Bb->B, C->C#
    return pt+1 if pt%12 in m else pt
SCALE={0,2,4,5,7,9,10,1}
def dimin(mel):
    out=[]
    for k,(pt,d) in enumerate(mel):
        nx=mel[k+1][0] if k+1<len(mel) else pt
        if d>=1 and nx!=pt:
            # 4 sixteenths: note, upper neighbour, note, step toward next, then hold
            up=pt+1 if (pt+1)%12 in SCALE else pt+2
            step=pt+(1 if nx>pt else -1)
            while step%12 not in SCALE: step+= (1 if nx>pt else -1)
            out+= [(pt,.25),(up,.25),(pt,.25),(step,.25)]
            if d>1: out.append((pt,d-1))
        else: out.append((pt,d))
    return out
vars_=[('Theme',thc,TH,'chords',58,80),('Var I',thc,TH,'eighths',62,82),('Var II',thc,dimin(TH),'eighths',66,84),
       ('Var III (Maggiore)',majc,[(maj(pt),d) for pt,d in TH],'arp',54,72),('Var IV (agitato)',thc,TH,'lhmel',78,104),
       ('Var V',thc,TH,'octaves',90,116)]
R=[];L=[];ccs=[];tempos=[];chords=[];sections=[];bar=0
for vi,(nm,chs,mel,sty,bpm,dv) in enumerate(vars_):
    sections.append({'name':nm,'startBar':bar+1,'bars':8})
    t0=bar*B; t=t0
    for k,c in enumerate(chs):
        chords.append((t0+k*B,t0+(k+1)*B,c))
        b_=bpm*(0.9 if k==7 else 1)
        tempos.append((t0+k*B,round(b_)))
    vel=lambda tt: int(dv-10+10*math.sin(math.pi*((tt-t0)%(4*B))/(4*B)))
    for pt,d in mel:
        dur=int(d*PPQ)
        if pt is not None:
            v=vel(t)
            if sty=='lhmel':
                L.append([t,int(dur*.95),pt-24,v-8])
                if pt-12<63: L.append([t,int(dur*.95),pt-12,v])
            else:
                R.append([t,int(dur*.95),pt,v])
                if sty=='octaves': R.append([t,int(dur*.95),pt-12,v-10])
        t+=dur
    for k,c in enumerate(chs):
        P,bs=chord(c); tb=t0+k*B; bass=36+((bs-36)%12)
        if bass>45: bass-=12
        top=min([r[2] for r in R if tb<=r[0]<tb+B] or [74])
        mid=[x for x in range(bass+7,top-2) if x%12 in P]
        sel=[]
        for x in mid:
            if not sel or x-sel[-1]>=3: sel.append(x)
        dvb=dv-18
        if sty=='chords':
            L.append([tb,B-30,bass,dvb+4])
            for j in (1,2,3):
                for x in sel[-3:]: L.append([tb+j*PPQ,PPQ-80,x,dvb-6])
        elif sty in('eighths','arp'):
            pat=[bass]+sel[:3]
            if len(pat)<4: pat+= [pat[-1]]
            seq=(pat+pat[2:0:-1]+[pat[1]]) if sty=='eighths' else pat+[pat[3]+12 if pat[3]+12<top-2 else pat[3]]+pat[3:0:-1]
            seq=(seq*2)[:8]
            for j,x in enumerate(seq): L.append([tb+j*PPQ//2,(B if j==0 else PPQ),x,dvb+(6 if j==0 else 0)])
        elif sty=='lhmel':
            # RH agitated offbeat triplet chords above
            up=sorted([x for x in range(66,82) if x%12 in P])[:3]
            for j in range(12):
                if j%3==0: continue
                for x in up: R.append([tb+j*PPQ//3,PPQ//3-30,x,dv-26])
        elif sty=='octaves':
            for j in range(4):
                L.append([tb+j*PPQ,PPQ-40,bass-12 if bass-12>=26 else bass,dv-14]); L.append([tb+j*PPQ,PPQ-40,bass,dv-14])
                ch=[x for x in range(top-12,top) if x%12 in P]
                if j in(1,3):
                    for x in ch: R.append([tb+j*PPQ,PPQ-60,x,dv-30])
        ccs+=[(64,max(0,tb-10),0),(64,tb+30,100)]
    bar+=8
# coda
cc=['G:m/D','A:7','D:m','Bb:M/D','G:m/D','A:7/D','D:m','D:m']
cm='D5:2 Bb4:1 G4:1 A4:2 G4:1 E4:1 F4:3 r:1 F4:2 D4:1 F4:1 G4:2 Bb4:2 C#5:2 E5:2 D5:4 r:4'
sections.append({'name':'Coda','startBar':bar+1,'bars':8})
t0=bar*B; t=t0
for pt,d in parse(cm):
    if pt: R.append([t,int(d*PPQ*.95),pt+12 if bar>=0 else pt,64-(t-t0)//B*2])
    t+=int(d*PPQ)
for k,c in enumerate(cc):
    P,bs=chord(c); tb=t0+k*B; chords.append((tb,tb+B,c)); tempos.append((tb,[56,54,52,50,48,46,42,38][k]))
    L.append([tb,B-30 if k<7 else B*2,38,54]); 
    sel=[x for x in range(50,70) if x%12 in P][:4]
    for j,x in enumerate(sel if k<7 else [50,57,62,65]): L.append([tb+j*PPQ,(4-j)*PPQ-40 if k<7 else B*2,x,50-k])
    ccs+=[(64,max(0,tb-10),0),(64,tb+30,100)]
S={'ts':(4,4),'tempos':tempos,'tracks':[{'name':'Piano','program':0,'notes':L+R,'ccs':ccs}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('tv.json','w'))
print(to_midi(S,'tv.mid'))
mel=[r for r in R]+[l for l in L if False]
for x in check({'ts':(4,4),'tracks':[{'name':'RH','notes':[r for r in R if r[1]>=PPQ*0.9]}]},chords,['RH']): print(x)
# collisions RH vs LH same pitch
print('unis',sum(1 for l in L for r in R if r[2]==l[2] and r[0]<l[0]+l[1] and l[0]<r[0]+r[1]))
print(render('tv.mid','tv.mp3'))
