# Shared builder for today's drafts: melody (solo instrument or piano RH) + piano LH/inner voices.
from lib import *
import json, sys
def build(plan, ts, solo=None, out='d', agogic=None):
    """plan: [(name, [(chord, mel)], (v0,v1), bpm, lh, rit)]; solo: None or (name, program)"""
    Qn=PPQ; BAR=Qn*ts[0]*4//ts[1]; beats=ts[0] if ts[1]==4 else ts[0]//3
    bl=BAR//beats
    M=[];PN=[];tempos=[];chords=[];sections=[];bar=0
    ccM=[(91,0,40)];ccP=[(91,0,42)]
    for name,bars,dyn,bpm,lh,rit in plan:
        n=len(bars); t0=bar*BAR; sections.append({'name':name,'startBar':bar+1,'bars':n})
        for k,(c,txt) in enumerate(bars):
            t=t0+k*BAR; x=k/max(1,n-1)
            lv=int(dyn[0]+(dyn[1]-dyn[0])*x)
            b=bpm-(rit*(k-n+3) if k>=n-2 else 0)
            if agogic:
                for j,f in enumerate(agogic): tempos.append((t+j*bl,round(b*f,1)))
            else: tempos.append((t,b))
            chords.append((t,t+BAR,c))
            ph=((k%4)*BAR)/(4*BAR)  # 4-bar arch
            arch=lambda tt,lv=lv,t=t: int(lv+10+12*(lambda y: y/0.6 if y<0.6 else (1-y)/0.4)((((tt-t0)%(4*BAR))/(4*BAR))))
            ns,te=mel(txt,t,Qn,arch); assert te==t+BAR,(name,k,te-t)
            if solo:
                for q in ns: q[1]=int(q[1]/0.95*0.97)
                M.extend(ns); ccM+=[(11,t,min(127,72+lv//3)),(11,t+BAR//2,min(127,84+lv//3)),(11,t+BAR-60,min(127,74+lv//3))]
            else:
                M.extend(ns)
            P,bs=chord(c)
            g=[y for y in range(36,48) if y%12==bs][0]
            mt=[q[2] for q in ns]; top=(min(mt)-3) if mt else 72
            ccP+=[(64,max(0,t-10),0),(64,t+30,100)]
            if lh=='end':
                PN.append([t,BAR*2,g-12,lv]); PN.append([t,BAR*2,g,lv-4])
                arp=[y for y in range(50,min(top,79)+1) if y%12 in P]
                for i,y in enumerate(arp): PN.append([t+i*80,BAR*2-i*80,y,lv-8+i])
                continue
            tones=[y for y in range(50,min(top,72)+1) if y%12 in P][-3:]
            if len(tones)<3: tones=[y for y in range(46,62) if y%12 in P][-3:]
            if lh=='maz':   # bass on 1, chord on 2 (accented) and 3
                PN.append([t,bl-30,g,lv+2])
                for j,a in ((1,6),(2,-4)):
                    for y in tones: PN.append([t+j*bl,int(bl*0.7),y,lv-12+a])
            elif lh=='maz2':  # fuller: bass octave on 1, accented chord on 2, light staccato 3
                PN.append([t,bl-30,g,lv+4]); PN.append([t,bl-30,g-12 if g>=40 else g+12,lv-2])
                for y in tones: PN.append([t+bl,int(bl*0.8),y,lv-4])
                for y in tones[1:]: PN.append([t+2*bl,int(bl*0.4),y,lv-18])
            elif lh=='arp16':  # sixteenth arpeggio over two octaves, up then down
                fig=[g]+[y for y in range(g+1,g+26) if y%12 in P][:4]
                fig=fig+fig[-2:0:-1]
                for j in range(BAR//(Qn//4)):
                    y=fig[j%len(fig)]
                    PN.append([t+j*Qn//4,int(Qn/4*2.2),y,lv-14+(8 if j%8==0 else 0)])
            elif lh=='broken8':
                PN.append([t,BAR-40,g,lv+2])
                pat=[0,1,2,1,0,1,2,1]
                for j in range(1,BAR//(Qn//2)):
                    PN.append([t+j*Qn//2,int(Qn/2*1.6),tones[pat[j%8]],lv-14+(2 if j%2==0 else 0)])
            elif lh=='chorale':
                PN.append([t,BAR-30,g,lv]); PN.append([t,BAR-30,g-12 if g>=40 else g+12,lv-6])
                for y in tones: PN.append([t+Qn//4,BAR-Qn//4-30,y,lv-12])
            if not solo:  # inner voice under strong-beat melody notes
                for q in ns:
                    if (q[0]-t)%bl==0 and q[1]>=Qn*0.9:
                        under=[y for y in range(q[2]-9,q[2]-2) if y%12 in P and y>tones[-1]]
                        for y in under[-1:]: PN.append([q[0]+15,q[1]-30,y,q[3]-22])
        bar+=n
    ccP+=[(64,bar*BAR+BAR,0)]
    for arr in (PN,M):
        last={}
        for nn in sorted(arr,key=lambda q:(q[2],q[0])):
            q=last.get(nn[2])
            if q and nn[0]<q[0]+q[1]: q[1]=max(30,nn[0]-q[0]-10)
            last[nn[2]]=nn
    if solo:
        tr=[{'name':solo[0],'program':solo[1],'notes':sorted(M),'ccs':ccM,'role':'melody','pan':54},
            {'name':'Piano','program':0,'notes':sorted(PN),'ccs':ccP,'role':'accompaniment','pan':70}]
    else:
        tr=[{'name':'Piano','program':0,'notes':sorted(M+PN),'ccs':ccP,'role':'melody','pan':64}]
    tm={};[tm.__setitem__(a,b) for a,b in tempos]
    S={'ts':tuple(ts),'tempos':sorted(tm.items()),'tracks':tr}
    json.dump({'S':S,'chords':chords,'sections':sections},open(out+'.json','w'))
    L=to_midi(S,out+'.mid'); print(out,'len %.1fs bars %d'%(L,bar))
    for r in check(S,chords,[solo[0] if solo else 'Piano']):
        if 'NCT' in r and not solo: continue
        print(r)
    if solo is None:  # NCT check on melody only
        T={'name':'Mel','notes':M}; S2=dict(S,tracks=[T])
        for r in check(S2,chords,['Mel'])[1:]: print(r)
    print(render(out+'.mid',out+'.mp3'))
