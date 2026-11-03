# Velvet Rae - "Sugar in the Static": Dilla-feel neo-soul, 86 BPM 4/4, E minor (dorian) -> G minor final chorus. usage: gen.py REV [nolead]
import json,random,sys,itertools
REV=int(sys.argv[1]); NOLEAD=len(sys.argv)>2; random.seed(1103)
TITLE="Sugar in the Static"; SLUG="sugar-in-the-static"
PPQ=480; S=PPQ//4; BAR=16*S; BPM=86
SW=int(S*0.22)                                   # drunk 16th swing: offbeat 16ths late
Q={'maj9':[4,7,11,14],'m11':[3,10,14,17],'m9':[3,7,10,14],'13':[4,10,14,21],'9':[4,10,14],'7#9':[4,10,15],'7b9':[4,10,13],
   'm7b5':[3,6,10],'dim7':[3,6,9],'13sus':[5,10,14,21],'m6':[3,7,9,14],'maj9#11':[4,11,14,18],'m7':[3,7,10],'7alt':[4,10,15,20],'7b9#9':[4,10,13,15],'13#11':[4,10,18,21]}
PC={'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
NOTE=['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B']
def split(s): r=s[:2] if len(s)>1 and s[1] in 'b#' else s[:1]; return r,s[len(r):]
def ch(s): r,q=split(s); return (PC[r],Q[q])
def tp(prog,k): return [[NOTE[(PC[split(c)[0]]+k)%12]+split(c)[1] for c in bar] for bar in prog]
INTRO=[['Em11'],['A13'],['Cmaj9'],['F#m7b5','B7b9']]
VERSE=[['Em11'],['A13'],['Gmaj9'],['F#m7b5','B7#9'],['Em11'],['A13'],['Cmaj9','F9'],['Am11','D13']]
PRE=[['Cmaj9'],['Bm11','E7b9'],['Am11'],['Cm6','B7#9']]
CHOR=[['Cmaj9'],['B7#9' if REV<4 else 'B7b9#9'],['Em11','A13'],['Dm9','G13'],['Cmaj9'],['Cm6','F13'],['Em11','A13'],['Am11','B7b9']]
BRID=[['Bbmaj9'],['Am11'],['Abmaj9'],['G13'],['Fmaj9'],['Em11'],['Ebmaj9#11'],['D13sus','D7#9']]
FIN=tp(CHOR,3); FIN2=FIN[:7]+[['Cm11','D7alt']]
if REV>=4: FIN2=[['Cm11'],['Ab13#11']]+FIN2[2:5]+[['Abmaj9','Db13']]+FIN2[6:]   # reharmonized hook restatement
FINAL=FIN+FIN2
OUT=[['Gm11'],['C13'],['Ebmaj9'],['Gm9']]
form=[('Intro',INTRO,.2 if REV<5 else .32),('Verse 1',VERSE,.4),('Pre-Chorus',PRE,.55),('Chorus',CHOR,.8),
      ('Verse 2',VERSE,.5),('Pre-Chorus 2',PRE,.62),('Chorus 2',CHOR,.88),('Bridge',BRID,.45),
      ('Final Chorus',FINAL,1.0),('Outro',OUT,.25)]
bars=[];secs=[];b=1
for n,p,e in form:
  secs.append({"name":n,"startBar":b,"bars":len(p),"energy":e})
  for k,c in enumerate(p): bars.append(dict(sec=n,e=e,chords=c,k=k,last=k==len(p)-1))
  b+=len(p)
TR=['Harmonica','Rhodes','Bass','Drums','Guitar','Scratch','Oohs','Strings']; N={i:[] for i in range(len(TR))}
LATE={0:0,1:10,2:14,4:6,5:0,6:12,7:10}            # laid-back offsets per track (ticks)
def T(t,j=6,off=0):
  i,r=divmod(t,S); t2=t+(SW if i%2 and r==0 else 0); return max(0,t2+off+random.randint(-j,j))
def add(tr,t,d,p,v,j=6,off=None,raw=False):
  o=LATE.get(tr,0) if off is None else off
  N[tr].append({"trackId":"$track[%d]"%tr,"tick":(max(0,t) if raw else T(t,j,o)),"duration":max(20,int(d)),"pitch":int(p),"velocity":max(1,min(127,int(v+random.randint(-6,6))))})
def chord_at(g):
  bb=bars[min(len(bars)-1,g//16)]; c=bb['chords'][0 if len(bb['chords'])==1 else (g%16)//8]; r,iv=ch(c); return r,iv,c
def tones(g): r,iv,_=chord_at(g); return {r}|{(r+x)%12 for x in iv}
def snap(g,p):
  t=tones(g); return min([q for q in range(p-3,p+4) if q%12 in t],key=lambda q:(abs(q-p),q))
prev=[60,64,67,71]
def voice(root,iv,lo=(52 if REV==1 else 55),hi=(76 if REV==1 else 79)):
  global prev
  base=[(root+x)%12 for x in iv]; best=None
  for start in range(lo,lo+12):
   for order in set(itertools.permutations(base)):
    v=[];cur=start-1
    for pc in order:
      n=cur+1
      while n%12!=pc: n+=1
      v.append(n);cur=n
    if v[-1]>hi or v[-1]-v[0]>15: continue
    cost=sum(abs(a-b) for a,b in zip(v,sorted(prev+[prev[-1]]*4)[:len(v)]))
    if best is None or cost<best[0]: best=(cost,v)
  prev=best[1]; return best[1]
def B(k,ns): return [(k*16+s,d,p) for s,d,p in ns]
# ---- melody (16 steps per bar) ----  hook head: B-D-E~-D-B (+3,+2,-2,-3)
HEAD=[(2,1,71),(4,2,74),(6,5,76),(12,2,74),(14,2,71)]
HOOK=B(0,HEAD)+B(1,[(0,4,74),(4,2,72),(6,6,71),(14,2,67)]) \
 +B(2,[(0,2,69),(2,2,71),(4,6,74),(10,2,71),(12,4,69)])+B(3,[(2,1,69),(4,2,72),(6,2,74),(8,6,76),(14,2,74)]) \
 +B(4,[(2,1,71),(4,2,74),(6,2,76),(8,6,79),(14,2,78)])+B(5,[(0,4,79),(4,2,75),(6,2,74),(8,4,72),(12,4,69)]) \
 +B(6,[(0,2,71),(2,2,74),(4,4,76),(8,4,73),(12,2,71),(14,2,73)])+B(7,[(0,6,72),(6,2,71),(8,4,75),(12,4,71)])
HOOK_B=[x for x in HOOK if x[0]<64]+B(4,[(2,1,71),(4,2,74),(6,2,76),(8,2,79),(10,6,83)])+B(5,[(0,4,81),(4,2,79),(6,2,75),(8,4,74),(12,4,72)]) \
 +B(6,[(0,2,71),(2,2,74),(4,4,76),(8,4,78),(12,2,76),(14,2,73)])+B(7,[(0,4,74),(4,2,72),(6,2,71),(8,8,71)])
def verse_mel(v2):
  m=B(0,[(2,2,67),(4,1,69),(5,3,71),(10,2,69),(12,4,67)])+B(1,[(2,2,76),(4,2,73),(6,4,71),(10,2,73),(12,2,76)]) \
   +B(2,[(0,4,74),(4,2,71),(6,6,66)])+B(3,[(2,2,69),(4,2,72),(6,2,69),(8,4,74),(12,4,75)])
  m2=B(4,[(2,2,67),(4,1,69),(5,3,71),(8,2,74),(10,6,71)])+B(5,[(2,2,76),(4,2,73),(6,4,71),(12,4,78)]) \
   +B(6,[(0,4,76),(4,2,74),(6,2,71),(8,4,75),(12,2,72),(14,2,69)])+B(7,[(0,4,72),(4,4,67),(8,4,66),(12,4,71)])
  return m+[(g,d,p+(100 if v2 else 0)) for g,d,p in m2]   # +100 = shift up a chord-tone third, resolved below
PREM=B(0,[(2,1,67),(4,2,71),(6,6,74),(12,2,71),(14,2,74)])+B(1,[(2,1,69),(4,2,73),(6,2,76),(8,4,77),(12,4,76)]) \
 +B(2,[(2,1,72),(4,2,76),(6,6,79),(12,4,76)])+B(3,[(0,6,79),(6,2,75),(8,4,74),(12,4,75)])
BRM=B(0,[(0,6,74),(6,2,77),(8,8,81)])+B(1,[(0,8,79),(8,4,76),(12,4,74)])+B(2,[(0,6,72),(6,2,75),(8,8,79)])+B(3,[(0,8,76),(8,4,74),(12,4,71)]) \
 +B(4,[(0,6,69),(6,2,72),(8,8,76)])+B(5,[(0,8,74),(8,8,71)])+B(6,[(0,6,74),(6,2,77),(8,8,81)])+B(7,[(0,8,79),(8,4,77),(12,4,78)])
OUTM=B(0,[(2,1,74),(4,2,77),(6,10,79)])+B(1,[(4,2,76),(6,8,74)])+B(2,[(2,1,74),(4,2,77),(6,6,79),(12,4,77)])+B(3,[(0,16,74)])
INTM=B(2,[(2,1,71),(4,2,74),(6,8,76)])+B(3,[(0,4,74),(4,2,72),(6,8,71)])
sec_start={}
for i,bb in enumerate(bars): sec_start.setdefault(bb['sec'],i)
mel=[]
for n,p,e in form:
  g0=sec_start[n]*16
  if n=='Final Chorus': ph=[(s,d,q+3) for s,d,q in HOOK]+[(s+128,d,q+3) for s,d,q in HOOK_B]
  elif n in('Chorus','Chorus 2'): ph=HOOK
  elif n.startswith('Verse'): ph=verse_mel(n=='Verse 2')
  elif n.startswith('Pre'): ph=PREM
  elif n=='Bridge': ph=BRM
  elif n=='Outro': ph=OUTM
  else: ph=[]
  for s,d,pp in ph: mel.append((g0+s,d,snap(g0+s,pp-96) if pp>=100 else pp,n,e))
for g,d,p,n,e in mel:
  v_=(72+36*e) if n!="Outro" else 66
  if REV>=2: v_+=(8 if 'Chorus' in n and not n.startswith('Pre') else -10 if n=='Bridge' else 0)
  if REV>=3: v_+=(-6 if n in('Bridge','Outro') else 4 if n=='Final Chorus' else 0)
  add(0,g*S,d*S-25,p,v_,5)
# oohs echo the hook head where the lead holds (chorus 2, final)
for n in('Chorus 2','Final Chorus'):
  k=3 if n=='Final Chorus' else 0
  for b_ in range(1,len(dict((f[0],f[1]) for f in form)[n]),4):
    g0=(sec_start[n]+b_)*16
    for s,d,p in [(8,1,71),(10,2,74),(12,4,76)]: add(6,(g0+s)*S,d*S,snap(g0+s,p+k-12),64)
for s,d,p in INTM: add(1,s*S,d*S,p+12,70 if REV<3 else 84,4)
# ---- comping ----
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']; cs=bb['chords']; half=len(cs)==2
  for h,c in enumerate(cs):
    root,iv,_=chord_at(i*16+h*8); ts=t0+h*8*S; L=(8 if half else 16); v=voice(root,iv)
    lh=36+((root-36)%12)
    if lh<40: lh+=12
    roll=lambda t,dur,vel,vs=v: [add(1,t+k*9,dur,p,vel-k*2) for k,p in enumerate(vs)]
    # Rhodes: laid-back stabs; long chords in intro/bridge/outro
    if sec in('Intro','Bridge','Outro'):
      roll(ts,L*S-40,46+30*e)
      if REV==1 or (sec=='Intro' and bb['k']<2): add(1,ts,L*S-40,lh+12 if lh<48 else lh,44+30*e)
      if not half and sec!='Outro': roll(ts+10*S,6*S-40,34+20*e,v[1:])
    else:
      hits=[(0,5 if half else 6)]+([(6,2)] if not half else [(5,3)])+([(10,5)] if not half else [])
      if REV>=2 and not half:
        hits=[[(0,6),(6,2),(10,5)],[(0,3),(3,4),(10,2),(12,3)],[(0,7),(7,3),(11,4)],[(0,2),(2,4),(6,2),(10,4)]][bb['k']%4]
      if REV>=2 and half: hits=[(0,4),(5,3)] if bb['k']%2 else [(0,3),(3,2),(6,2)]
      for s,d in hits: roll(ts+s*S,d*S-30,(62 if s==0 else 46)+26*e)
    # bass
    if sec=='Intro' and bb['k']<2: continue
    nxt=bars[min(len(bars)-1,i+1)]['chords'][0] if h==len(cs)-1 else cs[h+1]; nr=ch(nxt)[0]
    nb=36+((nr-36)%12)
    if nb>47: nb-=12
    if lh>47: lh-=12
    if sec=='Outro' and bb['k']==3: add(2,ts,L*S,lh,84); continue
    if sec=='Bridge': pat=[(0,14,lh),(14,2,lh+12 if bb['k']%2 else lh+7)]
    elif half: pat=[(0,5,lh),(6,1,lh+12),(7,1,nb+(1 if nb<=lh else -1))]
    else:
      pat=[(0,6,lh),(7,2,lh+7),(10,3,lh+12 if e>=.75 else lh)]
      if REV>=2: pat=[[(0,6,lh),(7,2,lh+7),(10,3,lh)],[(0,3,lh),(3,1,lh+12),(6,4,lh+7),(11,2,lh+10)],[(0,7,lh),(7,1,lh),(10,4,lh+7)],[(0,6,lh),(6,1,lh+12),(8,2,lh+7),(10,2,lh+10),(12,2,lh+7)]][bb['k']%4]
      pat+=[(15,1,nb+(1 if nb<=lh else -1))]
    for s,d,p in pat: add(2,ts+s*S,d*S-20,p,(96 if s==0 else 74)*((.8+.25*e) if REV<3 else (.72+.36*e)),4)
    # strings
    if REV>=4 and sec=='Intro':
      for p in sorted(v)[-3:]: add(7,ts,L*S-20,p+12,30)
    if sec in(('Bridge','Final Chorus')+(('Pre-Chorus 2','Chorus 2') if REV>=2 else ())):
      for p in sorted(v)[-3:]: add(7,ts,L*S-20,p+12,(28+40*e)*(.6+.15*bb['k'] if sec.startswith('Pre') else 1))
    # oohs pad
    if sec in('Final Chorus',):
      for p in sorted(v)[-3:]: add(6,ts,L*S-20,p,(34+24*e)*(1 if REV<3 else 1.25))
      if REV>=2:
        for s_,d_ in hits: add(1,ts+s_*S+20,d_*S-40,max(v)+12,40+20*e)
    # muted-guitar 16th scratch in choruses
    if sec in('Chorus','Chorus 2','Final Chorus'):
      tv=sorted(v)
      for s in range(L):
        if (s%4 in(1,3) or (s%8==6)) if REV==1 else (s%4==3 or s%8==6 or (sec=='Final Chorus' and s%4==1)):
          add(5,ts+s*S,S//2,tv[-1]+12,(34 if s%2 else 50)+20*e,4); add(5,ts+s*S,S//2,tv[-2]+12,(30 if s%2 else 44)+20*e,4)
  # guitar answers after lead phrases (bars where lead rests at the end)
  if sec in('Verse 2','Chorus 2','Final Chorus') and bb['k']%2==1:
    g=i*16+12; tv=sorted(voice(*chord_at(g)[:2])); prev[:]=tv
    lick=[snap(g,p) for p in (tv[-1]+12,tv[-2]+12,tv[-1]+12,tv[-1]+14)]
    for k,p in enumerate(lick): add(4,t0+(12+k)*S,S if k<3 else 2*S,p,60+18*e-(6 if k%2 else 0),3)
# ---- drums (Dilla feel: kick early, snare late, loose hats) ----
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']
  if sec=='Intro' and bb['k']<2:
    if REV>=3:
      for s in range(0,16,2): add(3,t0+s*S,50,42,(40 if s%4==0 else 26),10,off=-4)
    continue
  if sec=='Outro':
    if bb['k']==0: add(3,t0,PPQ*4,49,48,off=0)
    continue
  hard=e>=.75; brk=sec=='Bridge' and bb['k']<4
  if REV>=3 and sec=='Bridge' and bb['last']:
    for k in range(16): add(3,t0+k*S,S,38,30+k*5,2)
    add(3,t0,S,36,96,2,off=-10); add(3,t0+8*S,S,36,96,2,off=-10)
    continue
  if REV>=2 and sec.startswith('Pre') and bb['last']:
    add(3,t0,S,36,100,2,off=-10); add(3,t0,PPQ*2,49,60,off=0)
    for k in range(8): add(3,t0+(8+k)*S,S,38,34+k*9,2)
    continue
  if REV>=2 and sec in('Verse 2','Chorus 2','Final Chorus','Pre-Chorus 2'):
    for s in range(16): add(3,t0+s*S,40,70,26+(16 if s%2==0 else 0)+(8 if s%4==2 else 0),6,off=-6)
  if REV>=2 and sec=='Final Chorus':
    for s in (4,12): add(3,t0+s*S,S,54,70,3,off=20)
  kick=[0,10] if brk else [0,7,10]+([14] if hard and bb['k']%2 else [])
  for s in kick: add(3,t0+s*S,S,36,(106 if s==0 else 88)*(.85+.2*e),3,off=-10)
  if not brk:
    sn=38 if (hard or sec.startswith('Pre') or sec=='Verse 2') else 37
    for s in (4,12): add(3,t0+s*S,S,sn,92+22*e if sn==38 else 76+20*e,3,off=24)
    if hard: 
      for s in (4,12): add(3,t0+s*S,S,39,70+20*e,3,off=18)
    for s in (3,6,9,15):
      if random.random()<.35+.5*e: add(3,t0+s*S,60,38,16+random.randint(0,14),8,off=20)
  for s in range(0,16,2 if not hard else 1):
    if brk and s%4: continue
    v=(66 if s%4==0 else 50 if s%2==0 else 28)*(.65+.45*e)
    add(3,t0+s*S,50,42,v,12,off=-4)
  if hard and (bb['k']%2==1 or (REV>=3 and sec=='Final Chorus')): add(3,t0+14*S,S*2,46,56 if sec!='Final Chorus' else 66,4)
  if REV>=3 and sec=='Final Chorus': add(3,t0+7*S,S,36,80,3,off=-10)
  if bb['k']==0 and (sec in('Chorus','Chorus 2','Final Chorus','Bridge')): add(3,t0,PPQ*4,49,90 if sec=='Final Chorus' else 74,off=0)
  if bb['last'] and sec.startswith('Pre'):
    for k in range(8): add(3,t0+(8+k)*S,S,38,36+k*8,2)
  elif bb['last'] and sec not in('Outro','Final Chorus'):
    for k,s in enumerate(range(12,16)): add(3,t0+s*S,S,[38,45,43,41][k],56+k*8,3)
total=len(bars)
for k in N:
  for x in N[k]:
    e=bars[min(total-1,x['tick']//BAR)]['e']; f=(0.9+0.12*e) if k==0 else (0.68+0.38*e)
    x['velocity']=max(1,min(127,int(x['velocity']*f)))
vol=[96,100,100,98,74,62,72,66] if REV==1 else [110,96,90,98,76,52,74,70] if REV==2 else [110,96,86,98,76,52,78,76]
if NOLEAD: vol[0]=0
prog=[22,4,33,0,27,28,53,49]; pan=[64,54,64,64,34,92,44,84]
roles=['melody','harmony','bass','percussion','accompaniment','accompaniment','harmony','accompaniment']
tempo=[{"bar":1,"bpm":BPM},{"bar":total-1,"bpm":80},{"bar":total,"bpm":72}]
steps=[{"tool":"gbk_create_project","args":{"name":TITLE,"tempo":BPM,"timeSignature":[4,4],"key":"E minor","ppq":PPQ,"replaceCurrent":True}}]
steps+=[{"tool":"gbk_create_track","args":{"name":TR[k],"program":prog[k],"role":roles[k],"pan":pan[k],"volume":vol[k]}} for k in range(len(TR))]
steps+=[{"tool":"gbk_set_tempo_map","args":{"events":tempo}},{"tool":"gbk_set_song_structure","args":{"sections":secs}}]
alln=[n for k in N for n in N[k]]
for i in range(0,len(alln),1500): steps+=[{"tool":"gbk_propose_note_patch","args":{"add":alln[i:i+1500]}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[7]"],"controller":11,"shape":"crescendo","from":50,"to":120,"range":{"unit":"bars","start":sec_start['Bridge']+1,"end":sec_start['Final Chorus']+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}},
        {"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[6]","$track[7]"],"controller":11,"shape":"decrescendo","from":120,"to":40,"range":{"unit":"bars","start":total-1,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
name=f"v{REV}"+("nl" if NOLEAD else "")
json.dump({"title":TITLE,"slug":SLUG,"composer":"Velvet Rae","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":4}},open(f"{name}.json","w"))
json.dump({"bars":[{"sec":b['sec']} for b in bars],"bpm":BPM,"notes":{TR[k]:N[k] for k in N}},open(f"n{REV}.json","w"))
cl=[(n,g//16+1,chord_at(g)[2],p) for g,d,p,n,e in mel if d>=2 and p%12 not in tones(g) and any((p-x)%12==1 for x in tones(g))]
print("rev",REV,"bars",total,"notes",len(alln),"sec",round(total*240/BPM),"clashes",len(cl),cl[:14])
