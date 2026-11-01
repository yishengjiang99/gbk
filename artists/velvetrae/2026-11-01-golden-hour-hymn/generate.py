# Velvet Rae - "Golden Hour Hymn": 6/8 gospel-soul ballad, Ab major -> Bb major lift. usage: gen.py REV [nolead]
import json,random,sys,itertools
REV=int(sys.argv[1]); NOLEAD=len(sys.argv)>2; random.seed(1101)
PPQ=480; S=PPQ//4; BAR=12*S; BPM=78            # 6/8: 12 sixteenths per bar, dotted quarter = 52
SW=int(S*(0.08 if REV==1 else 0.12))          # late offbeat 16ths
Q={'maj9':[4,7,11,14],'m11':[3,10,14,17],'m9':[3,7,10,14],'13':[4,10,14,21],'7#9':[4,10,15],'7b9':[4,10,13],
   'm7b5':[3,6,10],'dim7':[3,6,9],'13sus':[5,10,14,21],'m6':[3,7,9,14]}
PC={'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def ch(s):
  r=s[:2] if len(s)>1 and s[1] in 'b#' else s[:1]; return (PC[r],Q[s[len(r):]])
NOTE=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']
def tp(prog,k): return [[NOTE[(ch(c)[0]+k)%12]+c[len(c)-len(c.lstrip('ABCDEFG#b')) if False else (2 if len(c)>1 and c[1] in 'b#' else 1):] for c in bar] for bar in prog]
INTRO=[['Dbmaj9'],['C7#9'],['Fm11'],['Bbm9','Eb13sus']]
VERSE=[['Abmaj9'],['Gm7b5','C7b9'],['Fm11'],['Ebm9','Ab13'],['Dbmaj9'],['Ddim7'],['Abmaj9','F7#9'],['Bbm9','Eb13sus']]
PRE=[['Fm11'],['Ebm9','Ab13'],['Gbmaj9'],['Ab13sus','Ab7b9']]
CHOR=[['Dbmaj9'],['C7#9'],['Fm11','Bb13'],['Bbm9','Eb13'],['Dbmaj9'],['Dbm6','Gb13'],['Cm11','F7b9'],['Bbm9','Eb7b9']]
BRID=[['Emaj9'],['Ebm11','Ab13'],['Dbmaj9'],['Dm7b5','G7#9'],['Cm11','F7b9'],['B13','Bbm9'],['Dbmaj9','Ddim7'],['F13sus','F7#9']]
FINAL=tp(CHOR,2)*2
OUT=[['Bbmaj9'],['Ebmaj9'],['Ebm6','Ab13'],['Bbmaj9']]
PE=(.58,.66) if REV<4 else (.5,.58)
form=[('Intro',INTRO,.2),('Verse 1',VERSE,.4),('Pre-Chorus',PRE,PE[0]),('Chorus',CHOR,.8),
      ('Verse 2',VERSE,.55),('Pre-Chorus 2',PRE,PE[1]),('Chorus 2',CHOR,.88),('Bridge',BRID,.5),
      ('Final Chorus',FINAL,1.0),('Outro',OUT,.22)]
bars=[];secs=[];b=1
for n,p,e in form:
  secs.append({"name":n,"startBar":b,"bars":len(p),"energy":e})
  for k,c in enumerate(p): bars.append(dict(sec=n,e=e,chords=c,k=k,last=k==len(p)-1))
  b+=len(p)
TR=['Flute','Piano','Bass','Organ','Drums','Guitar','Choir','Strings']; N={i:[] for i in range(len(TR))}
def T(t,j=6):
  i,r=divmod(t,S); t2=t+(SW if i%2 and r==0 else 0); return max(0,t2+random.randint(-j,j))
def add(tr,t,d,p,v,j=6,raw=False):
  N[tr].append({"trackId":"$track[%d]"%tr,"tick":(max(0,t) if raw else T(t,j)),"duration":max(20,int(d)),"pitch":int(p),"velocity":max(1,min(127,int(v+random.randint(-5,5))))})
def chord_at(g):
  bb=bars[min(len(bars)-1,g//12)]; c=bb['chords'][0 if len(bb['chords'])==1 else (g%12)//6]; r,iv=ch(c); return r,iv,c
def tones(g): r,iv,_=chord_at(g); return {r}|{(r+x)%12 for x in iv}
def snap(g,p):
  t=tones(g); return min([q for q in range(p-3,p+4) if q%12 in t],key=lambda q:(abs(q-p),q))
prev=[60,63,67,70]
def voice(root,iv,lo=53,hi=77):
  global prev
  base=[(root+x)%12 for x in iv]; best=None
  for start in range(lo,lo+12):
   for order in set(itertools.permutations(base)):
    v=[];cur=start-1
    for pc in order:
      n=cur+1
      while n%12!=pc: n+=1
      v.append(n);cur=n
    if v[-1]>hi or v[-1]-v[0]>16: continue
    cost=sum(abs(a-b) for a,b in zip(v,sorted(prev+[prev[-1]]*4)[:len(v)]))
    if best is None or cost<best[0]: best=(cost,v)
  prev=best[1]; return best[1]
# ---- melody (positions/durations in 16ths, 12 per bar) ----
HEAD=[(0,3,75),(3,1,77),(4,4,80),(8,2,79),(10,2,77)]       # Eb-F-Ab hook head
def bar_(k,ns): return [(k*12+s,d,p) for s,d,p in ns]
HOOK=bar_(0,HEAD)+bar_(1,[(0,6,76),(6,2,75),(8,4,72)])+bar_(2,[(0,3,75),(3,1,77),(4,2,80),(6,3,79),(9,3,77)]) \
 +bar_(3,[(0,6,73),(6,2,72),(8,3,70)])+bar_(4,HEAD)+bar_(5,[(0,6,76),(6,3,75),(9,3,73)]) \
 +bar_(6,[(0,2,75),(2,2,77),(4,2,79),(6,4,81),(10,2,80)])+bar_(7,[(0,4,77),(4,2,75),(6,5,72)])
HOOK_B=bar_(0,[(0,3,75),(3,1,77),(4,4,82),(8,2,80),(10,2,79)])+[x for x in HOOK if 12<=x[0]<72] \
 +bar_(6,[(0,2,77),(2,2,79),(4,2,80),(6,4,84),(10,2,80)])+bar_(7,[(0,4,80),(4,2,77),(6,6,75)])
def verse_mel(v2):
  m=bar_(0,[(0,2,68),(2,2,65),(4,4,63),(8,2,65),(10,2,67)])+bar_(1,[(0,4,70),(4,2,67),(6,4,64)]) \
   +bar_(2,[(0,2,68),(2,2,67),(4,4,63),(8,2,65),(10,2,68)])+bar_(3,[(0,4,70),(4,2,73),(6,6,72)])
  if not v2:
    m+=bar_(4,[(0,2,72),(2,2,68),(4,4,65),(8,2,68),(10,2,72)])+bar_(5,[(0,4,71),(4,2,68),(6,4,65)]) \
      +bar_(6,[(0,2,72),(2,2,70),(4,4,68),(8,2,69),(10,2,72)])+bar_(7,[(0,4,73),(4,2,72),(6,6,70)])
  else:
    m+=bar_(4,[(0,2,75),(2,2,72),(4,4,68),(8,2,72),(10,2,75)])+bar_(5,[(0,4,77),(4,2,74),(6,4,71)]) \
      +bar_(6,[(0,2,75),(2,2,72),(4,4,68),(8,2,69),(10,2,72)])+bar_(7,[(0,4,73),(4,2,75),(6,6,77)])
  return m
PREM=bar_(0,[(0,3,72),(3,1,75),(4,6,77),(10,2,75)])+bar_(1,[(0,3,73),(3,1,75),(4,2,78),(6,4,77),(10,2,75)]) \
 +bar_(2,[(0,3,73),(3,1,77),(4,6,80),(10,2,78)])+bar_(3,[(0,3,75),(3,1,77),(4,2,82),(6,6,81)])
BRM=bar_(0,[(0,6,71),(6,2,73),(8,4,76)])+bar_(1,[(0,6,75),(6,6,72)])+bar_(2,[(0,6,72),(6,2,75),(8,4,77)]) \
 +bar_(3,[(0,6,77),(6,6,71)])+bar_(4,[(0,3,75),(3,1,77),(4,4,79),(8,4,77)])+bar_(5,[(0,6,75),(6,6,73)]) \
 +bar_(6,[(0,3,77),(3,1,80),(4,4,82),(8,4,83)])+bar_(7,[(0,6,82),(6,6,81)])
OUTM=bar_(0,[(0,3,77),(3,1,79),(4,8,82)])+bar_(1,[(0,6,79),(6,6,77)])+bar_(2,[(0,6,78),(6,6,77)])+bar_(3,[(0,12,74)])
INTM=bar_(0,[(0,3,75),(3,1,77),(4,8,80)])+bar_(1,[(0,6,76),(6,6,75)])+bar_(2,[(0,3,75),(3,1,77),(4,8,80)])+bar_(3,[(0,6,73),(6,6,72)])
sec_start={}
for i,bb in enumerate(bars): sec_start.setdefault(bb['sec'],i)
mel=[]
for n,p,e in form:
  g0=sec_start[n]*12
  if n=='Final Chorus': ph=[(s,d,q+2) for s,d,q in HOOK]+[(s+96,d,q+2) for s,d,q in HOOK_B]
  elif 'Chorus' in n and not n.startswith('Pre'): ph=HOOK
  elif n.startswith('Verse'): ph=verse_mel(n=='Verse 2')
  elif n.startswith('Pre'): ph=PREM
  elif n=='Bridge': ph=BRM
  elif n=='Outro': ph=OUTM
  else: ph=[]
  for s,d,pp in ph: mel.append((g0+s,d,pp,n,e))
for g,d,p,n,e in mel:
  add(0,g*S,d*S-20,p,(76+34*e) if n!="Outro" else 70,4)
  if n=='Final Chorus' and d>=4: add(6,g*S,d*S,snap(g,p-4),50)
if REV>=2:
  for n in('Chorus 2','Final Chorus'):
    for b_ in range(3,len(form[[f[0] for f in form].index(n)][1]),4):
      g0=(sec_start[n]+b_)*12; k=2 if n=='Final Chorus' else 0
      for s,d,p in [(6,2,63),(8,1,65),(9,3,68)]: add(6,(g0+s)*S,d*S,snap(g0+s,p+k),70)
# intro motif on piano
for s,d,p in INTM: add(1,s*S,d*S,p,58 if REV==1 else 84,4)
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']; cs=bb['chords']; half=len(cs)==2
  for h,c in enumerate(cs):
    root,iv,_=chord_at(i*12+h*6); ts=t0+h*6*S; L=(6 if half else 12); v=voice(root,iv)
    lh=36+((root-36)%12)
    if lh<40: lh+=12
    # piano: 6/8 broken-chord gospel comp
    if sec=='Intro':
      for k,p in enumerate(v): add(1,ts+k*20,L*S-30,p,(40 if REV==1 else 56)+k)   # soft block chords under motif
    elif REV>=2 and sec in('Verse 1','Bridge','Outro'):
      if sec=='Verse 1':        # 6/8 arpeggio: root, 5th, then voicing up and back
        arp=[lh,lh+7]+sorted(v)[:2]+[sorted(v)[2],sorted(v)[1]]
        for s in range(0,L,2): add(1,ts+s*S,3*S,arp[(s//2)%6],(70 if s==0 else 50)*(.8+.3*e))
      else:                     # bridge/outro: held chord + soft restrike on beat 2
        add(1,ts,L*S,lh,64)
        for k,p in enumerate(v): add(1,ts+k*12,L*S-40,p,52-k)
        if not half:
          for p in v[1:]: add(1,ts+6*S,6*S-40,p,38)
    else:
      for s in range(0,L,2):
        if s%6==0:
          add(1,ts+s*S,2*S,lh if s==0 else lh+7,60+30*e)
          for k,p in enumerate(v): add(1,ts+s*S+k*6,2*S-20,p,46+30*e)
          if REV>=4 and sec in('Chorus 2','Final Chorus'): add(1,ts+s*S+30,2*S-20,max(v)+12,44+30*e)
        elif REV>=3 and sec.startswith('Pre'):
          if s%6==4:
            for p in v[1:]: add(1,ts+s*S,2*S-30,p,30+20*e)
        elif e>=.5 or s%6==4:
          for p in v[1:]: add(1,ts+s*S,2*S-30,p,32+26*e)
      if e>=.55 and not half and bb['k']%2==1:   # chromatic passing chord a half step above the next chord
        nx=bars[min(len(bars)-1,i+1)]['chords'][0]; r2,iv2=ch(nx)
        for p in voice((r2+1)%12,iv2): add(1,t0+11*S,S,p,40+20*e,2)
        prev[:]=v
    # organ pad
    if sec not in('Verse 1',) and not(sec=='Intro' and bb['k']<2) and not(REV>=4 and sec=='Pre-Chorus' and bb['k']<2):
      for p in sorted(v)[-4:]: add(3,ts,L*S-20,p,30+40*e)
    # strings
    if sec in(('Bridge','Final Chorus','Pre-Chorus 2')+(('Chorus 2',) if REV>=4 else ())):
      for p in sorted(v)[-3:]: add(7,ts,L*S-20,p+12,30+40*e)
    # choir pads
    if sec in('Chorus 2','Final Chorus') or (sec=='Outro' and bb['k']>=2):
      for p in sorted(v)[-3:]: add(6,ts,L*S-20,p,36+30*e)
    # guitar comp: soft offbeat double-stops (eighths 2 and 5 of the bar)
    if REV>=2 and sec in('Verse 2','Chorus','Chorus 2','Final Chorus','Bridge') and h==len(cs)-1 and bb['k']%2==1:
      tv=sorted(v); lick=[tv[-1]+12,tv[-2]+12,tv[-3]+12,tv[-2]+12] if bb['k']%4==1 else [tv[-3]+12,tv[-2]+12,tv[-1]+12,tv[-1]+14]
      lick=[snap(i*12+9,p) for p in lick]
      for k,p in enumerate(lick): add(5,t0+(8+k)*S,S if k<3 else 2*S,p,62+20*e-(6 if k%2 else 0),3)
    if sec in(('Chorus','Chorus 2','Final Chorus') if REV>=2 else ('Verse 2','Chorus','Chorus 2','Final Chorus','Pre-Chorus 2')):
      for s in ([2,4] if half else [2,4,8,10]):
        if s<L: add(5,ts+s*S,S,sorted(v)[-1]+12,40+24*e); add(5,ts+s*S,S,sorted(v)[-2]+12,36+24*e)
    # bass
    if sec=='Intro' and bb['k']<3: continue
    nxt=bars[min(len(bars)-1,i+1)]['chords'][0] if h==len(cs)-1 else cs[h+1]; nr=ch(nxt)[0]
    nb=36+((nr-36)%12)
    if nb>47: nb-=12
    if lh>47: lh-=12
    if sec=='Outro' and bb['k']==3: add(2,ts,L*S,lh,84); continue
    pat=[(0,5,lh)]
    if not half: pat+=[(6,3,lh+7)]
    if e>.5: pat+=[(L-1,1,nb+(1 if nb<=lh else -1))]
    if REV>=2 and e>=.75 and not half: pat+=[(4,1,lh+12),(9,1,lh+10)]
    if REV>=2 and e>=.75 and half and h==0: pat+=[(4,1,lh+7)]
    if REV>=2 and sec=='Bridge': pat=[(0,L-1,lh)]
    for s,d,p in pat: add(2,ts+s*S,d*S-20,p,(96 if s==0 else 80 if s in(6,L-1) else 62)*(.8+.25*e),3)
  # ---- drums (6/8) ----
  if sec=='Intro' and bb['k']<3:
    continue
  if sec=='Outro':
    if bb['k']==0: add(4,t0,PPQ*3,49,50)
    continue
  hard=e>=.75; brk=sec=='Bridge' and bb['k']<4
  kick=[0]+([10] if e>=.5 else [])+([5] if hard and bb['k']%2 else [])
  for s in kick: add(4,t0+s*S,S,36,(104 if s==0 else 86)*(.85+.2*e),2)
  if hard or (sec.startswith('Pre') and bb['k']>=2 and REV==1) or sec=='Verse 2':
    add(4,t0+6*S+10,S,38,88+25*e,2)
    if sec=='Final Chorus': add(4,t0+6*S+10,S,39,90)
  else:
    add(4,t0+6*S+8,S,37,70+30*e,2)
  for s in ([3,9,11] if REV>=1 else []):
    if random.random()<e: add(4,t0+s*S,60,38,18+random.randint(0,12),8)
  for s in range(0,12,2 if not hard else 1):
    if brk and s%6: continue
    add(4,t0+s*S,50,42 if not(sec=='Final Chorus') else 51,(72 if s%6==0 else 50 if s%2==0 else 30)*(.6+.45*e)*(1 if REV==1 else 1.25),4)
  if REV>=2 and hard: add(4,t0+11*S,S,46,58)
  if REV>=3 and hard:
    add(4,t0+6*S+10,S,54,64+24*e,2); add(4,t0+9*S,S,54,40,2)
    if sec!='Chorus':
      for s in range(12): add(4,t0+s*S,40,70,34+(16 if s%2==0 else 0),5)
  if sec=='Verse 2': 
    for s in range(12): add(4,t0+s*S,40,69,30+(14 if s%2==0 else 0))
  if bb['k']==0 and (('Chorus' in sec and not sec.startswith('Pre')) or sec=='Bridge'): add(4,t0,PPQ*3,49,92 if sec=='Final Chorus' else 76)
  if REV>=3 and sec=='Bridge' and bb['k']>=4 and not bb['last']: add(4,t0+6*S+10,S,38,70+bb['k']*5,2)
  if REV>=2 and (sec.startswith('Pre') or (REV>=3 and sec=='Bridge')) and bb['last']:
    for k in range(12): add(4,t0+k*S,S,38,30+k*6,2)
  elif bb['last'] and sec not in('Outro',):
    for k,s in enumerate(range(6,12)): add(4,t0+s*S,S,[38,38,45,45,43,41][k],50+k*9,3)
total=len(bars)
for k in N:
  for x in N[k]:
    e=bars[min(total-1,x['tick']//BAR)]['e']; f=(0.88+0.14*e) if k==0 else (0.62+0.44*e) if REV==1 else (0.7+0.36*e)
    x['velocity']=max(1,min(127,int(x['velocity']*f)))
vol=[112,92,100,66,92,68,62,64] if REV==1 else [96,100,100,70,96,72,66,68] if REV==2 else [90,100,98,70,100,74,74,72] if REV==3 else [90,100,98,70,100,74,84,72]
if NOLEAD: vol[0]=0
prog=[73,0,33,16,0,27,52,49]; pan=[64,50,64,78,64,34,40,92]
roles=['melody','harmony','bass','accompaniment','percussion','accompaniment','harmony','accompaniment']
tempo=[{"bar":1,"bpm":BPM},{"bar":total-1,"bpm":74},{"bar":total,"bpm":66}]
steps=[{"tool":"gbk_create_project","args":{"name":"Golden Hour Hymn","tempo":BPM,"timeSignature":[6,8],"key":"Ab major","ppq":PPQ,"replaceCurrent":True}}]
steps+=[{"tool":"gbk_create_track","args":{"name":TR[k],"program":prog[k],"role":roles[k],"pan":pan[k],"volume":vol[k]}} for k in range(len(TR))]
steps+=[{"tool":"gbk_set_tempo_map","args":{"events":tempo}},{"tool":"gbk_set_song_structure","args":{"sections":secs}}]
alln=[n for k in N for n in N[k]]
for i in range(0,len(alln),1500): steps+=[{"tool":"gbk_propose_note_patch","args":{"add":alln[i:i+1500]}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[3]"],"controller":11,"shape":"crescendo","from":50,"to":120,"range":{"unit":"bars","start":3,"end":5}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}},
        {"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[3]","$track[5]","$track[6]"],"controller":11,"shape":"decrescendo","from":120,"to":40,"range":{"unit":"bars","start":total-1,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
name=f"v{REV}"+("nl" if NOLEAD else "")
json.dump({"title":"Golden Hour Hymn","slug":"golden-hour-hymn","composer":"Velvet Rae","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":4}},open(f"{name}.json","w"))
json.dump({"bars":[{"sec":b['sec']} for b in bars],"bpm":BPM,"notes":{TR[k]:N[k] for k in N}},open(f"n{REV}.json","w"))
cl=[(n,g//12+1,chord_at(g)[2],p) for g,d,p,n,e in mel if d>=2 and p%12 not in tones(g) and any((p-x)%12==1 for x in tones(g))]
print("rev",REV,"bars",total,"notes",len(alln),"sec",round(total*180/BPM),"clashes",len(cl),cl[:12])
