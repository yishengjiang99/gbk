# Velvet Rae - "Slow Honey" generator. usage: gen.py REV  -> v{REV}.json + analysis-friendly notes dump
import json,random,sys
REV=int(sys.argv[1]); random.seed(1025)
PPQ=480; S=PPQ//4; BAR=16*S; BPM=76 if REV<3 else 74
SWING=int(S*(0.14 if REV==1 else 0.19))
# chord: name -> (root pc, upper-structure intervals above root)
Q={'maj9':[4,7,11,14],'m11':[3,10,14,17],'m9':[3,7,10,14],'13':[4,10,14,21],'13sus':[5,10,14,21],'7#9':[4,10,15],'7b9':[4,10,13],'9':[4,10,14],'m7b5':[3,6,10],'7#5':[4,8,10]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def ch(s):
  r=s[:2] if len(s)>1 and s[1]=='b' else s[:1]; return (PC[r],Q[s[len(r):]])
# progressions: list of bars; each bar is list of chords (1 or 2 halves)
INTRO=[['Abmaj9'],['Gm11'],['Fm11'],['Bb13sus','Bb7b9']]
VERSE=[['Abmaj9'],['Dbmaj9'],['Fm11'],['Bb13sus'],['Abmaj9'],['Db13','C7#9'],['Fm11'],['Fm9','E9']]
PRE=[['Cm11'],['Bbm9','Eb13'],['Abmaj9'],['Fm11','Bb13sus']] if REV==1 else [['Cm11'],['Bbm9','Eb13'],['Abmaj9','Abm9'],['Fm11','Bb13sus']]
CHOR=[['Abmaj9'],['G7b9'],['Cm11'],['Bbm9','Eb13'],['Abmaj9'],['Abm9','Db13'],['Gm11','C7#9'],['Fm11','E13']]
BRID=[['Dbmaj9'],['Cm11'],['Bmaj9'],['Bbm11'] if 'Bbm11' in [] else ['Bbm9'],['Abmaj9'],['Gm11'],['Fm11'],['B13sus','B7b9']]
OUT=[['Abmaj9'],['G7b9'],['Abm9','Db13'],['Ebmaj9']]
form=[('Intro',INTRO,.25,0),('Verse 1',VERSE,.45,0),('Pre-Chorus',PRE,.6,0),('Chorus',CHOR,.8,0),
      ('Verse 2',VERSE,.55,0),('Pre-Chorus 2',PRE,.68,0),('Chorus 2',CHOR,.88,0),('Bridge',BRID,.62 if REV<3 else .5,0),
      ('Final Chorus',CHOR,1.0,1),('Outro',OUT,.3,1)]
bars=[];secs=[];b=1
for n,p,e,tr in form:
  secs.append({"name":n,"startBar":b,"bars":len(p),"energy":e})
  for k,c in enumerate(p): bars.append(dict(sec=n,e=e,tr=tr,chords=c,k=k,last=k==len(p)-1))
  b+=len(p)
TR=['Lead','Rhodes','Bass','Pad','Drums','Guitar','Oohs']; N={i:[] for i in range(len(TR))}
def T(t,strict=False):
  i,r=divmod(t,S); t2=t+(SWING if i%2 and r==0 else 0)
  return max(0,t2+(0 if strict else random.randint(-7,7)))
def add(tr,t,d,p,v,strict=False):
  N[tr].append({"trackId":"$track[%d]"%tr,"tick":T(t,strict),"duration":max(30,int(d)),"pitch":int(p),"velocity":max(1,min(127,int(v+random.randint(-6,6))))})
# --- voice-led Rhodes voicings
prev=[60,63,67,70]
def voice(root,iv,lo=53,hi=77):
  global prev
  base=[(root+x)%12 for x in iv]; best=None
  import itertools
  cands=set(tuple(p) for p in itertools.permutations(base))
  for start in range(lo,lo+12):
   for order in cands:
    v=[];cur=start-1
    for pc in order:
      n=cur+1
      while n%12!=pc: n+=1
      v.append(n);cur=n
    if v[-1]>hi or v[-1]-v[0]>16: continue
    cost=sum(abs(a-b) for a,b in zip(sorted(v),sorted(prev+[prev[-1]]*(len(v)-len(prev)))[:len(v)]))
    if best is None or cost<best[0]: best=(cost,v)
  prev=best[1]; return best[1]
# --- melody: Eb major hook (16th grid, absolute pitches in Eb), 8-bar chorus phrase
H=[[(2,2,67),(4,2,70),(6,3,72),(10,1,70),(11,3,67),(14,2,65)], [(18,2,70),(20,2,68),(22,6,67)],
   [(34,2,67),(36,2,70),(38,3,75),(42,1,74),(43,3,72),(46,2,70)], [(50,2,73),(52,2,72),(54,2,70),(56,6,67)],
   [(66,2,67),(68,2,70),(70,3,72),(74,1,70),(75,3,67),(78,2,65)], [(82,2,71),(84,2,70),(86,2,68),(88,4,65)],
   [(98,2,70),(100,2,74),(102,4,77),(106,2,75),(108,2,74),(110,2,72)], [(112,2,72),(114,2,68),(116,10,68)]]
HOOK=[n for bar in H for n in bar]
SC=[51,53,55,56,58,60,62,63,65,67,68,70,72,74,75,77,79]
def deg(p): return min(range(len(SC)),key=lambda i:abs(SC[i]-p))
# verse: hook head (first 3 notes) restated on different degrees, answered by a descending tag
def verse_mel(v2):
  out=[];starts=[67,65,63,62] if not v2 else [67,67,63,65]
  for ph in range(4):
    o=ph*32; d0=deg(starts[ph])
    for s,dur,dd in [(2,2,0),(4,2,1),(6,4,2)]: out.append((o+s,dur,SC[d0+dd]))
    tag=[(18,1,3),(19,1,2),(20,2,1),(22,6,0)] if ph%2==0 else [(17,1,1),(18,2,0),(20,2,-1),(22,4,-2)]
    if v2 and ph==3: tag=[(16,2,4),(18,1,3),(19,1,2),(20,2,1),(22,8,2)]
    if REV>=2 and v2 and ph in(1,2): out.append((o+0,1,SC[d0-1]))   # pickup grace
    for s,dur,dd in tag: out.append((o+s,dur,SC[d0+dd]))
  return out
def pre_mel():  # rising sequence of the hook head -> tension into chorus
  out=[]
  for ph,st in enumerate([63,65,67,70]):
    o=ph*16; d0=deg(st)
    for s,dur,dd in [(2,2,0),(4,2,1),(6,3,2),(10,2,1 if ph<3 else 3)]: out.append((o+s,dur,SC[d0+dd]))
  if REV>=2: out.append((60,4,74))   # held lead-in note
  return out
LEADVOL={'Intro':0,'Outro':.7}
sec_start={}
for i,bb in enumerate(bars): sec_start.setdefault(bb['sec'],i)
def snap(g,p):
  bb=bars[g//16]; c=bb['chords'][0 if len(bb['chords'])==1 else (g%16)//8]; r,iv=ch(c); r=(r+bb['tr'])%12
  tones={r}|{(r+x)%12 for x in iv}; return min([q for q in range(p-3,p+4) if q%12 in tones],key=lambda q:abs(q-p))
mel=[]  # (bar index offset tick, dur, pitch, section)
for n,p,e,tr in form:
  o=sec_start[n]*BAR
  if n.startswith('Chorus') or n=='Final Chorus': ph=HOOK
  elif n.startswith('Verse'): ph=verse_mel(n=='Verse 2')
  elif n.startswith('Pre'): ph=pre_mel()
  elif n=='Bridge' and REV>=2: ph=[(s_,d_,snap(sec_start[n]*16+s_,p_-2)) for s_,d_,p_ in HOOK if s_<64]+[(66,2,70),(68,2,72),(70,6,74),(98,2,72),(100,2,75),(102,6,77),(112,3,73),(116,3,78),(120,6,78)]
  elif n=='Bridge': ph=[(s+64 if REV>=2 else s,d,p+(-3 if REV>=2 else 0)) for s,d,p in HOOK if s<64] if REV>=2 else [(s,d,p) for s,d,p in HOOK[:9]]
  elif n=='Intro': ph=[(s+32,d,p+12) for s,d,p in HOOK if 32<=s+32<64 and s<32] # hook teaser on Rhodes register later
  elif n=='Outro': ph=[(s,d,p) for s,d,p in HOOK if s<32]
  for s,d,pp in ph: mel.append((o+s*S,d*S,pp+tr,n,e))
for t,d,p,n,e in mel:
  tr_=1 if n=='Intro' else 0
  vel=(70 if tr_==1 else 82+30*e)
  add(tr_,t,d-24,p,vel)
  if n=='Final Chorus' or (REV>=2 and n=='Chorus 2'): add(6,t,d,p-12,58 if n=='Final Chorus' else 46)
  if REV>=3 and n=='Final Chorus' and d>=3*S: add(6,t,d,snap(t//S,p-4),50)  # harmony third under long notes
# --- per bar parts
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']; cs=bb['chords']; half=len(cs)==2; tr=bb['tr']
  nxt=bars[i+1]['chords'][0] if i+1<len(bars) else cs[0]; nroot=(ch(nxt)[0]+(bars[i+1]['tr'] if i+1<len(bars) else 0))%12
  for h,c in enumerate(cs):
    root,iv=ch(c); root=(root+tr)%12; ts=t0+h*8*S; L=(8 if half else 16)*S
    v=voice(root,iv)
    # Rhodes comp
    big=sec not in('Intro','Outro')
    for k,p in enumerate(v): add(1,ts+k*9,(L-2*S) if not big else 7*S if not half else 5*S,p,(50+28*e)-k*3)
    if big and not half:
      for p in v[1:]: add(1,ts+10*S,3*S,p,40+22*e)
      if e>0.75: 
        for p in v[1:3]: add(1,ts+14*S,2*S,p,34+20*e)
    # pad
    if sec not in('Verse 1',) or REV==1:
      for p in v: add(3,ts,L-30,p+12 if p<60 else p,38+40*e)
    # guitar skank verse2+
    if sec in('Verse 2','Pre-Chorus 2','Chorus 2','Final Chorus') or (REV>=2 and sec=='Bridge'):
      for s in ((4,12) if not half else (4,)):
        for p in sorted(v)[-3:]: add(5,ts+s*S,S,p+12,58+20*e)
    # bass locks with kick: 0, (7 ghost), 10, approach at 15
    if sec=='Intro' and i<2: continue
    br=36+((root-36)%12); br=br-12 if br>45 else br; br+=0 if br>=28 else 12
    if sec=='Outro' and i>=len(bars)-2: add(2,ts,L,br,78); continue
    if half: pat=[(0,3,br,96),(3,1,br+12,40),(6,2,br+7,70)]
    else: pat=[(0,6,br,98),(7,1,br+12,38),(10,3,br+7 if REV==1 else br,86),(13,1,br+10 if 10 in iv or 21 in iv else br+7,62)]
    for s,d,p,vv in pat: add(2,ts+s*S,d*S-20,p,vv*(0.82+0.22*e))
    if h==len(cs)-1 and not half and REV>=2:  # chromatic approach to next root
      nb=br+((nroot-br)%12); nb=nb-12 if nb-br>6 else nb
      add(2,t0+15*S,S-20,nb+(1 if nb<br else -1),66)
  # drums
  if sec=='Intro' or (sec=='Outro' and bb['k']>=2):
    if sec=='Intro' and bb['k']>=2: [add(4,t0+s*S,60,42,30+8*(s%4==0)) for s in range(0,16,2)]
    if sec=='Intro' and bb['last']: add(4,t0+14*S,S,38,40); add(4,t0+15*S,S,38,60)
    continue
  kick=[0,10]+([7] if e>0.75 else [])+([15] if bb['k']%2==1 and e>0.5 else [])
  for s in kick: add(4,t0+s*S,S,36,(100 if s==0 else 82)*(0.85+0.2*e))
  sn=38 if e>0.5 else 37
  for s in (4,12): add(4,t0+s*S+22,S,sn,(96 if sn==38 else 78)*(0.9+0.12*e))
  if REV>=2 or e>0.5:
    for s in random.sample([3,6,7,9,11,14],3 if e<0.7 else 4): add(4,t0+s*S,60,38,22+random.randint(0,12))
  hs=1 if e>0.6 and not(REV>=3 and sec=='Bridge') else 2
  if REV>=3 and sec=='Final Chorus': add(4,t0+6*S,S*2,46,50)
  for s in range(0,16,hs):
    if e>0.75 and s==14: add(4,t0+s*S,S*2,46,58); continue
    add(4,t0+s*S,60,42,(68 if s%4==0 else 50 if s%2==0 else 36)*(0.8+0.3*e))
  if sec in('Verse 2','Chorus 2','Final Chorus')+(() if REV>=3 else ('Bridge',)) and REV>=2:
    for s in range(1,16,2): add(4,t0+s*S,60,70,30+12*(s%4==3))   # maracas/shaker
  if bb['k']==0 and sec in('Chorus','Chorus 2','Final Chorus')+(() if REV>=3 else ('Bridge',)): add(4,t0,PPQ*3,49,92 if sec=='Final Chorus' else 76)
  if bb['last'] and sec!='Outro':  # fill
    for k,s in enumerate([12,13,14,15]): add(4,t0+s*S,S,[38,45,43,41][k] if e>0.6 else 38,50+k*12)
total=len(bars)
vol={1:{0:96,1:96,2:102,3:60,4:94,5:56,6:64},2:{0:112,1:86,2:104,3:50,4:92,5:52,6:58},3:{0:114,1:82,2:104,3:48,4:90,5:50,6:56}}[REV]
prog=[65,4,33 if REV>=2 else 35,89,0,27,52]; pan=[64,50,64,78,64,90,36]
roles=['melody','harmony','bass','accompaniment','percussion','accompaniment','harmony']
steps=[{"tool":"gbk_create_project","args":{"name":"Slow Honey","tempo":BPM,"timeSignature":[4,4],"key":"Eb major","ppq":PPQ,"replaceCurrent":True}}]
steps+=[{"tool":"gbk_create_track","args":{"name":TR[k],"program":prog[k],"role":roles[k],"pan":pan[k],"volume":vol[k]}} for k in range(7)]
steps+=[{"tool":"gbk_set_tempo_map","args":{"events":[{"bar":1,"bpm":BPM}]}},{"tool":"gbk_set_song_structure","args":{"sections":secs}}]
alln=[n for k in N for n in N[k]]
for i in range(0,len(alln),1500): steps+=[{"tool":"gbk_propose_note_patch","args":{"add":alln[i:i+1500],"summary":"Slow Honey notes"}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[1]","$track[3]"],"controller":11,"shape":"crescendo","from":70,"to":120,"range":{"unit":"bars","start":1,"end":5}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}},
        {"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[3]","$track[6]"],"controller":11,"shape":"decrescendo","from":120,"to":35,"range":{"unit":"bars","start":total-2,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
json.dump({"title":"Slow Honey","slug":"slow-honey","composer":"Velvet Rae","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":4}},open(f"/workspace/vr2/v{REV}.json","w"))
json.dump({"bars":[{"sec":b['sec']} for b in bars],"bpm":BPM,"notes":{TR[k]:N[k] for k in N}},open(f"/workspace/vr2/n{REV}.json","w"))
print("rev",REV,"bars",total,"notes",len(alln),"sec",round(total*4*60/BPM))
# clash report: long lead notes (>= 8th) whose pc is a b9 against chord tones
cl=[]
for t,dd,p,n,e in mel:
  if n=='Intro' or dd<2*S: continue
  bi=t//BAR; 
  if bi>=len(bars): continue
  bb=bars[bi]; c=bb['chords'][min(len(bb['chords'])-1,(t%BAR)//(8*S))] if len(bb['chords'])==2 else bb['chords'][0]
  r,iv=ch(c); r=(r+bb['tr'])%12; tones={r}|{(r+x)%12 for x in iv}
  if any((p-x)%12==1 for x in tones) and p%12 not in tones: cl.append((n,bi+1,c,p))
print("b9 clashes:",len(cl),cl[:12])
