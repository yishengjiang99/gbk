# 2026-11-23 grooves: quartal comping, cha-cha (montuno, tumbao, percussion), harmony helpers.
from jazz import *
from extra import guide
def harm(s,k,b0,M,vel,below=True,octave=0,legato=0.9,late=6):
  "diatonic chord-tone harmony line a 3rd-6th from the melody"
  notes,_=M
  for pos,p,l,acc in notes:
    bb=b0+int(pos//8); r,q=s.chord_at(bb,int(pos%8))
    cts=[(r+x)%12 for x in CT[q][:4]]+[(r+x)%12 for x in TEN[q]]
    if below: h=max([y for y in range(p-9,p-2) if y%12 in cts] or [p-3])
    else: h=min([y for y in range(p+3,p+10) if y%12 in cts] or [p+4])
    s.mel(k,b0,([(pos,h+octave,l,acc)],0),vel,legato=legato,late=late)
def quartal(s,c,prevlow,lo=50,hi=62):
  "stack of 4ths inside the chord scale (3-4 notes, optional 3rd on top); alt chords use VA/VB"
  r,q=c
  if q in('7alt','7b9','dim7','m7b5'): return s.voicing(c,prevlow,lo,hi)
  scl=set((r+x)%12 for x in SC[q]); opts=[]
  for b in range(lo,hi+1):
    if b%12 not in scl: continue
    v=[b,b+5,b+10]
    if any(x%12 not in scl for x in v): continue
    if (b+15)%12 in scl: v4=v+[b+15]
    elif (b+14)%12 in scl: v4=v+[b+14]
    else: v4=v
    pcs=[(x-r)%12 for x in v4]
    if not any(i in pcs for i in (3,4,10,11)): continue   # need a 3rd or 7th
    if q in('7','13','7#11') and 5 in pcs: continue
    if q in('maj7','6','maj7#11') and 5 in pcs: continue
    opts.append(v4)
  return min(opts,key=lambda v:(abs(v[0]-prevlow)+s.R.random()*3)) if opts else s.voicing(c,prevlow,lo,hi)
QPAT=[[(0,3)],[(3,5)],[(1,2),(5,3)],[(0,1),(3,2)],[(2,2),(6,2)],[(3,1),(6,2)],[(0,2),(5,1),(7,1)],[(1,6)]]
def qcomp(s,k='piano',vel=60,modes_vel=None,skip_modes=(),sparse_modes=(),lo=50,hi=62):
  low=55
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR; vb=(modes_vel or {}).get(mode,0)
    if b==len(s.bars)-1 or mode=='final':
      v=quartal(s,c[0],low,lo,hi)
      for j,p in enumerate(v): s.add(k,t0+j*30,BAR*1.8,p,vel+vb,2)
      s.add(k,t0,BAR*1.8,s.near(41,[c[0][0]],34,46),vel+vb-4,2); continue
    if mode in sparse_modes: pat=s.R.choice([[(0,6)],[(3,5)],[(0,3),(6,2)]])
    else: pat=s.R.choice(QPAT)
    for e,l in pat:
      cc=c[0] if (len(c)==1 or e<4) else c[1]
      if e==7 and b+1<len(s.bars) and s.R.random()<.7: cc=s.bars[b+1][0][0]
      v=quartal(s,cc,low,lo,hi); low=v[0]
      t=t0+s.et(e); t2=t0+s.et(e+l); d=(t2-t)*(0.9 if l>1 else 0.55)
      for j,p in enumerate(v): s.add(k,t+j*6,d,p,vel+vb+(6 if e%2 else 0)+s.R.randint(-4,3),4)
def pedal(s,k,b0,nbars,pc,vel,pat=((0,3),(3,1),(5,3)),lo=29,hi=41):
  "ostinato bass pedal (eighth positions)"
  p=s.near(36,[pc],lo,hi)
  for b in range(b0,b0+nbars):
    for e,l in pat:
      q=p if e!=5 else p+7 if p+7<=hi+7 else p-5
      t=b*BAR+s.et(e); s.add(k,t,(b*BAR+s.et(e+l)-t)*0.9,q,vel+(6 if e==0 else 0)+s.R.randint(-3,3),4)
# ---------- cha-cha ----------
def montuno(s,k,vel,lo=60,hi=75,skip_modes=(),sparse_modes=()):
  "2-bar guajeo, octave-doubled chord tones, voice-led"
  P1=[0,2,3,5,7]; P2=[1,2,4,5,6,7]; p=67
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR
    if b==len(s.bars)-1 or mode=='final':
      v=s.voicing(c[0],55,52,62)
      for j,x in enumerate(v): s.add(k,t0+j*20,BAR,x,vel+6,2)
      s.add(k,t0,BAR,s.near(p,[c[0][0]],lo,hi),vel+6,2); continue
    pat=P1 if b%2==0 else P2
    if mode in sparse_modes: pat=[0,3,6]
    for i,e in enumerate(pat):
      r,q=c[0] if (len(c)==1 or e<4) else c[1]
      cts=[(r+x)%12 for x in CT[q][:4]]
      if e==7 and b+1<len(s.bars): r2,q2=s.bars[b+1][0][0]; cts=[(r2+x)%12 for x in CT[q2][:3]]
      d=1 if (i%3)!=2 else -1
      cand=[y for y in range(lo,hi+1) if y%12 in cts and 0<(y-p)*d<=5] or [s.near(p,cts,lo,hi)]
      p=cand[0] if d>0 else cand[-1]
      t=t0+s.et(e)
      for x in (p,p-12): s.add(k,t,s.et(1)*0.8,x,vel+(6 if e in(3,7) else 0)-(8 if x<p else 0)+s.R.randint(-4,3),3)
def tumbao(s,k,vel,lo=28,hi=47,skip_modes=()):
  prev=36
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR
    if b==len(s.bars)-1 or mode=='final': s.add(k,t0,Q*0.9,s.near(prev,[c[0][0]],lo,hi-5),vel+6,2); continue
    nxt=s.bars[b+1][0][0]
    r,q=c[0]; R=s.near(prev,[r],lo,hi-5)
    if len(c)==2: (r2,q2)=c[1]; F=s.near(R,[r2],lo,hi)
    else: F=s.near(R+7,[(r+7)%12],lo,hi)
    T=s.near(F,[nxt[0]],lo,hi)
    s.add(k,t0+4,Q*1.6,R,vel+6+s.R.randint(-3,3),3)
    s.add(k,t0+2*Q+4,Q*0.9,F,vel-2+s.R.randint(-3,3),3)
    s.add(k,t0+3*Q+4,Q*0.45,F,vel-8+s.R.randint(-3,3),3)
    s.add(k,t0+3*Q+Q//2+4,Q*0.45,T+(1 if T<F else -1) if s.R.random()<.5 else F,vel-6+s.R.randint(-3,3),3)
    prev=T
def chachaperc(s,vel,modes_vel=None,tacet_modes=(),timb_modes=()):
  starts=[x['startBar']-1 for x in s.sections]
  E=Q//2
  for b,(c,name,mode) in enumerate(s.bars):
    t0=b*BAR; v=vel+(modes_vel or {}).get(mode,0); last=b==len(s.bars)-1
    if mode in tacet_modes: continue
    if last or mode=='final':
      for p in (49,65,56,36): s.add('drums',t0,1200,p,v+4,0)
      continue
    if b in starts and b>0: s.add('drums',t0,1500,49,v-6,2)
    # cha-cha bell on quarters (or timbale bell/cascara in hot sections)
    for beat in range(4): s.add('drums',t0+beat*Q,100,56,v-(4 if beat in(0,2) else 14)+s.R.randint(-3,3),3)
    if mode in timb_modes:
      for e in (0,2,3,5,6): s.add('drums',t0+e*E,60,75,v-18+s.R.randint(-4,4),3)
    # guiro long on 1 and 3, short on 2, 2&, 4, 4&
    for e,p in ((0,74),(2,73),(3,73),(4,74),(6,73),(7,73)): s.add('drums',t0+e*E,(E*1.8 if p==74 else E*0.5),p,v-16+s.R.randint(-4,3),3)
    # congas: tumbadora (heel/slap on 2, open on 4 and 4&)
    s.add('drums',t0+Q,90,62,v-14,3); s.add('drums',t0+3*Q,140,63,v-6,3); s.add('drums',t0+3*Q+E,140,64,v-4,3)
    s.add('drums',t0,90,62,v-26,3); s.add('drums',t0+2*Q,90,62,v-26,3)
    # soft kick 1 and 3&
    s.add('drums',t0,120,36,v-24,3)
    nb=b+1
    if nb in starts and nb<len(s.bars):
      for j,e in enumerate((5,6,7)): s.add('drums',t0+e*E,90,65 if j<2 else 66,v-6+j*4,2)
