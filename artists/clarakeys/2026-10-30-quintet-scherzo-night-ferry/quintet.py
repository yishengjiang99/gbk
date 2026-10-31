from lib import *
import math
BAR=3*PPQ
Sa=(['C:m','C:m','G:7/B','C:m','Ab:M','F:m','G:7','G:7'],'G4:1 C5:1 Eb5:1 G5:2 F5:.5 Eb5:.5 D5:1 F5:1 Ab5:1 G5:2 r:1 C6:1 Ab5:1 Eb5:1 F5:1 Ab5:1 C6:1 B5:1 Ab5:1 F5:1 D5:1 B4:1 G4:1')
Sb=(['F:m','Bb:7','Eb:M','Ab:M','D:hd7/F','G:7','C:m','C:m'],'Ab5:1 C6:1 Ab5:1 D6:2 Ab5:1 G5:1 Bb5:1 Eb6:1 C6:2 Ab5:1 F5:1 Ab5:1 C6:1 F5:1 D5:1 B4:1 C5:2 r:1 r:3')
Saend=(['C:m','C:m','G:7/B','C:m','Ab:M','F:m','G:7','C:m'],'G4:1 C5:1 Eb5:1 G5:2 F5:.5 Eb5:.5 D5:1 F5:1 Ab5:1 G5:2 r:1 C6:1 Ab5:1 Eb5:1 F5:1 Ab5:1 C6:1 B5:1 G5:1 D5:1 C5:2 r:1')
Ta=(['Ab:M','Db:M/Ab','Eb:7/G','Ab:M','F:m','Db:M','Eb:7','Ab:M'],'C5:3 Db5:2 F5:1 Eb5:2 Db5:1 C5:3 Ab5:2 F5:1 F5:2 Db5:1 G4:1 Bb4:1 Db5:1 C5:3')
Tb=(['Bb:m','Eb:7','Ab:M','F:m','Db:M','Bb:7/D','D:hd7/F','G:7'],'Db5:2 F5:1 G5:2 Eb5:1 Ab5:3 C6:2 Ab5:1 F5:2 Ab5:1 D5:2 F5:1 Ab5:2 F5:1 G5:3')
Co=(['C:m','C:m','Ab:M','Ab:M','F:m','G:7','C:m','C:m','Ab:M','F:m','D:hd7','G:7','C:m','C:m','C:m','C:m'],
    'G5:1 C6:1 Eb6:1 G6:3 C6:1 Ab5:1 Eb5:1 C5:3 F5:1 Ab5:1 C6:1 B5:1 D6:1 F6:1 Eb6:3 C6:3 Ab5:1 C6:1 Eb6:1 F6:1 C6:1 Ab5:1 F6:1 D6:1 Ab5:1 G5:1 B5:1 D6:1 C6:1 r:2 C6:1 r:2 C5:1 r:2 C6:1 r:2')
# (phrase, melody instrument, style, dyn, octave shift)
plan=[('Scherzo',Sa,'vn1','drive',82,0),(None,Sa,'pno','drive',88,0),(None,Sb,'vn1','drive',94,0),(None,Saend,'vn1+pno','drive',100,0),
      ('Trio',Ta,'pno','flow',62,0),(None,Ta,'vn1','flow',66,0),(None,Tb,'vc','flow',72,-24),(None,Ta,'va','flow',64,-12),
      ('Scherzo da capo',Sa,'vn1','drive',84,0),(None,Sa,'vc','drive',90,-24),(None,Sb,'vn1','drive',96,0),(None,Saend,'vn1+pno','drive',102,0),
      ('Coda',Co,'vn1+pno','drive',108,0)]
names=['Violin I','Violin II','Viola','Cello','Piano']; prog=[40,40,41,42,0]
TR={n:[] for n in names}; CC={n:[] for n in names}; tempos=[]; chords=[]; sections=[]; bar=0
for sec,(chs,m),who,sty,dv,sh in plan:
    if sec: sections.append({'name':sec,'startBar':bar+1,'bars':0})
    sections[-1]['bars']+=len(chs)
    t0=bar*BAR
    for k,c in enumerate(chs):
        chords.append((t0+k*BAR,t0+(k+1)*BAR,c))
        bpm=144 if sty=='drive' else 126
        if sec=='Coda' or (sections[-1]['name']=='Coda'): bpm=144+min(k,8)
        if sty=='flow' and k==7 and who=='va': bpm=118
        tempos.append((t0+k*BAR,bpm))
    vel=lambda t,dv=dv,t0=t0,n=len(chs): int(dv-6+10*math.sin(math.pi*(t-t0)/(n*BAR)))
    mn,_=mel(m,t0,PPQ,vel)
    if sty=='drive':
        for x in mn: x[1]=int(x[1]*(0.55 if x[1]<PPQ*1.5 else 0.9))  # staccato
    mset=set()
    for tgt in who.split('+'):
        key={'vn1':'Violin I','pno':'Piano','vc':'Cello','va':'Viola'}[tgt]
        for x in mn:
            y=list(x); y[2]+=sh
            if tgt=='pno' and '+' in who: y[2]-=12
            TR[key].append(y)
        mset.add(key)
    tops=lambda tb:[x[2]+sh for x in mn if tb<=x[0]<tb+BAR]
    for k,c in enumerate(chs):
        P,bs=chord(c); tb=t0+k*BAR; bass=36+((bs-36)%12)
        top=min(tops(tb) or [72])
        def pick(lo,hi,prefer):
            cs=[x for x in range(lo,hi) if x%12 in P and x<top-2] or [x for x in range(lo,hi) if x%12 in P]
            return min(cs,key=lambda x:abs(x-prefer))
        if sty=='drive':
            if 'Violin II' not in mset:
                x=pick(60,76,68)
                for j in range(1,6): TR['Violin II'].append([tb+j*PPQ//2,PPQ//2-120,x,dv-22])
            if 'Viola' not in mset:
                x=pick(53,68,60)
                for j in range(1,6): TR['Viola'].append([tb+j*PPQ//2,PPQ//2-120,x,dv-22])
            if 'Cello' not in mset: TR['Cello'].append([tb,PPQ-140,bass,dv-8])
            if 'Piano' not in mset:
                TR['Piano'].append([tb,PPQ-120,bass-12 if bass-12>=24 else bass,dv-10]); TR['Piano'].append([tb,PPQ-120,bass,dv-14])
                ch=sorted([x for x in range(55,72) if x%12 in P and x<top-1])[-3:]
                for j in (1,2):
                    for x in ch: TR['Piano'].append([tb+j*PPQ,PPQ//2,x,dv-24])
        else:
            if 'Cello' not in mset: TR['Cello'].append([tb,BAR-40,bass,dv-14])
            if 'Viola' not in mset: TR['Viola'].append([tb,BAR-40,pick(53,67,60),dv-20])
            if 'Violin II' not in mset: TR['Violin II'].append([tb,BAR-40,pick(62,76,67),dv-20])
            if 'Piano' not in mset:
                tones=[x for x in range(bass+12,bass+40) if x%12 in P][:5]
                pat=[bass]+tones[:2]+[tones[3] if len(tones)>3 else tones[2]+12,tones[2],tones[1]]
                for j,x in enumerate(pat):
                    if j==0 or x<top-1 or top>=72: TR['Piano'].append([tb+j*PPQ//2,BAR if j==0 else PPQ,x,dv-18+(6 if j==0 else 0)])
            else:
                TR['Piano'].append([tb,BAR-20,bass,dv-14])
                ch=sorted([x for x in range(55,70) if x%12 in P and x<top-1])[-2:]
                for x in ch: TR['Piano'].append([tb+PPQ,2*PPQ-40,x,dv-24])
            CC['Piano']+=[(64,max(0,tb-10),0),(64,tb+30,100)]
    bar+=len(chs)
# final chord stab
tb=bar*BAR
for n_,ps in (('Violin I',[84]),('Violin II',[72]),('Viola',[63]),('Cello',[36]),('Piano',[24,36,60,63,67,72])):
    for x in ps: TR[n_].append([tb,PPQ,x,112])
chords.append((tb,tb+BAR,'C:m')); tempos.append((tb,150))
S={'ts':(3,4),'tempos':tempos,'tracks':[{'name':n,'program':prog[i],'notes':TR[n],'ccs':CC[n],'pan':[40,52,72,88,64][i],'role':'melody' if i==0 else 'harmony'} for i,n in enumerate(names)]}
json.dump({'S':S,'chords':chords,'sections':sections},open('quintet.json','w'))
print(to_midi(S,'quintet.mid'))
for x in check(S,chords,['Violin I'])[:12]: print(x)
# parallels vn1 vs cello
att=lambda T:{n[0]:n[2] for n in T['notes']}
a,b=att(S['tracks'][0]),att(S['tracks'][3]); ts=sorted(set(a)&set(b)); bad=[]
for t1,t2 in zip(ts,ts[1:]):
    i1=(a[t1]-b[t1])%12; i2=(a[t2]-b[t2])%12
    if i1==i2 and i1 in(0,7) and a[t1]!=a[t2] and b[t1]!=b[t2] and t2-t1<=BAR: bad.append((t1//BAR+1,i1))
print('parallels',bad)
cel={n[0]:n for n in S['tracks'][3]['notes']}
for t1,t2 in zip(ts,ts[1:]):
    i1=(a[t1]-b[t1])%12; i2=(a[t2]-b[t2])%12
    if i1==i2 and i1 in(0,7) and a[t1]!=a[t2] and b[t1]!=b[t2] and t2-t1<=BAR:
        c=[ch for x0,x1,ch in chords if x0<=t2<x1][0]; P,_=chord(c)
        n=cel[t2]; n[2]=min([x for x in range(36,56) if x%12 in P and (a[t2]-x)%12 not in (0,7)],key=lambda x:abs(x-n[2])); b[t2]=n[2]
print('fixed; recheck',[ (t1//BAR+1) for t1,t2 in zip(ts,ts[1:]) if (a[t1]-b[t1])%12==(a[t2]-b[t2])%12 and (a[t1]-b[t1])%12 in (0,7) and a[t1]!=a[t2] and b[t1]!=b[t2] and t2-t1<=BAR])
print(to_midi(S,'quintet.mid')); json.dump({'S':S,'chords':chords,'sections':sections},open('quintet.json','w'))
print(render('quintet.mid','quintet.mp3'))
