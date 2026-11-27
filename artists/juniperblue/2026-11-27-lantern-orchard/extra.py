# Extra grooves for 2026-11-21: second-line street beat, banjo strum, funk drums/bass, Rhodes comp, guide-tone pads.
from jazz import *
S16=120
def guide(s,k,b0,nbars,vel,lo=50,hi=62,skip=()):
  "half-note 3rd/7th guide tones, voice-led"
  p=56
  for b in range(b0,b0+nbars):
    if b in skip: continue
    c=s.bars[b][0]
    for i,(r,q) in enumerate(c if len(c)==2 else [c[0],c[0]]):
      pcs=[(r+CT[q][1])%12,(r+CT[q][3])%12]
      if i==1 and len(c)==1: pcs=[x for x in pcs if x!=p%12] or pcs
      p=s.near(p,pcs,lo,hi); s.add(k,b*BAR+i*2*Q+12,2*Q*0.95,p,vel+(3 if i==0 else -2),6)
def secondline(s,vel=80,modes_vel=None,tacet_modes=()):
  starts=[x['startBar']-1 for x in s.sections]
  for b,(c,name,mode) in enumerate(s.bars):
    t0=b*BAR; dv=(modes_vel or {}).get(mode,0); v=vel+dv; last=b==len(s.bars)-1
    if mode in tacet_modes: continue
    if last or mode=='final':
      s.add('drums',t0,2500,49,v,0); s.add('drums',t0,300,36,v,0); s.add('drums',t0,300,38,v,0); continue
    if b in starts and b>0: s.add('drums',t0,1500,49,v-8,2)
    kick=[0,3,6] if b%2==0 else [0,3,5,7]
    for e in kick: s.add('drums',t0+s.et(e),160,36,v-(0 if e==0 else 10 if e in(3,5) else 20),4)
    for e in(2,6): s.add('drums',t0+s.et(e),120,38,v-2+s.R.randint(-3,3),3)
    for e in(1,3,5,7):
      if s.R.random()<.6: s.add('drums',t0+s.et(e),70,38,v-34+s.R.randint(-6,6),4)
    if b%2==1 and s.R.random()<.7:
      for j in range(4): s.add('drums',t0+s.et(6)+j*70,60,38,v-30+j*6,1)
    for e in(2,6): s.add('drums',t0+s.et(e),200,51,v-26,3)
    for e in(2,6): s.add('drums',t0+s.et(e),80,44,v-22,3)
    nb=b+1
    if nb in starts and nb<len(s.bars):
      for j in range(5): s.add('drums',t0+s.et(5)+j*110,80,38,v-24+j*5,2)
def strum(s,k,vel,lo=55,hi=66,skip_modes=()):
  low=58
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR
    if b==len(s.bars)-1 or mode=='final':
      v=s.voicing(c[0],low,lo,hi)[:3]
      for j,p in enumerate(sorted(v)): s.add(k,t0+j*18,BAR,p,vel+4,2)
      continue
    for beat in range(4):
      cc=c[0] if (len(c)==1 or beat<2) else c[1]
      v=sorted(set(s.voicing(cc,low,lo,hi)[:3])); low=v[0]
      for j,p in enumerate(v): s.add(k,t0+beat*Q+j*14,Q*0.42,p,vel+(8 if beat in(1,3) else 0)+s.R.randint(-4,2),3)
def tuba(s,k,vel,lo=29,hi=46,skip_modes=()):
  "two-beat with pickups and short walk-ups into new chords"
  prev=36
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR; last=b==len(s.bars)-1
    if last or mode=='final': s.add(k,t0,BAR*1.3,s.near(prev,[c[0][0]],lo,hi-6),vel+4); continue
    nxt=s.bars[b+1][0][0]
    r,q=c[0]; R=s.near(prev,[r],lo,hi-4)
    r2,q2=c[1] if len(c)==2 else c[0]
    F=s.near(R+(7 if len(c)==1 else 0),[(r2+7)%12] if len(c)==1 else [r2],lo,hi)
    s.add(k,t0,Q*1.5,R,vel,4); s.add(k,t0+2*Q,Q*1.2,F,vel-6,4)
    if nxt!=c[-1] and s.R.random()<.6:
      T=s.near(F,[nxt[0]],lo,hi); a=T+(1 if F>T else -1)
      s.add(k,t0+3*Q,Q*0.45,s.near(F,[(r2+CT[q2][1])%12],lo,hi),vel-14,3); s.add(k,t0+3*Q+s.SW,Q*0.4,a,vel-10,3)
    elif s.R.random()<.35: s.add(k,t0+s.et(5),Q*0.4,s.near(R,[(r+CT[q][1])%12],lo,hi),vel-16,3)
    prev=F
# ---------- funk (straight 16ths) ----------
def funkdrums(s,vel=80,modes_vel=None,tacet_modes=(),light_modes=()):
  starts=[x['startBar']-1 for x in s.sections]
  K=[[0,7,10],[0,3,8,10],[0,7,10,13],[0,6,8,11]]
  for b,(c,name,mode) in enumerate(s.bars):
    t0=b*BAR; dv=(modes_vel or {}).get(mode,0); v=vel+dv; last=b==len(s.bars)-1
    if mode in tacet_modes: continue
    if last or mode=='final': s.add('drums',t0,2500,49,v,0); s.add('drums',t0,300,36,v,0); continue
    if b in starts and b>0: s.add('drums',t0,1500,49,v-6,2)
    light=mode in light_modes
    for i in K[b%4] if not light else [0,10]: s.add('drums',t0+i*S16,120,36,v-(0 if i in(0,10) else 10),3)
    for i in(4,12): s.add('drums',t0+i*S16,120,38 if not light else 37,v-2+s.R.randint(-3,3),3)
    for i in(7,9,15):
      if s.R.random()<.55 and not light: s.add('drums',t0+i*S16,60,38,v-40+s.R.randint(-5,5),3)
    for i in range(16):
      if b%2==1 and i==14: s.add('drums',t0+i*S16,220,46,v-18,2); continue
      if b%2==1 and i==15: continue
      s.add('drums',t0+i*S16,60,42,v-(14 if i%4==0 else 22 if i%2==0 else 34)+s.R.randint(-4,4),3)
    nb=b+1
    if nb in starts and nb<len(s.bars):
      for j,p in enumerate([38,38,47,45,45,41]): s.add('drums',t0+(10+j)*S16,80,p,v-16+j*3,2)
def funkbass(s,k,vel,lo=28,hi=50,skip_modes=()):
  prev=31
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR; last=b==len(s.bars)-1
    if last or mode=='final': s.add(k,t0,BAR,s.near(prev,[c[0][0]],lo,40),vel+4); continue
    nxt=s.bars[b+1][0][0]
    def ev(i,p,l,dv=0): s.add(k,t0+i*S16,l*S16*0.9,p,vel+dv+s.R.randint(-4,3),2)
    r,q=c[0]; R=s.near(prev,[r],lo,40)
    if len(c)==1:
      pat=b%2
      ev(0,R,3,6); ev(3,R+12,1,-14); ev(6,s.near(R+7,[(r+7)%12],R,R+9),2,-4)
      if pat: ev(8,R,1); ev(10,s.near(R+10,[(r+CT[q][3])%12],R,R+12),1,-6); ev(11,s.near(R+12,[r],R+10,R+14),2,-2)
      else: ev(8,R,2); ev(10,s.near(R+3,[(r+CT[q][1])%12],R,R+6),1,-6)
      T=s.near(R,[nxt[0]],lo,40); ev(14,T-1 if T>R else T+1,1,-6); ev(15,T+(0 if s.R.random()<.5 else (2 if T<40 else -2)),1,-10)
      prev=T
    else:
      (r2,q2)=c[1]; R2=s.near(R,[r2],lo,42)
      ev(0,R,3,6); ev(3,R+12,1,-14); ev(6,s.near(R+7,[(r+7)%12],R,R+9),2,-4)
      ev(8,R2,3,2); ev(11,R2+12,1,-14); T=s.near(R2,[nxt[0]],lo,40); ev(14,s.near(R2+7,[(r2+7)%12],R2,R2+9),1,-6); ev(15,T+1 if T<R2 else T-1,1,-8)
      prev=T
def rhodes(s,k,vel,lo=52,hi=63,skip_modes=(),sparse_modes=()):
  low=55
  P=[[(0,6),(10,4)],[(2,2),(6,6)],[(0,3),(6,2),(10,6)],[(3,3),(10,2),(14,2)],[(0,8),(11,3)],[(2,4),(8,6)]]
  for b,(c,name,mode) in enumerate(s.bars):
    if mode in skip_modes: continue
    t0=b*BAR; last=b==len(s.bars)-1
    if last or mode=='final':
      v=s.voicing(c[0],low,lo,hi)
      for j,p in enumerate(v): s.add(k,t0+j*20,BAR*1.5,p,vel+4,2)
      continue
    pat=s.R.choice(P if mode not in sparse_modes else P[:2]+[P[4]])
    for i,l in pat:
      cc=c[0] if (len(c)==1 or i<8) else c[1]
      if i>=14 and b+1<len(s.bars): cc=s.bars[b+1][0][0]
      v=s.voicing(cc,low,lo,hi); low=v[0]
      for j,p in enumerate(sorted(set(v))): s.add(k,t0+i*S16+j*8,l*S16*0.85,p,vel+(6 if i%4 else 0)+s.R.randint(-4,3),3)
