# 2026-11-25 grooves: samba (bass, partido-alto comp, kit), stride left hand.
from extra2 import *
def sambabass(s,k,vel,lo=28,hi=47,skip_modes=()):
  prev=36
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR; last=b==len(s.bars)-1
    if last or mode=='final': s.add(k,t0,BAR*1.2,s.near(prev,[c[0][0][0] if False else c[0][0]],lo,hi-5),vel+6,2); continue
    nxt=s.bars[b+1][0][0]
    r,q=c[0]; R=s.near(prev,[r],lo,hi-6)
    if len(c)==2: F=s.near(R,[c[1][0]],lo,hi-3); F5=F
    else: F=s.near(R-5,[(r+7)%12],R-6,R+8); F5=F
    T=s.near(F,[nxt[0]],lo,hi-4)
    ap=T+(1 if T<F else -1) if s.R.random()<.6 else s.near(F,[(c[-1][0]+7)%12],lo,hi)
    for e,l,p,dv in ((0,3,R,6),(3,1,R if len(c)==2 else F5,-10),(4,3,F,2),(7,1,ap,-8)):
      t=t0+s.et(e); s.add(k,t,(t0+s.et(e+l)-t)*0.85,p,vel+dv+s.R.randint(-3,3),3)
    prev=T
PA=[[(1,1),(3,1),(6,2)],[(0,1),(2,1),(5,2)]]
def partido(s,k,vel,lo=52,hi=64,modes_vel=None,skip_modes=(),sparse_modes=()):
  low=56
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR; vb=(modes_vel or {}).get(mode,0)
    if b==len(s.bars)-1 or mode=='final':
      v=s.voicing(c[0],low,lo,hi)
      for j,p in enumerate(v): s.add(k,t0+j*25,BAR*1.5,p,vel+vb+4,2)
      continue
    pat=[(0,4),(5,3)] if mode in sparse_modes else PA[b%2]
    for e,l in pat:
      cc=c[0] if (len(c)==1 or e<4) else c[1]
      if e>=6 and b+1<len(s.bars) and s.R.random()<.5: cc=s.bars[b+1][0][0]
      v=s.voicing(cc,low,lo,hi); low=v[0]
      t=t0+s.et(e); d=(t0+s.et(e+l)-t)*0.8
      for j,p in enumerate(v): s.add(k,t+j*5,d,p,vel+vb+(5 if e%2 else 0)+s.R.randint(-4,3),3)
def sambakit(s,vel,modes_vel=None,tacet_modes=(),ride_modes=()):
  starts=[x['startBar']-1 for x in s.sections]; E=Q//2
  RIM=[0,3,6,10,13]   # 2-bar clave-ish rim pattern in eighths
  for b,(c,name,mode) in enumerate(s.bars):
    t0=b*BAR; v=vel+(modes_vel or {}).get(mode,0); last=b==len(s.bars)-1
    if mode in tacet_modes: continue
    if last or mode=='final':
      for p in (49,36): s.add('drums',t0,2000,p,v,0)
      continue
    if b in starts and b>0: s.add('drums',t0,1500,49,v-4,2)
    for e in range(8):
      if mode in ride_modes: s.add('drums',t0+e*E,100,51 if e%2==0 else 51,v-14+(6 if e%2 else 0)+s.R.randint(-4,3),3)
      else: s.add('drums',t0+e*E,60,42,v-22+(8 if e%2 else 0)+s.R.randint(-4,3),3)
    for e,dv in ((0,-16),(3,-20),(4,-6),(7,-20)): s.add('drums',t0+e*E,120,36,v+dv+s.R.randint(-3,3),3)
    for x in RIM:
      if x//8==b%2: s.add('drums',t0+(x%8)*E,80,37,v-12+s.R.randint(-4,4),3)
    nb=b+1
    if nb in starts and nb<len(s.bars):
      for j,e in enumerate((5,6,7)): s.add('drums',t0+e*E,90,38 if j<2 else 47,v-12+j*5,2)
def stride(s,k,b0,nbars,vel,swing_chord=True):
  "stride left hand: bass note on 1 and 3 (root, then 5th/octave), mid chord on 2 and 4"
  prev=40; low=55
  for b in range(b0,b0+nbars):
    c=s.bars[b][0]; t0=b*BAR
    for beat in range(4):
      r,q=c[0] if (len(c)==1 or beat<2) else c[1]
      if beat%2==0:
        if beat==0 or len(c)==2: p=s.near(prev,[r],31,43)
        else: p=s.near(prev,[(r+7)%12],31,43)
        dur=Q*0.8
        s.add(k,t0+beat*Q,dur,p,vel+4+s.R.randint(-3,3),3)
        if beat==0 and s.R.random()<.5: s.add(k,t0+beat*Q,dur,p+12,vel-8,3)  # octave doubling
        prev=p
      else:
        v=s.voicing((r,q),low,52,60); low=v[0]
        for j,x in enumerate(v[:3]): s.add(k,t0+beat*Q+j*4,Q*0.55,x,vel-10+s.R.randint(-3,3),3)
