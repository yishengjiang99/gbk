from lib import *
import math
Q3=PPQ; BAR=3*PPQ
a1c=['Bb:M','Bb:M/D','Eb:M','F:7','G:m/Bb','Eb:M','C:7/E','F:M']
a1m='D5:2 Eb5:1 F5:2 D5:1 G5:1.5 F5:.5 Eb5:1 C5:2 Eb5:1 D5:2 Bb4:1 G5:2 Eb5:1 E5:1 G5:1 Bb5:1 A5:2 r:1'
a2c=['Bb:M','Bb:7/D','Eb:M','Eb:m/Gb','Bb:M/F','F:7','Bb:M','Bb:M']
a2m='D5:2 Eb5:1 F5:1 Ab5:1 Bb5:1 G5:2 F5:.5 Eb5:.5 Gb5:2 Eb5:1 D5:1.5 C5:.5 Bb4:1 C5:1 Eb5:1 A4:1 Bb4:3 r:3'
b1c=['G:m','D:7/F#','G:m','C:m/Eb','Eb:M','A:hd7','D:7','D:7']
b1m='D4:2 C4:.5 Bb3:.5 A3:2 F#3:1 G3:1 Bb3:1 D4:1 Eb4:2 G4:1 G4:1.5 F4:.5 Eb4:1 C4:2 A3:1 F#3:1 A3:1 C4:1 D4:3'
b2c=['Eb:M','Ab:M','G:m/D','D:7','G:m','Eb:M','C:m7','F:7']
b2m='G5:2 Bb5:1 Ab5:2 C6:1 Bb5:1 G5:1 D5:1 C5:1 A4:1 F#4:1 Bb4:1 D5:1 G5:1 G5:2 Eb5:1 Eb5:1 C5:1 Bb4:1 A4:1 C5:1 Eb5:1'
cc_=['Bb:M','Eb:M/Bb','Eb:m/Bb','Bb:M','Eb:M','F:7','Bb:M','Bb:M']
cm='D5:2 Eb5:1 G5:3 Gb5:3 F5:3 G5:2 Eb5:1 C5:2 A4:1 Bb4:3 Bb4:3'
plan=[('A1',a1c,a1m,'vn'),('A2',a2c,a2m,'vn'),('B1',b1c,b1m,'vc'),('B2',b2c,b2m,'vn'),
      ('A1r',a1c,a1m,'vn'),('A2r',a2c,a2m,'vc-'),('Coda',cc_,cm,'vn')]
vn=[];vc=[];pr=[];vncc=[];vccc=[];pcc=[];tempos=[];chords=[]
def counter(mnotes, chs, t0, lo, hi, offset, vel):
    out=[];prev=None
    for t,d,m,v in mnotes:
        if d< Q3*0.9: continue
        P,_=chord(chs[(t-t0)//BAR])
        c=[x for x in range(lo,hi) if x%12 in P]
        tgt=m+offset
        x=min(c,key=lambda x:abs(x-tgt)+(2 if x==prev else 0)+ (3 if prev is not None and abs(x-prev)>7 else 0)); prev=x
        out.append([t,d,x,vel])
    return out
bar=0
dynsec={'A1':60,'A2':66,'B1':74,'B2':86,'A1r':64,'A2r':70,'Coda':50}
for name,chs,m,who in plan:
    t0=bar*BAR; dv=dynsec[name]
    for k,c in enumerate(chs):
        chords.append((t0+k*BAR,t0+(k+1)*BAR,c))
        bpm=66 if name not in('B1','B2') else 70
        if k==7: bpm-=6
        if name=='Coda': bpm=[64,62,60,58,56,52,48,42][k]
        tempos.append((t0+k*BAR,bpm))
    vel=lambda t,dv=dv,t0=t0: int(dv+10*math.sin(math.pi*min(1,(t-t0)/(8*BAR))))
    shift=-24 if who=='vc-' else 0
    mn,_=mel(m,t0,Q3,vel)
    for x in mn: x[2]+=shift
    if who in('vn',):
        vn+=mn
        if name in('A2','A1r','B2','Coda'): vc+=counter(mn,chs,t0,48,64,-15 if name!='B2' else -19,dv-6)
        else: vc+=[[t0+k*BAR,BAR-20,36+((chord(c)[1]-36)%12),dv-6] for k,c in enumerate(chs)]
        if name=='B2': pass
    elif who=='vc':
        vc+=mn; vn+=counter(mn,chs,t0,67,84,+16,dv-8)
    else: # vc- : cello melody 2 oct down, violin descant
        vc+=[x for x in mn]; 
        for x in vc[-len(mn):]: x[2]+=12  # back to cello octave (one oct down from violin)
        ds=counter([[t0+k*BAR,BAR,79,0] for k in range(8)],chs,t0,74,86,0,dv-10)
        cel={x[0]:x[2] for x in vc}
        for x in ds:
            if x[0] in cel and cel[x[0]]%12==x[2]%12:
                P,_=chord(chs[(x[0]-t0)//BAR]); x[2]=min([y for y in range(74,86) if y%12 in P and y%12!=x[2]%12],key=lambda y:abs(y-x[2]))
        vn+=ds
    # piano
    for k,c in enumerate(chs):
        P,bs=chord(c); tb=t0+k*BAR; bass=36+((bs-36)%12)
        top=min([x[2] for x in vn+vc if tb<=x[0]<tb+BAR and x in mn] or [72])
        if name in('B1','B2','A2r'):
            tones=[x for x in range(bass+7,bass+28) if x%12 in P][:5]
            pat=[bass]+tones[:3]+[tones[3] if len(tones)>3 else tones[2]+12,tones[2]]
            if name=='B1': pat=[bass+12]+tones[:3]+[tones[3] if len(tones)>3 else tones[2]+12,tones[2]]
            for j,x in enumerate(pat): pr.append([tb+j*PPQ//2,PPQ if j else BAR,x,dv-16+(6 if j==0 else 0)])
        else:
            if name!='Coda' or k<7:
                pr.append([tb,BAR-20,bass,dv-10]); pr.append([tb,BAR-20,bass+12,dv-16])
            ch=sorted([x for x in range(56,71) if x%12 in P])[-3:]
            ch=[x for x in ch if x<top-2] or ch[:2]
            for b_ in (1,2):
                if name=='Coda' and k>=6: break
                for x in ch: pr.append([tb+b_*PPQ,PPQ-60,x,dv-20])
            if name=='Coda' and k==6:
                for j,x in enumerate([46,58,62,65,70]): pr.append([tb+j*40,2*BAR,x,44-j])
        pcc+=[(64,max(0,tb-10),0),(64,tb+30,100)]
    # string expression swells per 4-bar phrase
    for k in range(8):
        for tr in (vncc,vccc):
            for j in range(6):
                ph=((k%4)*6+j)/24
                tr.append((11,t0+k*BAR+j*PPQ//2,int(86+30*math.sin(math.pi*ph)) if name!='Coda' else int(90-k*5)))
    bar+=8
S={'ts':(3,4),'tempos':tempos,'tracks':[
 {'name':'Violin','program':40,'notes':vn,'ccs':vncc,'pan':44},
 {'name':'Cello','program':42,'notes':vc,'ccs':vccc,'pan':84},
 {'name':'Piano','program':0,'notes':pr,'ccs':pcc,'pan':64,'role':'harmony'}]}
json.dump({'S':S,'chords':chords},open('trio.json','w'))
print(to_midi(S,'trio.mid'))
for x in check(S,chords,['Violin','Cello']): print(x)
# parallel 8ve/5th check between violin & cello on simultaneous attacks
att=lambda T:{n[0]:n[2] for n in T['notes']}
a,b=att(S['tracks'][0]),att(S['tracks'][1]); ts=sorted(set(a)&set(b)); bad=[]
for t1,t2 in zip(ts,ts[1:]):
    i1=(a[t1]-b[t1])%12; i2=(a[t2]-b[t2])%12
    if i1==i2 and i1 in(0,7) and a[t1]!=a[t2] and b[t1]!=b[t2]: bad.append((t1//BAR+1,i1))
print('parallels',bad)
print(render('trio.mid','trio.mp3'))
