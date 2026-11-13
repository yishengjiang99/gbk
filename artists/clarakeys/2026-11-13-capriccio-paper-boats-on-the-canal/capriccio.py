# Capriccio in A-flat Major for flute and piano, "Paper Boats on the Canal" (Clara Keys). 2/4, ABA' with coda.
from lib import *
import sys, json
E=PPQ//2; BAR=2*PPQ
A1=[('Ab:M',"Eb5:0.5 F5:0.5 Eb5:0.5 C5:0.5 Ab5:1 Eb5:1"),('Eb:7/G',"Db5:0.5 Eb5:0.5 Db5:0.5 Bb4:0.5 G5:1 Db5:1"),
 ('Ab:M',"C5:0.5 Eb5:0.5 Ab5:0.5 C6:0.5 Bb5:1 Ab5:1"),('Db:M',"F5:1.5 Ab5:0.5 Db6:1 C6:0.5 Bb5:0.5"),
 ('F:m',"Ab5:0.5 G5:0.5 F5:0.5 C5:0.5 F5:1 Ab5:1"),('Bb:7/D',"Ab5:0.5 F5:0.5 D5:0.5 Bb4:0.5 C5:0.5 D5:0.5 F5:1"),
 ('Eb:M',"Eb5:1 G5:0.5 Bb5:0.5 Eb6:1 D6:0.5 C6:0.5"),('Eb:7',"Bb5:2 Db6:0.5 C6:0.5 Bb5:0.5 G5:0.5")]
A2=A1[:4]+[('Db:M',"Db6:1 C6:0.5 Bb5:0.5 Ab5:1 F5:1"),('Ab:M/Eb',"Eb5:1 Ab5:0.5 C6:0.5 Eb6:1 C6:1"),
 ('Eb:7',"Bb5:0.5 C6:0.5 Bb5:0.5 G5:0.5 Eb5:0.5 F5:0.5 G5:0.5 Bb5:0.5"),('Ab:M',"Ab5:2 r:2")]
A=A1+A2
B=[('F:m',"C5:1 F5:3"),('C:7/E',"E5:1.5 F5:0.5 G5:1 Bb5:1"),('F:m',"Ab5:3 G5:0.5 F5:0.5"),('Eb:7',"G5:2 Eb5:2"),
 ('Ab:M',"C6:3 Bb5:0.5 Ab5:0.5"),('Db:M',"F5:2 Ab5:1 Db6:1"),('G:hd7',"Db6:1.5 C6:0.5 Bb5:1 G5:1"),('C:7',"E5:3 C5:1"),
 ('F:m',"F5:1 Ab5:1 C6:2"),('Bb:m',"Db6:1.5 C6:0.5 Bb5:1 F5:1"),('Eb:7',"G5:2 Bb5:1 Db6:1"),('Ab:M',"C6:3 Ab5:1"),
 ('Db:M',"F6:1.5 Eb6:0.5 Db6:1 Ab5:1"),('G:hd7/Db',"Bb5:1 Db6:1 F5:1 G5:1"),('C:7',"E5:2 G5:1 Bb5:1"),('F:m',"F5:2 C5:1 Ab4:1")]
RT=[('Eb:7',"Bb4:0.5 C5:0.5 Db5:0.5 Eb5:0.5 F5:0.5 G5:0.5 Ab5:0.5 Bb5:0.5"),('Eb:7',"C6:0.5 Db6:0.5 Eb6:0.5 F6:0.5 G6:0.5 Ab6:0.5 G6:0.5 F6:0.5"),
 ('Eb:7',"Eb6:1 Db6:1 Bb5:1 G5:1"),('Eb:7',"Eb5:2 r:2")]
CO=[('Db:M/Ab',"Ab5:1 F5:1 Db6:1 Ab5:1"),('Ab:M',"C6:1 Ab5:1 Eb6:1 C6:1"),('Db:M/Ab',"F6:1 Db6:1 Ab5:1 F5:1"),('Ab:M',"Eb5:1 Ab5:1 C6:1 Eb6:1"),
 ('Bb:m7',"Db6:0.5 C6:0.5 Bb5:0.5 F5:0.5 Ab5:1 Bb5:1"),('Eb:7',"G5:0.5 Ab5:0.5 Bb5:0.5 Db6:0.5 Eb6:1 G6:1"),('Ab:M',"Ab6:2 Eb6:0.5 C6:0.5 Ab5:0.5 Eb5:0.5"),('Ab:M',"Ab5:1 r:3")]
INTRO=[('Ab:M',"r:4"),('Eb:7/G',"r:4"),('Ab:M',"r:4"),('Eb:7',"r:4")]
#     name, bars, flute role, piano style, dyn(start,end), tempo
plan=[('Intro',INTRO,'rest','oompah',(64,68),104),
 ('A: flute theme',A,'mel','oompah',(56,66),104),
 ('A repeat: piano theme, flute descant',A,'descant','pmel',(54,64),102),
 ('B: F minor, cantabile',B,'mel','arp',(52,70),88),
 ('B repeat: piano sings, flute answers',B,'under','parp',(58,74),86),
 ('Retransition',RT,'mel','pedal',(60,78),96),
 ('A return',A,'mel','oompah2',(62,74),106),
 ('Coda',CO,'mel','oompah2',(66,82),104)]
F=[];PM=[];PN=[];tempos=[];chords=[];sections=[];bar=0
ccF=[(91,0,40)];ccP=[(91,0,40)]
for si,(name,M,role,sty,dyn,bpm) in enumerate(plan):
    n=len(M); t0=bar*BAR; sections.append({'name':name,'startBar':bar+1,'bars':n})
    vb=[dyn[0]+(dyn[1]-dyn[0])*k/max(1,n-1) for k in range(n)]
    for k in range(n):
        b=bpm
        if k%8==7: b=bpm-8
        if k%8==6: b=bpm-3
        if name=='Retransition': b=[92,96,100,94][k]
        if name=='Coda': b=[104,104,104,104,100,96,90,84][k]
        if name.startswith('B') and k==n-1: b=bpm-10
        tempos.append((t0+k*BAR,b)); chords.append((t0+k*BAR,t0+(k+1)*BAR,M[k][0]))
    def vel(t,t0=t0,vb=vb,n=n):
        k=min((t-t0)//BAR,n-1); x=((t-t0)%(4*BAR))/(4*BAR); a=x/0.6 if x<0.6 else (1-x)/0.4
        return int(vb[k]+16+10*a+(4 if (t-t0)%BAR==0 else 0))
    mel_notes=[]
    for k,(c,txt) in enumerate(M):
        ns,te=mel(txt,t0+k*BAR,E,vel); assert te==t0+(k+1)*BAR,(name,k)
        mel_notes+=ns
    for x in mel_notes: x[1]=int(x[1]/0.95*(0.97 if sty in('arp','parp') else 0.86))
    if role=='mel': F+= mel_notes
    elif role in('descant','under'):
        pm=[[a,b,c-(12 if role=='descant' else 0),d+8] for a,b,c,d in mel_notes]; PM+=pm
        prev=84 if role=='descant' else 74
        for k,(c,_) in enumerate(M):
            P,_=chord(c); t=t0+k*BAR
            if role=='descant':
                cand=[x for x in tones(P,76,91)] if 'tones' in dir() else None
            cand=[x for x in range(76 if role=='descant' else 62,92 if role=='descant' else 80) if x%12 in P]
            if role=='under':
                top=min([x[2] for x in pm if t<=x[0]<t+BAR])
                cand=[x for x in cand if x<=top-3] or [min(cand)]
            v=prev+(1 if k%4==3 else 0)
            nt=min(cand,key=lambda x:abs(x-prev)+(0 if k%2 else 0.1*x))
            if k%4==3 and role=='descant':  # little turn into next phrase
                up=[x for x in cand if x>nt][:2]
                F+=[[t,PPQ,nt,int(vb[k])],[t+PPQ,E,(up or [nt])[0],int(vb[k])-2],[t+PPQ+E,E,nt,int(vb[k])-4]]
            else: F.append([t,int(BAR*0.97),nt,int(vb[k])+2])
            prev=nt
    # flute expression swell per 4 bars
    for k in range(n*4):
        t=t0+k*BAR//4; x=(k%16)/16; ccF.append((11,t,int(90+30*(x/0.6 if x<0.6 else (1-x)/0.4))))
    for k,(c,_) in enumerate(M):
        t=t0+k*BAR; P,bs=chord(c); lv=int(vb[k])
        g=[x for x in range(36,48) if x%12==bs][0]
        fifth=[x for x in range(g-7,g+8) if x%12==P[2] and x!=g]
        f2=min(fifth,key=lambda x:abs(x-g-4)) if fifth else g
        mtop=[x[2] for x in (PM if role in('descant','under') else F) if t<=x[0]<t+BAR]
        top=(min(mtop) if mtop else 80)-2
        ccP+=[(64,max(0,t-10),0),(64,t+30,90)] if sty in('arp','parp','pedal') else []
        if sty in('oompah','oompah2','pmel'):
            PN.append([t,int(E*1.6),g,lv+4]); PN.append([t+PPQ,int(E*1.6),f2,lv])
            if sty=='oompah2': PN.append([t,int(E*1.6),g-12 if g-12>=28 else g+12,lv-2])
            lo,hi=(53,69) if sty!='pmel' else (50,64)
            rh=[x for x in range(lo,hi) if x%12 in P and x<top][-3:]
            for j in (1,3): PN+=[[t+j*E,int(E*0.55),x,lv-6-(j==3)*3] for x in rh]
        elif sty in('arp','parp'):
            PN.append([t,int(BAR*0.98),g,lv+2]); PN.append([t,int(BAR*0.98),g+12 if g+12<52 else g-12,lv-6])
            tl=[x for x in range(g+7,g+28) if x%12 in P and x<top-1][:5]
            seq=(tl+tl[-2:0:-1])
            S16=E//2
            for i in range(1,8): PN.append([t+i*S16,BAR-i*S16,seq[i%len(seq)],lv-10-(i%2)*4])
        elif sty=='pedal':
            PN.append([t,int(BAR*0.98),39,lv+4]); PN.append([t,int(BAR*0.98),27+12*0+12,lv-4]) if False else None
            rh=[x for x in range(55,68) if x%12 in P][-3:]
            for j in range(8): PN+=[[t+j*E//2,E//2-20,x,lv-14+j] for x in (rh[0::2] if j%2==0 else rh[1:2])]
    bar+=n
ccP+=[(64,bar*BAR+PPQ,0)]
for nn in PN:
    if any(nn[2]==x[2] and x[0]<nn[0]+nn[1] and nn[0]<x[0]+x[1] for x in PM+F): nn[2]-=12
PN=sorted({(a,c):[a,b,c,d] for a,b,c,d in sorted(PN,key=lambda q:q[3])}.values())
last={}
for nn in sorted(PN,key=lambda q:(q[2],q[0])):
    q=last.get(nn[2])
    if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
    last[nn[2]]=nn
S={'ts':(2,4),'tempos':tempos,'tracks':[
   {'name':'Flute','program':73,'notes':sorted(F),'ccs':ccF,'role':'melody','pan':56},
   {'name':'Piano RH melody','program':0,'notes':sorted(PM),'ccs':ccP,'role':'melody','pan':72},
   {'name':'Piano','program':0,'notes':sorted(PN),'ccs':ccP,'role':'accompaniment','pan':72}]}
json.dump({'S':S,'chords':chords,'sections':sections},open('capriccio.json','w'))
print('len %.1fs bars %d'%(to_midi(S,'capriccio.mid'),bar))
bad=[]
for nmT,T in (('F',F),('PM',PM)):
    for t,d,pt,v in T:
        if t%PPQ==0 and d>=E*1.5:
            c=[c for a,b,c in chords if a<=t<b][0]; P,_=chord(c)
            if pt%12 not in P: bad.append((nmT,t//BAR+1,pt,c))
print('strong-beat NCT',bad)
for T in S['tracks']:
    ps=[x[2] for x in T['notes']]; print(T['name'],len(ps),min(ps),max(ps),'vel',min(x[3] for x in T['notes']),max(x[3] for x in T['notes']))
if '--render' in sys.argv: print(render('capriccio.mid','capriccio.mp3'))
