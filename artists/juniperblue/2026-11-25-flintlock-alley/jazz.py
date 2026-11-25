# Juniper Blue jazz engine: 4/4 swing helpers (walking bass, rootless comping, ride kit, bebop solo lines).
import random,json,re
Q=480;BAR=4*Q
PC={'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'Cb':11}
CT={'maj7':[0,4,7,11],'6':[0,4,7,9],'m7':[0,3,7,10],'m6':[0,3,7,9],'7':[0,4,7,10],'13':[0,4,7,10],'7#11':[0,4,7,10],
    'm7b5':[0,3,6,10],'7alt':[0,4,10,1+12,3+12,8+12],'7b9':[0,4,7,10],'mM7':[0,3,7,11],'maj7#11':[0,4,7,11],'dim7':[0,3,6,9],'m9':[0,3,7,10]}
TEN={'maj7':[2],'6':[2],'m7':[2,5],'m6':[2],'7':[2],'13':[2,9],'7#11':[2,6],'m7b5':[5],'7alt':[],'7b9':[1],'mM7':[2],'maj7#11':[2,6],'dim7':[2],'m9':[2]}
SC={'maj7':[0,2,4,7,9,11,5],'6':[0,2,4,5,7,9,11],'m7':[0,2,3,5,7,9,10],'m6':[0,2,3,5,7,9,11],'7':[0,2,4,5,7,9,10],'13':[0,2,4,5,7,9,10],
    '7#11':[0,2,4,6,7,9,10],'m7b5':[0,1,3,5,6,8,10],'7alt':[0,1,3,4,6,8,10],'7b9':[0,1,3,4,7,9,10],'mM7':[0,2,3,5,7,9,11],
    'maj7#11':[0,2,4,6,7,9,11],'dim7':[0,2,3,5,6,8,9,11],'m9':[0,2,3,5,7,9,10]}
VA={'maj7':[4,7,11,14],'6':[4,7,9,14],'m7':[3,7,10,14],'m9':[3,7,10,14],'m6':[3,7,9,14],'7':[4,9,10,14],'13':[4,9,10,14],'7#11':[4,6,10,14],
    'm7b5':[3,6,10,12],'7alt':[4,8,10,15],'7b9':[4,9,10,13],'mM7':[3,7,11,14],'maj7#11':[4,6,11,14],'dim7':[3,6,9,12]}
VB={'maj7':[11,14,16,19],'6':[9,14,16,19],'m7':[10,14,15,19],'m9':[10,14,15,19],'m6':[9,14,15,19],'7':[10,14,16,21],'13':[10,14,16,21],'7#11':[10,14,16,18],
    'm7b5':[10,12,15,18],'7alt':[10,15,16,20],'7b9':[10,13,16,21],'mM7':[11,14,15,19],'maj7#11':[11,14,16,18],'dim7':[9,12,15,18]}
def ch(s):
  m=re.match(r'([A-G][b#]?)(.*)',s); return (PC[m.group(1)],m.group(2) or 'maj7')
def chart(s):
  "'Gm7 | Dm7b5 G7alt | ...' -> list of bars, each list of (root,qual)"
  out=[]
  for b in s.split('|'):
    b=b.strip()
    if not b: continue
    toks=b.split(); n=1
    if toks[-1].startswith('x'): n=int(toks[-1][1:]); toks=toks[:-1]
    cs=[]
    for t in toks:
      r,q=ch(t); q={'m':'m7','':'maj7','alt':'7alt'}.get(q,q); cs.append((r,q))
    out+= [cs]*n
  return out
def nn(s):
  m=re.match(r'([A-G][b#]?)(-?\d)',s); return PC[m.group(1)]+12*(int(m.group(2))+1)
def melody(s):
  "stream 'r:1 D5:1 >F5:2 ...' lengths in swung eighths -> list of (eighthpos, pitch|None, len, accent)"
  out=[];pos=0
  for t in s.split():
    acc=t.startswith('>'); t=t.lstrip('>'); p,l=t.split(':'); l=float(l)
    if p!='r': out.append((pos,nn(p),l,acc))
    pos+=l
  return out,pos
class Song:
  def __init__(s,bpm,sw,seed):
    s.bpm=bpm;s.SW=sw;s.tr={};s.R=random.Random(seed);s.sections=[];s.bars=[]  # bars: (chords,section,mode)
  def add(s,k,t,d,p,v,hum=8):
    t=int(t)+s.R.randint(-hum,hum)
    s.tr.setdefault(k,[]).append(dict(tick=max(0,t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
  def et(s,e):
    "eighth index (may exceed 8) -> ticks from bar start, swung"
    e=float(e); i=int(e); f=e-i
    base=(i//2)*Q+(s.SW if i%2 else 0)
    if f==0: return base
    nxt=((i+1)//2)*Q+(s.SW if (i+1)%2 else 0)
    return base+(nxt-base)*f
  def section(s,name,chs,mode,energy):
    b0=len(s.bars); s.sections.append(dict(name=name,startBar=b0+1,bars=len(chs),energy=energy))
    for c in chs: s.bars.append((c,name,mode))
    return b0
  def chord_at(s,b,e):
    c=s.bars[min(b,len(s.bars)-1)][0]; return c[0] if (len(c)==1 or e<4) else c[1]
  def mel(s,k,b0,M,vel,trans=0,legato=0.92,late=10,hum=5):
    notes,_=M
    for pos,p,l,acc in notes:
      b=b0+int(pos//8); e=pos%8
      t=b*BAR+s.et(e)+late; endpos=pos+l; t2=(b0+int(endpos//8))*BAR+s.et(endpos%8)+late
      v=vel+(6 if acc else 0)+(3 if e%2==1 else 0)+(2 if l>=3 else 0)+s.R.randint(-3,3)
      s.add(k,t,(t2-t)*(legato if l<4 else 0.97),p+trans,v,hum)
  # ---------- bass ----------
  def near(s,p,pcs,lo,hi):
    c=[x for x in range(lo,hi+1) if x%12 in pcs]; return min(c,key=lambda x:(abs(x-p),s.R.random())) if c else p
  def bass(s,lo=28,hi=50,vel=92):
    prev=40
    for b,(c,name,mode) in enumerate(s.bars):
      t0=b*BAR; last=b==len(s.bars)-1
      nxt=s.bars[b+1][0][0] if not last else c[0]
      if mode in('tacet','drumsolo_tacet'): continue
      if last or mode=='final':
        s.add('bass',t0,BAR*1.5,s.near(prev,[c[0][0]],31,43),vel+4); prev=40; continue
      if mode in('two','intro2','ballad'):
        r,q=c[0]; R=s.near(prev,[r],lo+3,45)
        if len(c)==1:
          f=s.near(R+7,[(r+7)%12],R-6,R+8) if s.R.random()<.7 else s.near(R+4,[(r+CT[q][1])%12],R,R+9)
          s.add('bass',t0,Q*1.8,R,vel,6); s.add('bass',t0+2*Q,Q*1.6,f,vel-8,6)
          if s.R.random()<.3: s.add('bass',t0+s.et(7),Q*0.45,s.near(f,[(nxt[0]+1)%12,(nxt[0]-1)%12],lo,hi),vel-18,4)
          prev=f
        else:
          R2=s.near(R,[c[1][0]],lo+3,46); s.add('bass',t0,Q*1.8,R,vel,6); s.add('bass',t0+2*Q,Q*1.7,R2,vel-6,6); prev=R2
        continue
      # walking
      beats=[]
      if len(c)==1:
        r,q=c[0]; R=s.near(prev,[r],lo+2,hi-6)
        if s.R.random()<.08 and b%4!=0: R=s.near(R,[(r+CT[q][1])%12],lo+2,hi-4)
        T=s.near(R,[nxt[0]],lo+3,hi-4)
        if s.R.random()<.18: b4=s.near(T+7,[(nxt[0]+7)%12],T+5,T+8) if T+7<=hi else s.near(T-5,[(nxt[0]+7)%12],T-6,T-4)
        else:
          side= 1 if T<R else -1
          if s.R.random()<.3: side=-side
          b4=T+side
        scl=[(r+x)%12 for x in SC[q]]; cts=[(r+x)%12 for x in CT[q][:4]]
        if abs(b4-R)<4:
          up= R+10<=hi
          b2=s.near(R+(4 if up else -4),[(r+CT[q][1])%12],R-5,R+5); b3=s.near(R+(7 if up else -5),[(r+7)%12],R-8,R+8)
        else:
          b2=s.near(R+(b4-R)/3.0,cts if s.R.random()<.6 else scl,lo,hi); b3=s.near(R+2*(b4-R)/3.0,scl,lo,hi)
          if b2==R: b2=s.near(R+(1 if b4>R else -1)*2,scl,lo,hi)
          if b3==b2 or b3==b4: b3=s.near(b2+(1 if b4>b2 else -1),scl+[ (b4%12+1)%12,(b4%12-1)%12],lo,hi)
        beats=[R,b2,b3,b4]
      else:
        (r1,q1),(r2,q2)=c; R=s.near(prev,[r1],lo+2,hi-5); R2=s.near(R,[r2],lo+2,hi-5); T=s.near(R2,[nxt[0]],lo+2,hi-4)
        a1=R2+(1 if s.R.random()<.5 else -1) if s.R.random()<.6 else s.near((R+R2)/2.0,[(r1+x)%12 for x in SC[q1]],lo,hi)
        if a1 in(R,R2): a1=R2-1
        a2=T+(1 if T<R2 else -1) if s.R.random()<.75 else s.near(R2+(T-R2)/2.0,[(r2+x)%12 for x in SC[q2]],lo,hi)
        if a2 in(R2,T): a2=T+1
        beats=[R,a1,R2,a2]
      for j,p in enumerate(beats):
        while p<lo: p+=12
        while p>hi: p-=12
        v=vel+(4 if j==0 else 0)-(4 if j==2 and len(c)==1 else 0)+s.R.randint(-4,4)
        s.add('bass',t0+j*Q+4,Q*0.9,p,v,5)
      if s.R.random()<.06: s.add('bass',t0+3*Q-160,100,beats[2],vel-30,2)
      prev=beats[3]
  # ---------- piano comping ----------
  def voicing(s,c,prevlow,lo=50,hi=60):
    r,q=c; opts=[]
    for V in (VA[q],VB[q]):
      for o in range(1,7):
        base=r+12*o+V[0]
        if lo<=base<=max(hi,lo+11): opts.append([r+12*o+x for x in V])
    return min(opts,key=lambda v:(abs(v[0]-prevlow)+s.R.random()*2))
  PAT1=[[(0,3)],[(0,2),(3,2)],[(1,2),(5,2)],[(0,1),(3,1),(6,2)],[(2,1),(7,1)],[(3,2),(7,1)],[(1,1),(4,2)],[(0,2),(6,1)],[(5,2)],[(2,2),(6,2)]]
  PAT2=[[(0,2),(4,2)],[(1,1),(4,3)],[(0,2),(3,2)],[(1,2),(4,2),(7,1)],[(0,1),(3,3)]]
  def comp(s,k='piano',vel=60,modes_vel=None,shell_modes=(),skip_modes=(),lo=50,hi=60):
    low=55
    for b,(c,name,mode) in enumerate(s.bars):
      if mode in skip_modes: continue
      t0=b*BAR; last=b==len(s.bars)-1
      vb=(modes_vel or {}).get(mode,0)
      if last or mode=='final':
        v=s.voicing(c[0],low,lo,hi); 
        for j,p in enumerate(v): s.add(k,t0+j*25,BAR*1.6,p,vel+vb,3)
        s.add(k,t0,BAR*1.6,s.near(40,[c[0][0]],36,47),vel+vb-6,2); continue
      pat=s.R.choice(s.PAT1 if len(c)==1 else s.PAT2)
      if mode in('ballad','two','intro2') and len(c)==1 and s.R.random()<.6: pat=s.R.choice([[(0,4),(7,1)],[(0,3)],[(1,3),(6,2)]])
      for e,l in pat:
        cc=c[0] if (len(c)==1 or e<4) else c[1]
        if len(c)==2 and e==3 and (0,2) in pat: cc=c[1]
        if e==7 and b+1<len(s.bars) and s.R.random()<.7: cc=s.bars[b+1][0][0]
        v=s.voicing(cc,low,lo,hi); low=v[0]
        if mode in shell_modes: v=[v[0],v[2]] if len(v)>2 else v
        t=t0+s.et(e); t2=t0+s.et(e+l); d=(t2-t)*(0.85 if l>1 else 0.5)
        acc=8 if e%2==1 else 0
        for j,p in enumerate(sorted(set(v))): s.add(k,t+j*7,d,p,vel+vb+acc+s.R.randint(-5,3),4)
  # ---------- drums ----------
  def drums(s,vel=60,modes_vel=None,brush_modes=(),tacet_modes=(),fills=True):
    starts=[x['startBar']-1 for x in s.sections]
    for b,(c,name,mode) in enumerate(s.bars):
      t0=b*BAR; last=b==len(s.bars)-1; dv=(modes_vel or {}).get(mode,0)
      if mode in tacet_modes: continue
      if b in starts and b>0 and mode!='drumsolo': s.add('drums',t0,1500,49,vel+dv-2,2); s.add('drums',t0,200,36,vel+dv-14,2)
      if last or mode=='final': s.add('drums',t0,2500,51,vel+dv,0); s.add('drums',t0,2500,49,vel+dv-6,0); s.add('drums',t0,200,36,vel+dv-10,0); continue
      if mode=='drumsolo': s.drumsolo(b,vel+dv); continue
      brush=mode in brush_modes
      rideV=vel+dv-(10 if brush else 0)
      for beat in range(4):
        s.add('drums',t0+beat*Q,150,51,rideV+(5 if beat in(1,3) else 0)+s.R.randint(-4,3),4)
        if beat in(1,3) and s.R.random()<.92: s.add('drums',t0+beat*Q+s.SW,120,51,rideV-12+s.R.randint(-4,4),4)
        if brush: s.add('drums',t0+beat*Q,Q*0.9,38,vel+dv-34+(4 if beat in(1,3) else 0),3)
      for beat in(1,3): s.add('drums',t0+beat*Q,80,44,vel+dv-14,3)
      for beat in range(4): s.add('drums',t0+beat*Q,120,36,vel+dv-38,3)
      if not brush:
        for _ in range(s.R.choice([0,1,1,2])):
          e=s.R.choice([1,3,5,7,2,6]); s.add('drums',t0+s.et(e),90,38,vel+dv-30+s.R.randint(-6,10),4)
        if mode in('solo','out','shout') and s.R.random()<.2: s.add('drums',t0+s.et(s.R.choice([3,5,7])),120,36,vel+dv-12,3)
      nb=b+1
      if fills and nb in starts and nb<len(s.bars) and s.bars[nb][2]!='drumsolo':
        for j in range(3): s.add('drums',t0+3*Q+j*160,90,38,vel+dv-18+j*6,2)
  def drumsolo(s,b,vel):
    t0=b*BAR; ph=(b-[x['startBar']-1 for x in s.sections if x['startBar']-1<=b][-1])%4
    if ph==0 or not hasattr(s,'dmotif'):
      s.dmotif=[(i,s.R.choice([38,38,38,45,47,48,36,50])) for i in range(12) if s.R.random()<.5]
    hits=s.dmotif if ph in(0,2) else [(i,(p if s.R.random()<.6 else s.R.choice([38,45,47,48,50,36]))) for i,p in s.dmotif]+[(i,38) for i in range(12) if s.R.random()<.2]
    if ph==3: hits=[(i,s.R.choice([38,38,48,47,45,41])) for i in range(6,12)]+[(i,p) for i,p in s.dmotif if i<6]
    for i,p in hits:
      tt=t0+(i//3)*Q+(i%3)*160; acc=10 if i%3==0 else (4 if i%3==2 else -6)
      s.add('drums',tt,100,p,vel-8+acc+(ph==3)*i,3)
    for beat in(1,3): s.add('drums',t0+beat*Q,80,44,vel-16,3)
    if ph==0: s.add('drums',t0,800,49 if s.R.random()<.5 else 57,vel-6,2)
  # ---------- solo lines ----------
  def solo(s,k,b0,nbars,lo,hi,vel,start,arc=(0.35,0.85),late=6,motif_p=0.25):
    R=s.R;p=start;pos=R.choice([0,1,2]);end=nbars*8;motifs=[]
    def tones(b,ee):
      r,qq=s.chord_at(b,int(ee)); return r,qq,[(r+x)%12 for x in CT[qq][:4]]+[(r+x)%12 for x in TEN[qq]],[(r+x)%12 for x in SC[qq]]
    while pos<end-3:
      x=pos/end; inten=arc[0]+(arc[1]-arc[0])*x
      L=int(R.choice([12,14,16,18,20,24,28,32])*(0.7+inten*0.6)); L=max(6,min(L,end-pos-1))
      span=hi-lo; peak=int(lo+span*(0.4+0.42*inten)+R.randint(-4,4)); peak=max(lo+6,min(hi,peak))
      reuse=motifs and R.random()<motif_p
      if reuse: rhy,ints=R.choice(motifs)
      rhy_out=[];ints_out=[];e=pos;i=0;lastp=p;lock=0
      while e<pos+L:
        b=b0+int(e//8); ee=e%8; r,qq,cts,scl=tones(b,ee)
        final=e+2>=pos+L; half=(e-pos)<L*0.55
        if reuse and i<len(rhy):
          ln=rhy[i]; tgt=lastp+ints[i]; p=s.near(tgt,cts if int(ee)%2==0 else scl,lo,hi)
        else:
          trip=int(ee)%2==0 and not final and R.random()<0.06+0.12*inten
          ln=R.choice([2,3,4]) if final else (2 if trip else (1 if R.random()<0.86 else 2))
          d=(1 if peak>p else -1) if half else -1
          if R.random()<.18: d=-d
          if p>=hi-2 or p>=peak: lock=-1
          if p<=lo+2: lock=1
          if lock: d=lock
          if trip:
            for j in range(3):
              cand=[y for y in range(lo,hi+1) if y%12 in scl and 0<(y-p)*d<=2] or [p]
              p=cand[0] if d>0 else cand[-1]
              tt=b*BAR+s.et(ee)+j*(Q//3)+late
              s.add(k,tt,Q/3*0.9,p,vel+inten*10+(5 if j==0 else -3)+R.randint(-3,3),3)
            rhy_out.append(2);ints_out.append(p-lastp);lastp=p;e+=2;i+=1;continue
          if int(ee)%2==0 or final:
            cand=[y for y in range(lo,hi+1) if y%12 in cts and 0<(y-p)*d<=5] or [s.near(p+d*2,cts,lo,hi)]
            p=cand[0] if d>0 else cand[-1]
            if final:
              good=[(r+CT[qq][1])%12,(r+CT[qq][3])%12]+[(r+x)%12 for x in TEN[qq]]
              p=s.near(p,good,lo,hi)
          else:
            nb=b0+int((e+1)//8); _,_,ncts,_=tones(nb,(e+1)%8); ncts=ncts[:4]
            tgt=[y for y in range(lo,hi+1) if y%12 in ncts and 0<(y-p)*d<=4]
            if tgt and R.random()<.45: p=(tgt[0] if d>0 else tgt[-1])-d
            else:
              cand=[y for y in range(lo,hi+1) if y%12 in scl and 0<(y-p)*d<=2] or [p+d]
              p=cand[0] if d>0 else cand[-1]
        p=max(lo,min(hi,p))
        if p==lastp and i>0: p=s.near(p+(1 if p<hi-2 else -2),scl,lo,hi) if p+1!=lastp else p
        t=b*BAR+s.et(ee)+late; t2=(b0+int((e+ln)//8))*BAR+s.et((e+ln)%8)+late
        v=vel+inten*10+(4 if int(ee)%2==1 else -2)+(4 if final else 0)+(p-(lo+hi)/2)*0.35+R.randint(-4,4)
        s.add(k,t,(t2-t)*(0.94 if ln<2 else 0.88),p,v,3)
        rhy_out.append(ln);ints_out.append(p-lastp);lastp=p;e+=ln;i+=1
      if not reuse and len(rhy_out)>=5: motifs.append((rhy_out[:10],ints_out[:10]))
      pos=e+max(2,int(R.choice([2,2,3,3,4,5])*(1.3-inten*0.6)))
  # ---------- out ----------
  def clean(s):
    for k,N in s.tr.items():
      N.sort(key=lambda n:(n['pitch'],n['tick']))
      for a,cn in zip(N,N[1:]):
        if a['pitch']==cn['pitch'] and a['tick']+a['duration']>cn['tick']:
          if abs(a['tick']-cn['tick'])<20: cn['velocity']=0
          else: a['duration']=max(30,cn['tick']-a['tick']-10)
      s.tr[k]=sorted([n for n in N if n['velocity']>0],key=lambda n:(n['tick'],n['pitch']))
  def apply_arc(s,ARC):
    for k,N in s.tr.items():
      for n in N:
        bi=n['tick']//BAR; sec=[x for x in s.sections if x['startBar']-1<=bi][-1]['name']
        f=ARC.get(sec,1.0)*ARC.get(k+'@'+sec,1.0)*ARC.get(k,1.0)
        n['velocity']=max(1,min(127,int(n['velocity']*f)))
  def save(s,V,meta,ARC=None):
    s.clean()
    if ARC: s.apply_arc(ARC)
    total=len(s.bars)
    json.dump(dict(tracks=s.tr,sections=s.sections,bars=total,bpm=s.bpm,endTick=total*BAR+BAR,timeSig=[4,4],barSec=240/s.bpm,meta=meta),open(f'plan_{V}.json','w'))
    import mido
    mf=mido.MidiFile(ticks_per_beat=Q);t=mido.MidiTrack();mf.tracks.append(t)
    t.append(mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(s.bpm)))
    for nm,k,chn,prog,vol,pan in meta['mix']:
      t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
      if chn!=9: t.append(mido.Message('program_change',channel=chn,program=prog))
      ev=[]
      for n in s.tr.get(k,[]): ev+=[(n['tick'],1,mido.Message('note_on',channel=chn,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=chn,note=n['pitch']))]
      ev.sort(key=lambda e:(e[0],e[1]));l=0
      for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
    mf.save(f"{meta['slug']}_{V}.mid")
    print(V,{k:len(v) for k,v in s.tr.items()},total,'bars',round(mf.length,1),'s')
