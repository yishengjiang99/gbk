# Velvet Rae - "Hollow Moon": dark alt-R&B / trap-soul, B minor, half-time. usage gen.py REV
import json,random,sys,itertools
REV=int(sys.argv[1]); random.seed(1031)
PPQ=480; S=PPQ//4; BAR=16*S; BPM=68
SWING=int(S*(0.06 if REV==1 else 0.10))
Q={'maj9':[4,7,11,14],'m11':[3,10,14,17],'m9':[3,7,10,14],'13':[4,10,14,21],'7#9':[4,10,15],'7b9':[4,10,13],'9':[4,10,14],'m7b5':[3,6,10]}
PC={'C':0,'C#':1,'Db':1,'D':2,'Eb':3,'E':4,'F':5,'F#':6,'G':7,'Ab':8,'A':9,'Bb':10,'B':11}
def ch(s):
  r=s[:2] if len(s)>1 and s[1] in 'b#' else s[:1]; return (PC[r],Q[s[len(r):]])
INTRO=[['Bm11'],['Gmaj9'],['Em11'],['C9','F#7b9']]
VERSE=[['Bm11'],['Gmaj9'],['Em11'],['C#m7b5','F#7#9'],['Bm11'],['Gmaj9'],['Cmaj9'],['C9','F#7b9']]
PRE=[['Gmaj9'],['Am9','D13'],['Gmaj9'],['C9','F#7#9']]
CHOR=[['Bm11'],['Gmaj9'],['Em11','A13'],['Dmaj9','C9'],['Bm11'],['Gmaj9'],['Em11','G7#9'],['C9','F#7b9']]
BRID=[['Ebmaj9'],['Dmaj9'],['Cmaj9'],['Bm11'],['Ebmaj9'],['Dmaj9'],['Gm9'],['C9','F#7b9']]
OUT=[['Bm11'],['Gmaj9'],['C9','F#7b9'],['Bm11']]
form=[('Intro',INTRO,.25),('Verse 1',VERSE,.45),('Pre-Chorus',PRE,.6),('Chorus',CHOR,.82),
      ('Verse 2',VERSE,.58),('Pre-Chorus 2',PRE,.68),('Chorus 2',CHOR,.9),('Bridge',BRID,.45 if REV>=3 else .6),
      ('Final Chorus',CHOR,1.0),('Outro',OUT,.25)]
bars=[];secs=[];b=1
for n,p,e in form:
  secs.append({"name":n,"startBar":b,"bars":len(p),"energy":e})
  for k,c in enumerate(p): bars.append(dict(sec=n,e=e,chords=c,k=k,last=k==len(p)-1))
  b+=len(p)
TR=['Muted Trumpet','Wurli','808 Sub','Eerie Pad','Drums','Nylon Guitar','Oohs','Vibes']; N={i:[] for i in range(len(TR))}
def T(t,j=6):
  i,r=divmod(t,S); t2=t+(SWING if i%2 and r==0 else 0); return max(0,t2+random.randint(-j,j))
def add(tr,t,d,p,v,j=6,raw=False):
  N[tr].append({"trackId":"$track[%d]"%tr,"tick":(max(0,t) if raw else T(t,j)),"duration":max(20,int(d)),"pitch":int(p),"velocity":max(1,min(127,int(v+random.randint(-5,5))))})
def chord_at(g):
  bb=bars[min(len(bars)-1,g//16)]; c=bb['chords'][0 if len(bb['chords'])==1 else (g%16)//8]; r,iv=ch(c); return r,iv,c
def tones(g): r,iv,_=chord_at(g); return {r}|{(r+x)%12 for x in iv}
def snap(g,p):
  t=tones(g); return min([q for q in range(p-3,p+4) if q%12 in t],key=lambda q:(abs(q-p),q))
prev=[59,62,66,69]
def voice(root,iv,lo=52,hi=76):
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
H1=[(0,2,74),(2,1,73),(3,3,71),(8,1,74),(9,1,76),(10,4,78)]
H2=[(16,2,78),(18,1,76),(19,3,74),(24,2,71),(26,6,69)]
HOOK=H1+H2+[(32,2,74),(34,1,71),(35,3,67),(40,2,73),(42,2,76),(44,4,78)] \
 +[(48,2,81),(50,2,78),(52,4,76),(56,2,76),(58,6,74)] \
 +[(64+s,d,p) for s,d,p in H1+H2] \
 +[(96,2,79),(98,2,78),(100,4,74),(104,2,77),(106,2,74)] \
 +[(112,2,76),(114,2,74),(116,2,72),(120,2,70),(122,1,71),(124,4,73)]
def verse_mel(v2):
  out=[]
  for ph in range(4):
    o=ph*32; base=[66,67,64,66][ph]+(0 if not v2 else 3)
    for s,d,dd in [(0,2,2),(2,1,1),(3,3,0),(8,1,2),(9,1,4),(10,4,5)]: out.append((o+s,d,base+dd))
    ans=[(18,1,4),(19,1,2),(20,2,0),(22,6,-3)] if ph%2==0 else [(17,1,0),(18,2,2),(20,2,5),(22,6,4)]
    if v2 and ph==3: ans=[(16,1,5),(17,1,7),(18,2,9),(20,2,7),(22,8,5)]
    for s,d,dd in ans: out.append((o+s,d,base+dd))
  return out
def pre_mel():
  out=[]
  for ph,top in enumerate([71,73,74,76]):
    for s,d,dd in [(0,2,0),(2,1,-1),(3,3,-3),(8,1,0),(9,1,2),(10,4,3)]: out.append((ph*16+s,d,top+dd))
  return out
sec_start={}
for i,bb in enumerate(bars): sec_start.setdefault(bb['sec'],i)
mel=[]
for n,p,e in form:
  g0=sec_start[n]*16; isch='Chorus' in n and not n.startswith('Pre')
  if isch: ph=HOOK
  elif n.startswith('Verse'): ph=verse_mel(n=='Verse 2')
  elif n.startswith('Pre'): ph=pre_mel()
  elif n=='Bridge': ph=([(s,d,p-2) for s,d,p in H1+H2]+[(s+64,d,p+2) for s,d,p in H1+H2]) if REV>=2 else []
  elif n=='Intro': ph=[]
  else: ph=[(s,d,p) for s,d,p in H1+H2]
  for s,d,pp in ph: mel.append((g0+s,d,(pp if isch else snap(g0+s,pp)),n,e))
for g,d,p,n,e in mel:
  trk=7 if n in('Outro',) or (REV>=2 and n=='Bridge') else 0
  add(trk,g*S,d*S-25,p,(80+30*e) if trk==0 else (60 if REV>=3 and n=='Outro' else 78),4)
  if n=='Final Chorus' or (REV>=2 and n=='Chorus 2'): add(6,g*S,d*S,p-12,54)
  if REV>=3 and n=='Final Chorus': add(7,g*S,d*S,p+12,60,4)       # vibes octave double for the lift
  if REV>=3 and n=='Final Chorus' and d>=3: add(6,g*S,d*S,snap(g,p-4),46)
for i,bb in enumerate(bars):
  t0=i*BAR; e=bb['e']; sec=bb['sec']; cs=bb['chords']; half=len(cs)==2
  for h,c in enumerate(cs):
    root,iv,_=chord_at(i*16+h*8); ts=t0+h*8*S; L=(8 if half else 16)*S; v=voice(root,iv)
    # Wurli: soft sustained chord + a pushed re-strike
    for k,p in enumerate(v): add(1,ts+k*8,L-S*(2 if not half else 1),p,(40+30*e)-k*2)
    if sec not in('Intro','Outro') and not half:
      for p in v[1:]: add(1,ts+11*S,3*S,p,30+22*e)
    # eerie pad
    if sec!='Verse 1' or REV==1:
      for p in sorted(v)[-3:]: add(3,ts,L-20,p+12,26+44*e)
    # nylon hook riff: H1 down an octave, snapped to chord (intro/outro/pre/bridge); arpeggio in verses/choruses
    if sec in('Intro','Outro','Bridge') or (REV>=2 and sec.startswith('Pre')):
      if h==0:
        for s,d,p in H1: add(5,t0+s*S,d*S-20,snap(i*16+s,p-12),(62+18*e)*(1.25 if REV>=3 and sec=='Intro' else 1),4)
    elif not(sec=='Verse 1' and REV>=2 and bb['k']<4):
      arp=sorted(v)
      for s in range(0,L//S,2 if e<.7 else 1):
        if REV>=2 and s%4==3 and e<.7: continue
        add(5,ts+s*S,S*2,arp[(s//(1 if e>=.7 else 2))%len(arp)]+(12 if arp[0]<60 else 0),40+22*e+(8 if s%4==0 else 0))
    # 808: follows the kick
    if sec=='Intro' and bb['k']<2: continue
    r8=35+((root-35)%12)
    if r8>42: r8-=12
    if sec=='Outro' and bb['k']==3: add(2,ts,L,r8,90); continue
    hits=[(0,7),(10,4)] if not half else [(0,6)]
    if REV>=2 and e>.75 and not half: hits=[(0,6),(7,2),(10,3),(14,2)]
    for s,d in hits:
      p=r8+(12 if REV>=2 and s==14 else 0)
      add(2,ts+s*S,d*S-20,p,(104 if s==0 else 88)*(.8+.25*e),2)
  # drums: half time (clap on beat 3), trap hats with rolls, ghost rims
  if sec=='Intro' and bb['k']<2: continue
  if sec=='Outro' and bb['k']>=2:
    if bb['k']==3: add(4,t0,PPQ*4,49,52)
    continue
  bridgebreak= REV>=3 and sec=='Bridge' and bb['k']<4
  kick=[0,10]+([7] if e>.7 else [])+([13] if bb['k']%2 and e>.55 else [])
  if bridgebreak: kick=[0]
  for s in kick: add(4,t0+s*S,S,36,(108 if s==0 else 90)*(.85+.2*e),2)
  if not bridgebreak:
    add(4,t0+8*S+6,S,39,(100+15*e)); add(4,t0+8*S+6,S,38,60+30*e)
  gh=[3,5,11,14,15] if REV>=2 else []
  for s in random.sample(gh,min(len(gh),1+int(3*e))): add(4,t0+s*S,60,37,22+random.randint(0,14),8)
  # hats: 8ths in verse 1, 16ths later, rolls (16th triplets / 32nds) at bar end on odd bars
  step=2 if (e<.55 or bridgebreak) else 1; roll= bb['k']%2==1 and e>.5 and not bridgebreak
  for s in range(0,16,step):
    if roll and s>=12: continue
    add(4,t0+s*S,50,42,(70 if s%4==0 else 52 if s%2==0 else 36+random.randint(0,10))*(.6+.45*e),3)
  if roll:
    if bb['k']%4==1 or REV==1:
      for k in range(6): add(4,t0+12*S+k*(2*S//3),40,42,40+k*7,raw=True)
    else:
      for k in range(8): add(4,t0+12*S+k*(S//2),30,42,34+k*6,raw=True)
  if e>.75 and REV>=2: add(4,t0+14*S,S*2,46,55)
  if bb['k']==0 and ('Chorus' in sec and not sec.startswith('Pre')): add(4,t0,PPQ*3,49,90 if sec=='Final Chorus' else 74)
  if bb['last'] and sec!='Outro' and REV>=2:
    for k,s in enumerate([12,13,14,15]): add(4,t0+s*S,S,[38,45,43,41][k],50+k*10,3)
total=len(bars)
if REV>=2:
  for k in N:
    for x in N[k]:
      e=bars[min(total-1,x['tick']//BAR)]['e']; f=(0.88+0.14*e) if k in(0,7) else (0.64+0.42*e)
      x['velocity']=max(1,min(127,int(x['velocity']*f)))
vol={1:[100,90,108,60,96,70,58,70],2:[112,84,104,54,92,66,56,80],3:[116,82,92,52,90,70,56,78]}[REV]
prog=[59,5,38,92,0,24,53,11]; pan=[64,48,64,82,64,30,44,96]
roles=['melody','harmony','bass','accompaniment','percussion','accompaniment','harmony','melody']
steps=[{"tool":"gbk_create_project","args":{"name":"Hollow Moon","tempo":BPM,"timeSignature":[4,4],"key":"B minor","ppq":PPQ,"replaceCurrent":True}}]
steps+=[{"tool":"gbk_create_track","args":{"name":TR[k],"program":prog[k],"role":roles[k],"pan":pan[k],"volume":vol[k]}} for k in range(len(TR))]
steps+=[{"tool":"gbk_set_tempo_map","args":{"events":[{"bar":1,"bpm":BPM}]}},{"tool":"gbk_set_song_structure","args":{"sections":secs}}]
alln=[n for k in N for n in N[k]]
for i in range(0,len(alln),1500): steps+=[{"tool":"gbk_propose_note_patch","args":{"add":alln[i:i+1500]}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[1]","$track[3]","$track[5]"],"controller":11,"shape":"crescendo","from":60,"to":120,"range":{"unit":"bars","start":1,"end":5}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}},
        {"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[3]","$track[5]","$track[7]"],"controller":11,"shape":"decrescendo","from":120,"to":35,"range":{"unit":"bars","start":total-1,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
json.dump({"title":"Hollow Moon","slug":"hollow-moon","composer":"Velvet Rae","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":4}},open(f"v{REV}.json","w"))
json.dump({"bars":[{"sec":b['sec']} for b in bars],"bpm":BPM,"notes":{TR[k]:N[k] for k in N}},open(f"n{REV}.json","w"))
cl=[(n,g//16+1,chord_at(g)[2],p) for g,d,p,n,e in mel if d>=2 and p%12 not in tones(g) and any((p-x)%12==1 for x in tones(g))]
print("rev",REV,"bars",total,"notes",len(alln),"sec",round(total*240/BPM),"clashes",len(cl),cl[:10])
