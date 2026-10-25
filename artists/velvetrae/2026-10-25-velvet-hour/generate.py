import json,random,sys
v=int(sys.argv[1]); random.seed(7)
PPQ=480; BAR=4*PPQ; BPM=72
# Ab major neo-soul. chords as (root midi, voicing intervals)
C={'Dbmaj9':(49,[0,4,7,11,14]),'Cm11':(48,[0,3,7,10,14,17]),'Fm11':(41,[0,3,7,10,14,17]),'Bb13sus':(46,[0,5,10,14,21]),
   'Abmaj9':(44,[0,4,7,11,14]),'Gm7b5':(43,[0,3,6,10]),'C7#9':(48,[0,4,10,15]),'Ebm9':(51,[0,3,7,10,14]),'Ab13':(44,[0,4,10,14,21]),
   'Gbmaj9':(42,[0,4,7,11,14])}
VERSE=['Dbmaj9','Cm11','Fm11','Bb13sus']*2
CHOR=['Dbmaj9','Cm11','Gm7b5','C7#9','Fm11','Ebm9','Ab13','Dbmaj9'] if v>1 else ['Dbmaj9','Cm11','Fm11','Bb13sus','Dbmaj9','Cm11','Fm11','Bb13sus']
BRID=['Gbmaj9','Fm11','Ebm9','Ab13'] if v>1 else ['Fm11','Fm11','Bb13sus','Bb13sus']
form=[('Intro',['Dbmaj9','Cm11','Fm11','Bb13sus'],.3),('Verse 1',VERSE,.5),('Chorus',CHOR,.8),('Verse 2',VERSE,.6),('Chorus',CHOR,.85),('Bridge',BRID,.7),('Final Chorus',CHOR,1.0),('Outro',['Dbmaj9','Cm11','Fm11','Dbmaj9'],.35)]
prog=[];secs=[];b=1
for n,cs,e in form: secs.append({"name":n,"startBar":b,"bars":len(cs),"energy":e}); prog+=[(c,n,e) for c in cs]; b+=len(cs)
N={0:[],1:[],2:[],3:[],4:[]}
def sw(t): # swing 16ths ~58%
  q=PPQ//4; i,r=divmod(t,q); return t+(int(q*0.16) if i%2 and r==0 else 0)
def add(tr,t,d,p,vel): N[tr].append({"trackId":"$track[%d]"%tr,"tick":max(0,sw(t)),"duration":max(30,d),"pitch":p,"velocity":max(1,min(127,int(vel)))})
SCALE=[56,58,60,61,63,65,67,68,70,72,73,75,77]  # Ab major around melody
motifs=[[(0,2,0),(2,1,1),(3,3,2),(8,2,1),(10,6,0)],[(1,1,2),(2,1,3),(3,2,4),(6,2,2),(9,1,1),(10,4,0)],[(0,3,4),(4,2,3),(6,2,2),(8,8,1)],[(2,1,0),(3,1,1),(4,2,2),(6,1,4),(7,5,3)]]
for i,(c,sec,e) in enumerate(prog):
  t0=i*BAR; root,iv=C[c]
  # Rhodes: rolled chord + offbeat restrike
  vv=[root+12+x for x in iv[1:]] if root<46 else [root+x for x in iv[1:]]
  for k,p in enumerate(vv): add(1,t0+k*12,BAR-PPQ if sec!='Intro' else BAR-60,p,58+e*20-k*2)
  if sec not in('Intro','Outro'): 
    for p in vv[:3]: add(1,t0+int(2.75*PPQ),PPQ//2,p,44+e*15)
  # pad
  for p in [root+12+iv[1],root+12+iv[2],root+24]: add(3,t0,BAR-20,p,40+e*20)
  if sec=='Intro' and i<2: continue
  # bass
  br=root-12 if root>=46 else root
  if sec=='Outro' and i==len(prog)-1: add(2,t0,BAR,br,80); 
  else:
    pat=[(0,int(1.4*PPQ),br,92),(int(1.75*PPQ),PPQ//4,br+12,62),(2*PPQ+PPQ//2,PPQ//2,br+7,78),(3*PPQ+PPQ//2,PPQ//4,br+(10 if 10 in iv else 7)-12+12,70)]
    for a,d,p,vv2 in pat: add(2,t0+a,d,p,vv2*(0.8+0.25*e))
  # drums (laid back +18 ticks on snare)
  if sec not in('Intro',) and not(sec=='Outro' and i>=len(prog)-2):
    add(4,t0,PPQ//2,36,96); add(4,t0+int(2.5*PPQ),PPQ//2,36,80)
    if v>1 and i%2: add(4,t0+int(2.75*PPQ),PPQ//4,36,60)
    for s in(1,3): add(4,t0+s*PPQ+18,PPQ//2,38 if e>0.55 else 37,(88 if e>0.55 else 70))
    for h in range(16 if e>0.75 else 8):
      st=PPQ//4 if e>0.75 else PPQ//2; add(4,t0+h*st,60,42,(52 if h%2 else 70)*(0.85+0.2*random.random()))
    if v>1 and i%4==3: [add(4,t0+3*PPQ+k*PPQ//4,60,38,40+k*12) for k in range(4)]
    if v>1 and sec in('Chorus','Final Chorus') and i%8==0: add(4,t0,PPQ*2,49,70)
  # lead melody (alto sax) in verse/chorus/bridge
  if sec in('Verse 1','Verse 2','Chorus','Final Chorus','Bridge'):
    if v>1 and sec.startswith('Verse') and i%2==1: continue  # leave space (call & response)
    m=motifs[(i+ (1 if 'Chorus' in sec else 0))%4]; off=4 if 'Chorus' in sec else 2
    ct=set((root+x)%12 for x in iv)
    for s,d,deg in m:
      p=SCALE[min(len(SCALE)-1,deg+off)]
      if v>1 and p%12 not in ct and d>=4: p=min(SCALE,key=lambda q:(q%12 not in ct,abs(q-p)))
      add(0,t0+s*PPQ//4,d*PPQ//4-20,p,(70+e*25)*(0.9+0.15*random.random()))
total=len(prog)
steps=[{"tool":"gbk_create_project","args":{"name":"Velvet Hour","tempo":BPM,"timeSignature":[4,4],"key":"Ab major","ppq":PPQ,"replaceCurrent":True}},
 {"tool":"gbk_create_track","args":{"name":"Alto Sax","program":65,"role":"melody","pan":72,"volume":84 if v>1 else 96}},
 {"tool":"gbk_create_track","args":{"name":"Rhodes","program":4,"role":"harmony","pan":52,"volume":98}},
 {"tool":"gbk_create_track","args":{"name":"Fretless Bass","program":35,"role":"bass","pan":64,"volume":106}},
 {"tool":"gbk_create_track","args":{"name":"Warm Pad","program":89,"role":"accompaniment","pan":80,"volume":62 if v>1 else 74}},
 {"tool":"gbk_create_track","args":{"name":"Drums","program":0,"role":"percussion","pan":64,"volume":92}},
 {"tool":"gbk_set_tempo_map","args":{"events":[{"bar":1,"bpm":BPM}]}},
 {"tool":"gbk_set_song_structure","args":{"sections":secs}}]
allnotes=[n for k in N for n in N[k]]
for i in range(0,len(allnotes),1500):
  steps+= [{"tool":"gbk_propose_note_patch","args":{"add":allnotes[i:i+1500],"summary":"Velvet Hour notes"}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
steps+=[{"tool":"gbk_generate_cc_curve","args":{"trackIds":["$track[0]","$track[1]","$track[2]","$track[3]"],"controller":11,"shape":"decrescendo","from":120,"to":30,"range":{"unit":"bars","start":total-3,"end":total+1}}},{"tool":"gbk_commit_proposal","args":{"proposalId":"$proposal"}}]
json.dump({"title":"Velvet Hour","slug":"velvet-hour","composer":"Velvet Rae","description":"Late-night neo-soul slow jam in Ab: Rhodes maj9/min11 chords, fretless bass, swung pocket drums and an alto sax line.","steps":steps,"render":{"sampleRate":44100,"channels":2,"format":"pcm16","tailSeconds":4}},open(f"/workspace/vr/v{v}.json","w"))
print(len(allnotes),total)
