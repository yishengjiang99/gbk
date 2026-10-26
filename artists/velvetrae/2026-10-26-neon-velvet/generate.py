# Velvet Rae - "Neon Velvet" (working) : upbeat neo-soul/funk in F minor. usage gen.py REV
import json,random,sys,itertools
REV=int(sys.argv[1]); random.seed(1026)
PPQ=480; S=PPQ//4; BAR=16*S; BPM=94 if REV<3 else 96
SWING=int(S*(0.10 if REV==1 else 0.14))
Q={'maj9':[4,7,11,14],'m11':[3,10,14,17],'m9':[3,7,10,14],'13':[4,10,14,21],'13sus':[5,10,14,21],'7#9':[4,10,15],'7b9':[4,10,13],'9':[4,10,14],'m7b5':[3,6,10]}
PC={'C':0,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'Gb':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def ch(s):
  r=s[:2] if len(s)>1 and s[1]=='b' else s[:1]; return (PC[r],Q[s[len(r):]])
INTRO=[['Fm11'],['Fm11'],['Dbmaj9'],['Gb13','C7#9']]
VERSE=[['Fm11'],['Bb13'],['Fm11'],['Bb13'],['Dbmaj9'],['Cm11'],['Bbm9'],['Gb13','C7#9']]
PRE=[['Dbmaj9'],['Ebm9','Ab13'],['Dbmaj9'],['Gb13','C7b9']]
CHOR=[['Fm11'],['Ebm9','Ab13'],['Dbmaj9'],['Cm11','F7#9'],['Bbm9'],['Eb13'],['Abmaj9','Dbmaj9'],['Gb13','C7#9']]
BRID=[['Bbm9'],['Am7b5','D7b9'],['Abmaj9'],['Gm7b5','C7b9'],['Dbmaj9'],['Cm11'],['Ebm9','Ab13'],['Db13sus','Db7b9']]
OUT=[['Fm11'],['Dbmaj9'],['Gb13','C7#9'],['Fm11']]
form=[('Intro',INTRO,.3,0),('Verse 1',VERSE,.5,0),('Pre-Chorus',PRE,.62,0),('Chorus',CHOR,.82,0),
      ('Verse 2',VERSE,.6,0),('Pre-Chorus 2',PRE,.7,0),('Chorus 2',CHOR,.9,0),('Bridge',BRID,.55,0),
      ('Final Chorus',CHOR,1.0,1),('Outro',OUT,.35,1)]
bars=[];secs=[];b=1
for n,p,e,tr in form:
  secs.append({"name":n,"startBar":b,"bars":len(p),"energy":e})
  for k,c in enumerate(p): bars.append(dict(sec=n,e=e,tr=tr,chords=c,k=k,last=k==len(p)-1))
  b+=len(p)
TR=['Synth Lead','Rhodes','Bass','Pad','Drums','Clavinet','Oohs','Brass']; N={i:[] for i in range(len(TR))}
def T(t,j=6):
  i,r=divmod(t,S); t2=t+(SWING if i%2 and r==0 else 0); return max(0,t2+random.randint(-j,j))
def add(tr,t,d,p,v,j=6):
  N[tr].append({"trackId":"$track[%d]"%tr,"tick":T(t,j),"duration":max(30,int(d)),"pitch":int(p),"velocity":max(1,min(127,int(v+random.randint(-6,6))))})
def chord_at(g):  # g = global 16th index
  bb=bars[min(len(bars)-1,g//16)]; c=bb['chords'][0 if len(bb['chords'])==1 else (g%16)//8]; r,iv=ch(c); return (r+bb['tr'])%12,iv,c
def tones(g): r,iv,_=chord_at(g); return {r}|{(r+x)%12 for x in iv}
def snap(g,p):
  t=tones(g); return min([q for q in range(p-3,p+4) if q%12 in t],key=lambda q:(abs(q-p),q))
prev=[56,60,63,67]
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
# HOOK (8 bars, 16th grid, F minor). Bars 1 & 5 identical (call), 3 is the answer, 7 the peak.
H1=[(0,1,77),(2,1,75),(3,2,72),(6,1,75),(7,1,77),(8,2,80),(11,1,77),(12,2,75),(14,1,72)]
HOOK=H1+[(18,1,70),(19,1,72),(20,2,73),(22,1,70),(24,2,72),(26,1,70),(27,3,68)] \
 +[(32+s,d,p) for s,d,p in H1[:6]]+[(42,4,79),(46,1,77)] \
 +[(50,1,70),(51,1,72),(52,2,75),(56,2,75),(58,1,72),(59,5,69)] \
 +[(64+s,d,p) for s,d,p in H1] \
 +[(82,1,70),(83,1,72),(84,2,73),(86,2,72),(88,4,67)] \
 +[(96,1,75),(98,1,77),(99,2,79),(102,2,80),(104,2,77),(106,2,75),(108,2,72)] \
 +[(112,2,73),(114,2,70),(118,1,75),(119,1,76),(120,6,72)]
def verse_mel(v2):   # hook head (descending 3 notes + rebound) on new degrees, answered
  out=[]
  for ph in range(4):
    o=ph*32; top=[77,75,80,77][ph]-(5 if not v2 else 0)
    cell=[(0,1,0),(2,1,-2),(3,2,-5),(6,1,-2),(7,3,0)]
    for s,d,dd in cell: out.append((o+s,d,top+dd))
    ans=[(18,1,-5),(19,1,-3),(20,2,-2),(22,4,-5)] if ph%2==0 else [(17,1,-2),(18,1,0),(19,2,3),(22,6,0)]
    if v2 and ph==3: ans=[(16,1,0),(17,1,3),(18,2,5),(20,1,3),(21,1,0),(22,8,3)]
    for s,d,dd in ans: out.append((o+s,d,top+dd))
  return out
def pre_mel():
  out=[]
  for ph,top in enumerate([72,73,75,77]):
    for s,d,dd in [(0,1,0),(2,1,-2),(3,2,-4),(6,1,-2),(7,1,0),(8,4,3)]: out.append((ph*16+s,d,top+dd))
  if REV>=2: out+= [(60,1,79),(61,1,80),(62,2,82)]
  return out
sec_start={}
for i,bb in enumerate(bars): sec_start.setdefault(bb['sec'],i)
mel=[]
for n,p,e,tr in form:
  g0=sec_start[n]*16
  if 'Chorus' in n and not n.startswith('Pre'): ph=HOOK
  elif n.startswith('Verse'): ph=verse_mel(n=='Verse 2')
  elif n.startswith('Pre'): ph=pre_mel()
  elif n=='Bridge': ph=[(s,d,p-5) for s,d,p in HOOK if s<32]+[(s+64,d,p-2) for s,d,p in HOOK if s<32]+([(96,2,72),(98,2,75),(100,4,77),(112,2,77),(114,2,78),(116,8,80)] if REV>=2 else [])
  elif n=='Intro': ph=[(s+32,d,p-12) for s,d,p in H1]
  else: ph=[(s,d,p) for s,d,p in HOOK if s<32]
  for s,d,pp in ph:
    pp+=tr; isch='Chorus' in n and not n.startswith('Pre')
    pr=snap(g0+s,pp) if not isch or REV==1 else pp
    mel.append((g0+s,d,pr,n,e))
for g,d,p,n,e in mel:
  trk=1 if n=='Intro' else 0
  add(trk,g*S,d*S-25,p,(68 if trk else 84+28*e),4)
  if n=='Final Chorus' or (n=='Chorus 2' and REV>=2): add(6,g*S,d*S,p-12,56)
  if REV>=3 and n=='Final Chorus' and d>=2: add(6,g*S,d*S,snap(g,p-4),48)
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']; cs=bb['chords']; half=len(cs)==2
  for h,c in enumerate(cs):
    root,iv,_=chord_at(i*16+h*8); ts=t0+h*8*S; L=(8 if half else 16)*S; v=voice(root,iv)
    # Rhodes: syncopated comp (1, and-of-2 push, 4e)
    hits=[(0,3),(6,2),(11,2)] if not half else [(0,3),(6,1)]
    if sec in('Intro','Outro'): hits=[(0,L//S-1)]
    for s,d in hits:
      for k,p in enumerate(v): add(1,ts+s*S+k*6,d*S-20,p,(46+30*e)*(1 if s==0 else .8))
    # clav: 16th chops on upper 3 notes, from Verse 1 (sparser) / Verse 2 (busier)
    if sec not in('Intro','Outro') and not(REV>=3 and sec=='Bridge'):
      pat=([5,13] if REV>=2 and sec=='Verse 1' else [2,5,9,13,15]) if sec in('Verse 1','Pre-Chorus','Bridge') else [2,3,5,8,9,13,14]
      for s in pat:
        if s*S<L:
          for p in sorted(v)[-2:]: add(5,ts+s*S,S-40,p+12,(62 if s%4 in(1,3) else 48)+18*e)
    # pad from pre-chorus on (not verse 1)
    if sec not in('Verse 1','Intro' if REV>=2 else 'x'):
      for p in v: add(3,ts,L-30,p+12 if p<62 else p,30+40*e)
    # brass stabs in choruses
    if (sec=='Final Chorus' or (REV>=2 and sec=='Chorus 2')) and h==0:
      for p in sorted(v)[-3:]: add(7,ts+(14*S if not half else 6*S)-L,S*2-40,p,70+20*e) if i>0 else None
    # bass: funk 16ths locked to kick (0,3,7,10) with octave pop + ghost + chromatic approach
    if sec=='Intro' and i<2: continue
    br=29+((root-29)%12)
    if sec=='Outro' and i==len(bars)-1: add(2,ts,L,br,84); continue
    pat=[(0,2,br,100),(3,1,br,72),(4,1,br+12,58),(7,1,br+7,82),(10,2,br,90),(12,1,br+12,64),(14,1,br+10,70)] if not half else [(0,2,br,100),(3,1,br+12,62),(6,1,br+7,80)]
    if sec=='Verse 1' and REV>=2: pat=[x for x in pat if x[0] not in(4,12)]
    for s,d,p,vv in pat: add(2,ts+s*S,d*S-25,p,vv*(.82+.22*e),4)
    if REV>=2 and h==len(cs)-1:
      nr=chord_at(i*16+16)[0]; nb=29+((nr-29)%12); add(2,t0+15*S,S-25,nb+(1 if (nb-br)%12>6 else -1),72,3)
  # drums
  if sec=='Intro' and bb['k']<2: continue
  if sec=='Outro' and bb['k']==3: add(4,t0,PPQ*4,49,70); continue
  kick=[0,3,10]+([7] if e>.7 else [])+([14] if bb['k']%2 else [])
  if sec=='Bridge' and REV>=3: kick=[0,10]
  for s in kick: add(4,t0+s*S,S,36,(104 if s==0 else 84)*(.85+.2*e),3)
  for s in(4,12): add(4,t0+s*S+8,S,38,(98+12*e) if sec!='Bridge' or REV<3 else 70,3)
  gh=[1,6,9,11,14,15] if REV>=2 else [7,15]
  for s in random.sample(gh,min(len(gh),2+int(4*e))): add(4,t0+s*S,60,38,20+random.randint(0,14),8)
  for s in range(16):
    if REV>=2 and sec=='Verse 1' and s%2: continue
    if e>.75 and s in(6,14) and REV>=2: add(4,t0+s*S,S,46,62); continue
    add(4,t0+s*S,50,42,(74 if s%4==0 else 56 if s%2==0 else 34+random.randint(0,10))*((.75+.3*e) if REV==1 else (.45+.6*e)),5)
  if sec in('Verse 2','Chorus 2','Final Chorus') and REV>=2:
    for s in(2,6,10,14): add(4,t0+s*S,60,39,38)  # claps layer on offbeats is too much -> hand clap only on 4 
  if bb['k']==0 and ('Chorus' in sec and not sec.startswith('Pre')): add(4,t0,PPQ*3,49,96 if sec=='Final Chorus' else 80)
  if bb['last'] and sec not in('Outro',):
    for k,s in enumerate([10,11,12,13,14,15]): add(4,t0+s*S,S,[38,38,48,47,45,43][k],56+k*9,3)
total=len(bars)
if REV>=3:
  for k in N:
    for x in N[k]:
      e=bars[min(total-1,x['tick']//BAR)]['e']; f=(0.86+0.16*e) if k==0 else (0.66+0.4*e)
      x['velocity']=max(1,min(127,int(x['velocity']*f)))
vol={1:[100,92,102,58,96,72,60,70],2:[112,86,100,52,94,66,58,66],3:[116,84,100,50,94,64,56,64]}[REV]
prog=[81,4,33,89,0,7,52,61]; pan=[64,46,64,80,64,88,40,76]
roles=['melody','harmony','bass','accompaniment','percussion','accompaniment','harmony','accompaniment']
steps=[{"tool":"gbk_create_project","args":{"name":"Neon Velvet","tempo":BPM,"timeSignature":[4,4],"key":"F minor","ppq":PPQ,"replaceCurrent":True}}]
steps+=[{"tool":"gbk_create_track","args":{"name":TR[k],"program":prog[k],"role":roles[k],"pan":pan[k],"volume":vol[k]}} for k in range(len(TR))]
steps+=[{"tool":"gbk_set_tempo_map","args":{"events":[{"bar":1,"bpm":BPM}]}},{"tool":"gbk_set_song_structure","args":{"sections":secs}}]
alln=[n for k in N for n in N[k]]
for i in range(0,len(alln),1500): steps+=[{"tool":"gbk_propose_note_patch","args":{"add":alln[i:i+1500]}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[3]","$track[5]","$track[6]"],"controller":11,"shape":"decrescendo","from":120,"to":40,"range":{"unit":"bars","start":total-1,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
json.dump({"title":"Neon Velvet","slug":"neon-velvet","composer":"Velvet Rae","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":3}},open(f"v{REV}.json","w"))
json.dump({"bars":[{"sec":b['sec']} for b in bars],"bpm":BPM,"notes":{TR[k]:N[k] for k in N}},open(f"n{REV}.json","w"))
cl=[(n,g//16+1,chord_at(g)[2],p) for g,d,p,n,e in mel if n!='Intro' and d>=2 and p%12 not in tones(g) and any((p-x)%12==1 for x in tones(g))]
print("rev",REV,"bars",total,"notes",len(alln),"sec",round(total*240/BPM),"clashes",len(cl),cl[:10])
