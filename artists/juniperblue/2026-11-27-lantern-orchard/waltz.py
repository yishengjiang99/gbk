# Juniper Blue 3/4 jazz-waltz engine: bass in one/three, waltz comping, brush/stick waltz kit, solo lines.
import random,json
from jazz import Q,PC,CT,TEN,SC,VA,VB,nn,melody,ch
CT=dict(CT,sus=[0,5,7,10],m6=[0,3,7,9]); TEN=dict(TEN,sus=[2,9]); SC=dict(SC,sus=[0,2,4,5,7,9,10])
VA=dict(VA,sus=[5,10,14,19]); VB=dict(VB,sus=[10,14,17,21])
BAR=3*Q; EPB=6
def chart(s):
  out=[]
  for b in s.split('|'):
    t=b.split()
    if not t: continue
    n=1
    if t[-1].startswith('x'): n=int(t[-1][1:]); t=t[:-1]
    r,q=ch(t[0]); q={'m':'m7','':'maj7','alt':'7alt'}.get(q,q); out+=[[(r,q)]]*n
  return out
class W:
  def __init__(s,bpm,sw,seed): s.bpm=bpm;s.SW=sw;s.tr={};s.R=random.Random(seed);s.sections=[];s.bars=[]
  def add(s,k,t,d,p,v,hum=8):
    t=int(t)+s.R.randint(-hum,hum)
    s.tr.setdefault(k,[]).append(dict(tick=max(0,t),duration=max(30,int(d)),pitch=int(p),velocity=max(1,min(127,int(v)))))
  def et(s,e):
    e=float(e);i=int(e);f=e-i
    g=lambda i:(i//2)*Q+(s.SW if i%2 else 0)
    return g(i)+(g(i+1)-g(i))*f
  def section(s,name,chs,mode,energy):
    b0=len(s.bars); s.sections.append(dict(name=name,startBar=b0+1,bars=len(chs),energy=energy))
    for c in chs: s.bars.append((c,name,mode))
    return b0
  def mel(s,k,b0,M,vel,trans=0,legato=0.92,late=10,hum=5):
    for pos,p,l,acc in M[0]:
      b=b0+int(pos//EPB);e=pos%EPB
      t=b*BAR+s.et(e)+late;en=pos+l;t2=(b0+int(en//EPB))*BAR+s.et(en%EPB)+late
      v=vel+(6 if acc else 0)+(3 if e%2==1 else 0)+(2 if l>=3 else 0)+s.R.randint(-3,3)
      s.add(k,t,(t2-t)*(legato if l<4 else 0.97),p+trans,v,hum)
  def near(s,p,pcs,lo,hi):
    c=[x for x in range(lo,hi+1) if x%12 in pcs]; return min(c,key=lambda x:(abs(x-p),s.R.random())) if c else p
  def bass(s,k='bass',lo=28,hi=50,vel=90,skip=()):
    prev=40
    for b,(c,name,mode) in enumerate(s.bars):
      if mode in skip: continue
      t0=b*BAR;last=b==len(s.bars)-1;r,q=c[0]
      nxt=s.bars[b+1][0][0] if not last else c[0]
      if last or mode=='final': s.add(k,t0,BAR*2,s.near(prev,[r],31,43),vel+4); prev=40; continue
      R=s.near(prev,[r],lo+2,hi-6)
      if mode in('one','intro','ballad'):
        s.add(k,t0+4,Q*2.7,R,vel+2,5)
        if s.R.random()<.45:
          a=s.near(R,[(nxt[0]+1)%12,(nxt[0]-1)%12,(nxt[0]+7)%12],lo,hi); s.add(k,t0+2*Q+4,Q*0.85,a,vel-10,5)
        prev=R; continue
      # walking in three
      T=s.near(R,[nxt[0]],lo+3,hi-4)
      if s.R.random()<.6: a2=T+(1 if T<R else -1)*(1 if s.R.random()<.5 else -1)
      else: a2=s.near(T+(2 if T<R else -2),[(r+x)%12 for x in SC[q]],lo,hi)
      if a2 in(R,T): a2=T-1 if T>lo else T+1
      if abs(a2-R)<=2: m=s.near(R+(7 if R+7<=hi else -5),[(r+7)%12,(r+CT[q][1])%12],lo,hi)
      else: m=s.near((R+a2)/2,[(r+x)%12 for x in CT[q][:4]]+[(r+x)%12 for x in SC[q]],lo,hi)
      if m in(R,a2): m=s.near(m+2,[(r+x)%12 for x in SC[q]],lo,hi)
      for j,p in enumerate((R,m,a2)):
        while p<lo:p+=12
        while p>hi:p-=12
        s.add(k,t0+j*Q+4,Q*0.9,p,vel+(5 if j==0 else -2)+s.R.randint(-4,4),5)
      prev=a2
  def voicing(s,c,prevlow,lo=50,hi=60):
    r,q=c;opts=[]
    for V in (VA[q],VB[q]):
      for o in range(1,7):
        base=r+12*o+V[0]
        if lo<=base<=max(hi,lo+11): opts.append([r+12*o+x for x in V])
    return min(opts,key=lambda v:(abs(v[0]-prevlow)+s.R.random()*2))
  WP=[[(2,2),(4,2)],[(3,1)],[(2,1),(5,1)],[(1,2),(4,2)],[(0,2),(3,2)],[(2,3)],[(3,1),(5,1)],[(0,1),(2,2)]]
  def comp(s,k='piano',vel=58,modes_vel=None,skip=(),lo=50,hi=60,lh_modes=()):
    low=55
    for b,(c,name,mode) in enumerate(s.bars):
      if mode in skip: continue
      t0=b*BAR;last=b==len(s.bars)-1;vb=(modes_vel or {}).get(mode,0)
      if last or mode=='final':
        v=s.voicing(c[0],low,lo,hi)
        for j,p in enumerate(v): s.add(k,t0+j*30,BAR*2,p,vel+vb,3)
        s.add(k,t0,BAR*2,s.near(40,[c[0][0]],36,47),vel+vb-6,2); continue
      pat=s.R.choice(s.WP)
      if mode in lh_modes: pat=[(0,2)]+[x for x in pat if x[0]>=2] if s.R.random()<.5 else pat
      for e,l in pat:
        cc=c[0]
        if e==5 and b+1<len(s.bars) and s.R.random()<.6: cc=s.bars[b+1][0][0]
        v=s.voicing(cc,low,lo,hi);low=v[0]
        t=t0+s.et(e);t2=t0+s.et(e+l);d=(t2-t)*(0.85 if l>1 else 0.55)
        acc=6 if e%2==1 else 0
        for j,p in enumerate(sorted(set(v))): s.add(k,t+j*8,d,p,vel+vb+acc+s.R.randint(-5,3),4)
  def drums(s,vel=60,modes_vel=None,brush_modes=(),tacet=(),fills=True):
    starts=[x['startBar']-1 for x in s.sections]
    for b,(c,name,mode) in enumerate(s.bars):
      t0=b*BAR;last=b==len(s.bars)-1;dv=(modes_vel or {}).get(mode,0)
      if mode in tacet: continue
      if b in starts and b>0: s.add('drums',t0,1500,49 if mode not in brush_modes else 52,vel+dv-6,2); s.add('drums',t0,200,36,vel+dv-16,2)
      if last or mode=='final': s.add('drums',t0,3000,51,vel+dv,0); s.add('drums',t0,3000,49,vel+dv-8,0); s.add('drums',t0,200,36,vel+dv-12,0); continue
      br=mode in brush_modes; rv=vel+dv-(8 if br else 0)
      # ride: 1, 2, (2&), 3
      s.add('drums',t0,150,51,rv+4+s.R.randint(-3,3),4)
      s.add('drums',t0+Q,150,51,rv-2+s.R.randint(-3,3),4)
      if s.R.random()<.85: s.add('drums',t0+Q+s.SW,120,51,rv-10+s.R.randint(-3,3),4)
      s.add('drums',t0+2*Q,150,51,rv+s.R.randint(-3,3),4)
      s.add('drums',t0+Q,80,44,vel+dv-16,3); s.add('drums',t0+2*Q,80,44,vel+dv-20,3)
      s.add('drums',t0,120,36,vel+dv-34,3)
      if br:
        for beat in range(3): s.add('drums',t0+beat*Q,Q*0.9,38,vel+dv-36+(4 if beat==0 else 0),3)
      for _ in range(s.R.choice([0,0,1,1,2] if not br else [0,0,1])):
        e=s.R.choice([1,3,5,4,2]); s.add('drums',t0+s.et(e),90,38,vel+dv-(30 if not br else 24)+s.R.randint(-6,8),4)
      nb=b+1
      if fills and nb in starts and nb<len(s.bars):
        for j in range(3): s.add('drums',t0+2*Q+j*160,90,38,vel+dv-20+j*6,2)
  def chord_at(s,b,e): return s.bars[min(b,len(s.bars)-1)][0][0]
  def solo(s,k,b0,nbars,lo,hi,vel,start,arc=(0.35,0.85),late=6,motif_p=0.3,dens=0.75):
    R=s.R;p=start;pos=R.choice([0,1,2]);end=nbars*EPB;motifs=[]
    def tones(b):
      r,qq=s.chord_at(b,0); return r,qq,[(r+x)%12 for x in CT[qq][:4]]+[(r+x)%12 for x in TEN[qq]],[(r+x)%12 for x in SC[qq]]
    while pos<end-3:
      x=pos/end;inten=arc[0]+(arc[1]-arc[0])*x
      L=int(R.choice([9,12,12,15,18,21,24])*(0.7+inten*0.6));L=max(5,min(L,end-pos-1))
      span=hi-lo;peak=int(lo+span*(0.4+0.42*inten)+R.randint(-4,4));peak=max(lo+6,min(hi,peak))
      reuse=motifs and R.random()<motif_p
      if reuse: rhy,ints=R.choice(motifs)
      ro=[];io=[];e=pos;i=0;lastp=p;lock=0
      while e<pos+L:
        b=b0+int(e//EPB);ee=e%EPB;r,qq,cts,scl=tones(b)
        final=e+2>=pos+L;half=(e-pos)<L*0.55
        if reuse and i<len(rhy):
          ln=rhy[i];p=s.near(lastp+ints[i],cts if int(ee)%2==0 else scl,lo,hi)
        else:
          trip=int(ee)%2==0 and not final and R.random()<0.05+0.1*inten
          ln=R.choice([2,3,4]) if final else (2 if trip else (1 if R.random()<dens else R.choice([2,2,3])))
          d=(1 if peak>p else -1) if half else -1
          if R.random()<.18:d=-d
          if p>=hi-2 or p>=peak: lock=-1
          if p<=lo+2: lock=1
          if lock: d=lock
          if trip:
            for j in range(3):
              cand=[y for y in range(lo,hi+1) if y%12 in scl and 0<(y-p)*d<=2] or [p]
              p=cand[0] if d>0 else cand[-1]
              s.add(k,b*BAR+s.et(ee)+j*(Q//3)+late,Q/3*0.9,p,vel+inten*10+(5 if j==0 else -3)+R.randint(-3,3),3)
            ro.append(2);io.append(p-lastp);lastp=p;e+=2;i+=1;continue
          if int(ee)%2==0 or final:
            cand=[y for y in range(lo,hi+1) if y%12 in cts and 0<(y-p)*d<=5] or [s.near(p+d*2,cts,lo,hi)]
            p=cand[0] if d>0 else cand[-1]
            if final: p=s.near(p,[(r+CT[qq][1])%12,(r+CT[qq][3])%12]+[(r+x)%12 for x in TEN[qq]],lo,hi)
          else:
            _,_,nc,_=tones(b0+int((e+1)//EPB));nc=nc[:4]
            tg=[y for y in range(lo,hi+1) if y%12 in nc and 0<(y-p)*d<=4]
            if tg and R.random()<.45: p=(tg[0] if d>0 else tg[-1])-d
            else:
              cand=[y for y in range(lo,hi+1) if y%12 in scl and 0<(y-p)*d<=2] or [p+d]
              p=cand[0] if d>0 else cand[-1]
        p=max(lo,min(hi,p))
        if p==lastp and i>0: p=s.near(p+(1 if p<hi-2 else -2),scl,lo,hi) if p+1!=lastp else p
        t=b*BAR+s.et(ee)+late;t2=(b0+int((e+ln)//EPB))*BAR+s.et((e+ln)%EPB)+late
        v=vel+inten*10+(4 if int(ee)%2==1 else -2)+(4 if final else 0)+(p-(lo+hi)/2)*0.35+R.randint(-4,4)
        s.add(k,t,(t2-t)*(0.94 if ln<2 else 0.88),p,v,3)
        ro.append(ln);io.append(p-lastp);lastp=p;e+=ln;i+=1
      if not reuse and len(ro)>=4: motifs.append((ro[:9],io[:9]))
      pos=e+max(2,int(R.choice([2,3,3,4,5,6])*(1.3-inten*0.6)))
  def clean(s):
    for k,N in s.tr.items():
      N.sort(key=lambda n:(n['pitch'],n['tick']))
      for a,c in zip(N,N[1:]):
        if a['pitch']==c['pitch'] and a['tick']+a['duration']>c['tick']:
          if abs(a['tick']-c['tick'])<20: c['velocity']=0
          else: a['duration']=max(30,c['tick']-a['tick']-10)
      s.tr[k]=sorted([n for n in N if n['velocity']>0],key=lambda n:(n['tick'],n['pitch']))
  def apply_arc(s,ARC):
    for k,N in s.tr.items():
      for n in N:
        bi=n['tick']//BAR;sec=[x for x in s.sections if x['startBar']-1<=bi][-1]['name']
        n['velocity']=max(1,min(127,int(n['velocity']*ARC.get(sec,1.0)*ARC.get(k+'@'+sec,1.0)*ARC.get(k,1.0))))
  def save(s,V,meta,ARC=None):
    s.clean()
    if ARC: s.apply_arc(ARC)
    total=len(s.bars)
    json.dump(dict(tracks=s.tr,sections=s.sections,bars=total,bpm=s.bpm,endTick=total*BAR+BAR,timeSig=[3,4],barSec=180/s.bpm,meta=meta),open(f'plan_{V}.json','w'))
    import mido
    mf=mido.MidiFile(ticks_per_beat=Q);t=mido.MidiTrack();mf.tracks.append(t)
    t.append(mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(s.bpm)));t.append(mido.MetaMessage('time_signature',numerator=3,denominator=4))
    for nm,k,chn,prog,vol,pan in meta['mix']:
      t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm))
      if chn!=9: t.append(mido.Message('program_change',channel=chn,program=prog))
      t.append(mido.Message('control_change',channel=chn,control=7,value=vol));t.append(mido.Message('control_change',channel=chn,control=10,value=pan))
      ev=[]
      for n in s.tr.get(k,[]): ev+=[(n['tick'],1,mido.Message('note_on',channel=chn,note=n['pitch'],velocity=n['velocity'])),(n['tick']+n['duration'],0,mido.Message('note_off',channel=chn,note=n['pitch']))]
      ev.sort(key=lambda e:(e[0],e[1]));l=0
      for t_,_,m in ev: t.append(m.copy(time=t_-l));l=t_
    mf.save(f"{meta['slug']}_{V}.mid")
    print(V,{k:len(v) for k,v in s.tr.items()},total,'bars',round(mf.length,1),'s')
def lint(name,bars,m):
  NM='C Db D Eb E F Gb G Ab A Bb B'.split()
  notes,tot=melody(m);bad=0
  if tot!=len(bars)*EPB: print(f'{name}: length {tot} eighths, expected {len(bars)*EPB}')
  for pos,p,l,acc in notes:
    b=int(pos//EPB);e=pos%EPB
    if b>=len(bars): print(f'{name}: past end bar {b+1}');continue
    r,q=bars[b][0];rel=(p-r)%12;ok=rel in [x%12 for x in CT[q]]+TEN[q]
    if (e%2==0 or l>=2 or acc) and not ok: bad+=1;print(f'  {name} b{b+1} e{e} {NM[p%12]}{p//12-1} over {NM[r]}{q} ({"scale" if rel in SC[q] else "OUT"}) len {l}')
  print(f'{name}: {len(notes)} notes, {bad} flagged')
