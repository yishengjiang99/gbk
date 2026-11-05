# Velvet Rae - "Amber Hold": quiet-storm neo-soul, 80 BPM 4/4, Db major -> D major final. usage: generate.py REV [nolead]
import json,random,sys,itertools,uuid,time
REV=int(sys.argv[1]); NOLEAD=len(sys.argv)>2; random.seed(1105+REV)
TITLE="Amber Hold"; SLUG="amber-hold"
PPQ=480; S=PPQ//4; BAR=16*S; BPM=80
SW=int(S*0.17)  # ~17% swung 16ths
Q={'maj9':[4,7,11,14],'m11':[3,10,14,17],'m9':[3,7,10,14],'13':[4,10,14,21],'9':[4,10,14],'7#9':[4,10,15],'7b9':[4,10,13],
   'm7b5':[3,6,10],'dim7':[3,6,9],'13sus':[5,10,14,21],'m6':[3,7,9,14],'maj9#11':[4,11,14,18],'m7':[3,7,10],'7alt':[4,10,15,20],
   '7b9#9':[4,10,13,15],'13#11':[4,10,18,21],'13sus4':[5,10,14,21],'sus':[5,7,10],'6':[4,7,9],'m13':[3,10,14,21]}
PC={'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
NOTE=['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B']
def split(s): r=s[:2] if len(s)>1 and s[1] in 'b#' else s[:1]; return r,s[len(r):]
def ch(s): r,q=split(s); return (PC[r],Q[q])
def tp(prog,k): return [[NOTE[(PC[split(c)[0]]+k)%12]+split(c)[1] for c in bar] for bar in prog]

# Harmony palette in Db major
INTRO=[['Dbmaj9'],['Cm11','F13'],['Bbm11'],['Ebm9','Ab13']]
VERSE=[['Dbmaj9'],['Cm11','F13'],['Bbm11'],['Gbmaj9'],['Dbmaj9'],['F7#9'],['Bbm6','Eb13'],['Ab13sus','Ab7b9']]
PRE=[['Gbmaj9'],['F7#9'],['Bbm11','Eb13'],['G13','C7alt']]
CHOR=[['Dbmaj9'],['Cm11','F13'],['Bbm11'],['Ebm9','Ab13'],['Gbmaj9'],['F7#9'],['Bbm6','Eb13'],['Ab13sus','Ab7b9']]
BRID=[['Emaj9'],['Ebm9'],['Dmaj9'],['C#m11','F#13'],['Cmaj9'],['Bm11'],['Bbmaj9'],['D13sus','D7#9']]
# Final chorus in D major (+1)
FIN=tp(CHOR,1)
FIN2=FIN[:4]+([['Em9','A13'],['Gmaj9'],['F#7#9'],['Em6','A13']] if REV>=3 else FIN[4:])
if REV>=4: FIN2=[['Em11'],['Bb13'],['Gmaj9'],['A13sus','A7b9']]+FIN2[4:]
FINAL=FIN+FIN2
OUT=[['Dmaj9'],['Em11','A13'],['Gmaj9'],['Dmaj9']]

form=[('Intro',INTRO,.16 if REV<4 else .18),('Verse 1',VERSE,.42),('Pre-Chorus',PRE,.58),('Chorus',CHOR,.72),
      ('Verse 2',VERSE,.56),('Pre-Chorus 2',PRE,.68),('Chorus 2',CHOR,.78),('Bridge',BRID,.34 if REV<4 else .38),
      ('Final Chorus',FINAL,1.0),('Outro',OUT,.14)]
bars=[];secs=[];b=1
for n,p,e in form:
  secs.append({"name":n,"startBar":b,"bars":len(p),"energy":e})
  for k,c in enumerate(p): bars.append(dict(sec=n,e=e,chords=c,k=k,last=k==len(p)-1))
  b+=len(p)

TR=['Guitar','Rhodes','Bass','Drums','Skank','Pad','Oohs','Strings']; N={i:[] for i in range(len(TR))}
LATE={0:8,1:12,2:16,4:6,5:4,6:10,7:8}  # laid-back: kick early via drum off, snare late
def T(t,j=5,off=0):
  i,r=divmod(t,S); t2=t+(SW if i%2 and r==0 else 0); return max(0,t2+off+random.randint(-j,j))
def add(tr,t,d,p,v,j=5,off=None,raw=False):
  o=LATE.get(tr,0) if off is None else off
  N[tr].append({"trackId":"$track[%d]"%tr,"tick":(max(0,t) if raw else T(t,j,o)),"duration":max(20,int(d)),"pitch":int(p),"velocity":max(1,min(127,int(v+random.randint(-5,5))))})
def chord_at(g):
  bb=bars[min(len(bars)-1,g//16)]; c=bb['chords'][0 if len(bb['chords'])==1 else (g%16)//8]; r,iv=ch(c); return r,iv,c
def tones(g): r,iv,_=chord_at(g); return {r}|{(r+x)%12 for x in iv}
def snap(g,p):
  t=tones(g); return min([q for q in range(p-3,p+4) if q%12 in t],key=lambda q:(abs(q-p),q))
prev=[61,65,68,72]
def voice(root,iv,lo=55,hi=79):
  global prev
  base=[(root+x)%12 for x in iv]; best=None
  for start in range(lo,lo+12):
   for order in set(itertools.permutations(base)):
    v=[];cur=start-1
    for pc_ in order:
      n=cur+1
      while n%12!=pc_: n+=1
      v.append(n);cur=n
    if v[-1]>hi or v[-1]-v[0]>16: continue
    cost=sum(abs(a-b) for a,b in zip(v,sorted(prev+[prev[-1]]*4)[:len(v)]))
    if best is None or cost<best[0]: best=(cost,v)
  if best is None:
    v=[lo+((root+x-lo)%12) for x in iv[:4]]; prev=v; return v
  prev=best[1]; return best[1]
def B(k,ns): return [(k*16+s,d,p) for s,d,p in ns]

# Hook head: Ab-Bb-Db falling C-Bb  (+2,+3,-1,-2)  Ab4=68
HEAD=[(2,1,68),(4,2,70),(6,5,73),(12,2,72),(14,2,70)]
HOOK=B(0,HEAD)+B(1,[(0,4,70),(4,2,68),(6,6,65),(14,2,63)]) \
 +B(2,[(0,2,65),(2,2,68),(4,6,70),(10,2,68),(12,4,65)])+B(3,[(2,1,65),(4,2,68),(6,2,70),(8,6,73),(14,2,70)]) \
 +B(4,[(2,1,68),(4,2,70),(6,2,73),(8,6,75),(14,2,73)])+B(5,[(0,4,75),(4,2,72),(6,2,70),(8,4,68),(12,4,65)]) \
 +B(6,[(0,2,68),(2,2,70),(4,4,73),(8,4,70),(12,2,68),(14,2,70)])+B(7,[(0,6,68),(6,2,65),(8,4,70),(12,4,68)])
HOOK_B=[x for x in HOOK if x[0]<64]+B(4,[(2,1,68),(4,2,70),(6,2,73),(8,2,75),(10,6,77)])+B(5,[(0,4,75),(4,2,73),(6,2,70),(8,4,68),(12,4,65)]) \
 +B(6,[(0,2,68),(2,2,70),(4,4,73),(8,4,75),(12,2,73),(14,2,70)])+B(7,[(0,4,70),(4,2,68),(6,2,65),(8,8,68)])

def verse_mel(v2):
  # inverted hook: Db-Bb-Ab climb Bb-Db  (-3,-2,+2,+3)
  m=B(0,[(2,2,73),(4,2,70),(6,2,68),(8,2,70),(10,4,73)])+B(1,[(2,2,70),(4,2,68),(6,4,65),(10,2,68),(12,2,70)]) \
   +B(2,[(0,4,68),(4,2,65),(6,6,61)])+B(3,[(2,2,63),(4,2,65),(6,2,68),(8,4,70),(12,4,72)])
  m2=B(4,[(2,2,73),(4,2,70),(6,2,68),(8,2,70),(10,4,73)])+B(5,[(2,2,72),(4,2,70),(6,4,68),(12,4,75)]) \
   +B(6,[(0,4,73),(4,2,70),(6,2,68),(8,4,72),(12,2,68),(14,2,65)])+B(7,[(0,4,68),(4,4,65),(8,4,63),(12,4,68)])
  return m+[(g,d,p+(100 if v2 else 0)) for g,d,p in m2]

PREM=B(0,[(2,1,65),(4,2,68),(6,6,70),(12,2,68),(14,2,70)])+B(1,[(2,1,68),(4,2,70),(6,2,73),(8,4,75),(12,4,73)]) \
 +B(2,[(2,1,70),(4,2,73),(6,6,77),(12,4,75)])+B(3,[(0,6,77),(6,2,73),(8,4,72),(12,4,73)])
BRM=B(0,[(0,6,76),(6,2,79),(8,8,83)])+B(1,[(0,8,79),(8,4,76),(12,4,74)])+B(2,[(0,6,74),(6,2,77),(8,8,81)])+B(3,[(0,8,78),(8,4,76),(12,4,73)]) \
 +B(4,[(0,6,72),(6,2,76),(8,8,79)])+B(5,[(0,8,76),(8,8,73)])+B(6,[(0,6,70),(6,2,74),(8,8,77)])+B(7,[(0,8,74),(8,4,72),(12,4,73)])
OUTM=B(0,[(2,1,69),(4,2,71),(6,10,74)])+B(1,[(4,2,73),(6,8,71)])+B(2,[(2,1,69),(4,2,71),(6,6,74),(12,4,71)])+B(3,[(0,16,69)])
INTM=B(2,[(2,1,68),(4,2,70),(6,8,73)])+B(3,[(0,4,70),(4,2,68),(6,8,65)])  # Rhodes tease of hook

sec_start={}
for i,bb in enumerate(bars): sec_start.setdefault(bb['sec'],i)
mel=[]
for n,p,e in form:
  g0=sec_start[n]*16
  if n=='Final Chorus': ph=[(s,d,q+1) for s,d,q in HOOK]+[(s+128,d,q+1) for s,d,q in HOOK_B]
  elif n in('Chorus','Chorus 2'): ph=HOOK
  elif n.startswith('Verse'): ph=verse_mel(n=='Verse 2')
  elif n.startswith('Pre'): ph=PREM
  elif n=='Bridge': ph=BRM
  elif n=='Outro': ph=OUTM
  else: ph=[]
  for s,d,pp in ph:
    raw=snap(g0+s,pp-96) if pp>=100 else pp
    # only snap half-step clashes (keep designed hook contour)
    if raw%12 not in tones(g0+s) and any((raw-x)%12==1 for x in tones(g0+s)):
      raw=snap(g0+s,raw)
    mel.append((g0+s,d,raw,n,e))
for g,d,p,n,e in mel:
  v_=(72+36*e) if n!="Outro" else 58
  if REV>=2: v_+=(8 if n in('Chorus','Chorus 2') else 14 if n=='Final Chorus' else -14 if n=='Bridge' else 2 if n.startswith('Verse') else 0)
  if REV>=3: v_+=(-4 if n in('Bridge','Outro') else 6 if n=='Final Chorus' else -2 if n in('Chorus','Chorus 2') else 0)
  if REV>=4: v_+=(4 if n=='Final Chorus' else -4 if n=='Chorus 2' else -6 if n=='Intro' else 0)
  add(0,g*S,d*S-30,p,v_,2)
# oohs echo hook head in late choruses
for n in('Chorus 2','Final Chorus'):
  k=1 if n=='Final Chorus' else 0
  for b_ in range(1,len(dict((f[0],f[1]) for f in form)[n]),4):
    g0=(sec_start[n]+b_)*16
    for s,d,p in [(8,1,68),(10,2,70),(12,4,73)]: add(6,(g0+s)*S,d*S,snap(g0+s,p+k-12),58+8*(1 if n=='Final Chorus' else 0))
# Rhodes intro tease
for s,d,p in INTM: add(1,s*S,d*S,p,72 if REV<3 else 86,4)

# ---- comping ----
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']; cs=bb['chords']; half=len(cs)==2
  for h,c in enumerate(cs):
    root,iv,_=chord_at(i*16+h*8); ts=t0+h*8*S; L=(8 if half else 16); v=voice(root,iv)
    lh=36+((root-36)%12)
    if lh<40: lh+=12
    if lh>50: lh-=12
    roll=lambda t,dur,vel,vs=v: [add(1,t+k*8,dur,p,vel-k*2) for k,p in enumerate(vs)]
    if sec in('Intro','Bridge','Outro'):
      roll(ts,L*S-40,(32+24*e) if sec=='Intro' else (44+32*e))
      if not half and sec!='Outro': roll(ts+10*S,6*S-40,(22+16*e) if sec=='Intro' else (32+22*e),v[1:])
    else:
      hits=[(0,5 if half else 6)]+([(6,2)] if not half else [(5,3)])+([(10,5)] if not half else [])
      if REV>=2 and not half:
        hits=[[(0,6),(6,2),(10,5)],[(0,3),(3,4),(10,2),(12,3)],[(0,7),(7,3),(11,4)],[(0,2),(2,4),(6,2),(10,4)]][bb['k']%4]
      if REV>=2 and half: hits=[(0,4),(5,3)] if bb['k']%2 else [(0,3),(3,2),(6,2)]
      for s,d in hits: roll(ts+s*S,d*S-30,(58 if s==0 else 42)+28*e)
    # bass
    if sec=='Intro' and bb['k']<2: continue
    nxt=bars[min(len(bars)-1,i+1)]['chords'][0] if h==len(cs)-1 else cs[h+1]; nr=ch(nxt)[0]
    nb=36+((nr-36)%12)
    if nb>47: nb-=12
    blh=lh
    if blh>47: blh-=12
    if sec=='Outro' and bb['k']==3: add(2,ts,L*S,blh,80); continue
    if sec=='Bridge': pat=[(0,14,blh),(14,2,blh+12 if bb['k']%2 else blh+7)]
    elif half: pat=[(0,5,blh),(6,1,blh+12),(7,1,nb+(1 if nb<=blh else -1))]
    else:
      pat=[(0,6,blh),(7,2,blh+7),(10,3,blh+12 if e>=.75 else blh)]
      if REV>=2: pat=[[(0,6,blh),(7,2,blh+7),(10,3,blh)],[(0,3,blh),(3,1,blh+12),(6,4,blh+7),(11,2,blh+10)],[(0,7,blh),(7,1,blh),(10,4,blh+7)],[(0,6,blh),(6,1,blh+12),(8,2,blh+7),(10,2,blh+10),(12,2,blh+7)]][bb['k']%4]
      pat+=[(15,1,nb+(1 if nb<=blh else -1))]
    for s,d,p in pat: add(2,ts+s*S,d*S-20,p,(92 if s==0 else 70)*((.78+.28*e) if REV<3 else (.70+.38*e)),4)
    # warm pad
    if sec in('Intro','Chorus','Chorus 2','Final Chorus','Bridge','Outro') or (REV>=2 and sec.startswith('Pre')):
      pv=(14+18*e) if sec=='Intro' else (18+24*e)*(1.2 if sec=='Final Chorus' else 0.85 if sec=='Bridge' else 1)
      for p in sorted(v)[-3:]: add(5,ts,L*S-30,p,pv)
    # strings
    if REV>=3 and sec=='Intro':
      for p in sorted(v)[-3:]: add(7,ts,L*S-20,p+12,26)
    if sec in(('Bridge','Final Chorus')+(('Pre-Chorus 2','Chorus 2') if REV>=2 else ())):
      for p in sorted(v)[-3:]: add(7,ts,L*S-20,p+12,(26+42*e)*(.55+.2*bb['k'] if sec.startswith('Pre') else 1))
    # oohs pad in final
    if sec=='Final Chorus':
      for p in sorted(v)[-3:]: add(6,ts,L*S-20,p,(32+26*e)*(1.2 if REV>=3 else 1))
    # sparse clean-guitar skanks (track 4) in choruses
    if sec in('Chorus','Chorus 2','Final Chorus'):
      tv=sorted(v)
      for s in range(L):
        hit = (s%4==3 or s%8==6) if REV==1 else (s%8==6 or (sec=='Final Chorus' and s%4==3))
        if hit:
          add(4,ts+s*S,S//2,tv[-1]+12,(22 if s%2 else 36)+12*e,4)
          add(4,ts+s*S,S//2,tv[-2]+12,(18 if s%2 else 30)+12*e,4)
  # guitar answer licks (lead rests) — uses skank track mid register answers in v2+
  if REV>=2 and sec in('Verse 2','Chorus 2','Final Chorus') and bb['k']%2==1:
    g=i*16+12; tv=sorted(voice(*chord_at(g)[:2])); prev[:]=tv
    lick=[snap(g,p) for p in (tv[-1]+12,tv[-2]+12,tv[-1]+12,tv[-1]+14)]
    for k,p in enumerate(lick): add(4,t0+(12+k)*S,S if k<3 else 2*S,p,52+16*e-(6 if k%2 else 0),3)

# ---- drums: quiet-storm — kick early, snare late, cross-stick verses ----
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']
  if sec=='Intro' and bb['k']<2:
    if REV>=2:
      for s in range(0,16,2): add(3,t0+s*S,50,42,(36 if s%4==0 else 22),8,off=-4)
    continue
  if sec=='Outro':
    if bb['k']==0: add(3,t0,PPQ*4,49,42,off=0)
    continue
  hard=e>=.70 or sec in('Chorus','Chorus 2','Final Chorus'); brk=sec=='Bridge' and bb['k']<4
  if REV>=3 and sec=='Bridge' and bb['last']:
    for k in range(16): add(3,t0+k*S,S,38,28+k*5,2)
    add(3,t0,S,36,94,2,off=-12); add(3,t0+8*S,S,36,90,2,off=-12)
    continue
  if REV>=2 and sec.startswith('Pre') and bb['last']:
    add(3,t0,S,36,100,2,off=-12); add(3,t0,PPQ*2,49,56,off=0)
    for k in range(8): add(3,t0+(8+k)*S,S,38,32+k*9,2)
    continue
  # shaker from verse 2
  if REV>=2 and sec in('Verse 2','Chorus 2','Final Chorus','Pre-Chorus 2'):
    for s in range(16): add(3,t0+s*S,40,70,24+(14 if s%2==0 else 0)+(6 if s%4==2 else 0),5,off=-4)
  if REV>=2 and sec=='Final Chorus':
    for s in (4,12): add(3,t0+s*S,S,54,66,3,off=18)  # tambourine
  kick=[0,10] if brk else [0,7,10]+([14] if hard and bb['k']%2 else [])
  for s in kick: add(3,t0+s*S,S,36,(102 if s==0 else 84)*(.82+.22*e),3,off=-12)
  if not brk:
    # cross-stick (37) verses; soft snare (38) choruses/pre
    sn=38 if (hard or sec.startswith('Pre') or sec=='Verse 2') else 37
    for s in (4,12): add(3,t0+s*S,S,sn,88+24*e if sn==38 else 70+18*e,3,off=22)
    if hard:
      for s in (4,12): add(3,t0+s*S,S,39,64+18*e,3,off=16)  # clap
    for s in (3,6,9,15):
      if random.random()<.30+.55*e: add(3,t0+s*S,55,38,14+random.randint(0,12),7,off=18)
  for s in range(0,16,2 if not hard else 1):
    if brk and s%4: continue
    v=(62 if s%4==0 else 46 if s%2==0 else 26)*(.60+.48*e)
    add(3,t0+s*S,50,42,v,10,off=-4)
  if hard and (bb['k']%2==1 or (REV>=3 and sec=='Final Chorus')): add(3,t0+14*S,S*2,46,52 if sec!='Final Chorus' else 64,4)
  if REV>=3 and sec=='Final Chorus': add(3,t0+7*S,S,36,76,3,off=-12)
  if bb['k']==0 and (sec in('Chorus','Chorus 2','Final Chorus','Bridge')): add(3,t0,PPQ*4,49,84 if sec=='Final Chorus' else 68,off=0)
  if bb['last'] and sec.startswith('Pre'):
    for k in range(8): add(3,t0+(8+k)*S,S,38,34+k*8,2)
  elif bb['last'] and sec not in('Outro','Final Chorus'):
    for k,s in enumerate(range(12,16)): add(3,t0+s*S,S,[38,45,43,41][k],52+k*8,3)

total=len(bars)
for k in N:
  for x in N[k]:
    e=bars[min(total-1,x['tick']//BAR)]['e']; f=(0.92+0.14*e) if k==0 else (0.66+0.40*e)
    x['velocity']=max(1,min(127,int(x['velocity']*f)))

# volumes: lead guitar prominent
vol=[108,94,88,98,58,62,70,68] if REV==1 else [127,76,72,94,36,48,68,62] if REV==2 else [122,70,66,94,30,46,72,66] if REV==3 else [118,74,68,98,30,52,84,80]
vol_steps=list(vol); 
if NOLEAD: vol_steps[0]=0
prog=[27,4,33,0,27,89,53,49]; pan=[64,52,64,64,100,40,44,86]
roles=['melody','harmony','bass','percussion','accompaniment','accompaniment','harmony','accompaniment']
tempo=[{"bar":1,"bpm":BPM},{"bar":total-1,"bpm":74},{"bar":total,"bpm":66}]
steps=[{"tool":"gbk_create_project","args":{"name":TITLE,"tempo":BPM,"timeSignature":[4,4],"key":"Db major","ppq":PPQ,"replaceCurrent":True}}]
steps+=[{"tool":"gbk_create_track","args":{"name":TR[k],"program":prog[k],"role":roles[k],"pan":pan[k],"volume":vol_steps[k]}} for k in range(len(TR))]
steps+=[{"tool":"gbk_set_tempo_map","args":{"events":tempo}},{"tool":"gbk_set_song_structure","args":{"sections":secs}}]
alln=[n for k in N for n in N[k]]
for i in range(0,len(alln),1500): steps+=[{"tool":"gbk_propose_note_patch","args":{"add":alln[i:i+1500]}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[7]"],"controller":11,"shape":"crescendo","from":50,"to":120,"range":{"unit":"bars","start":sec_start['Bridge']+1,"end":sec_start['Final Chorus']+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}},
        {"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[5]","$track[6]","$track[7]"],"controller":11,"shape":"decrescendo","from":120,"to":40,"range":{"unit":"bars","start":total-1,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
name=f"v{REV}"+("nl" if NOLEAD else "")
json.dump({"title":TITLE,"slug":SLUG,"composer":"Velvet Rae","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":4}},open(f"/workspace/vr7/{name}.json","w"))
if not NOLEAD:
  json.dump({"bars":[{"sec":b['sec']} for b in bars],"bpm":BPM,"notes":{TR[k]:N[k] for k in N},"prog":prog,"vol":vol,"pan":pan,"roles":roles,"secs":secs,"tempo":tempo,"title":TITLE},open(f"/workspace/vr7/n{REV}.json","w"))

# Also emit project.json-ready structure + MIDI via companion
cl=[(n,g//16+1,chord_at(g)[2],p) for g,d,p,n,e in mel if d>=2 and p%12 not in tones(g) and any((p-x)%12==1 for x in tones(g))]
print("rev",REV,"bars",total,"notes",len(alln),"sec",round(total*240/BPM),"clashes",len(cl),cl[:12])
