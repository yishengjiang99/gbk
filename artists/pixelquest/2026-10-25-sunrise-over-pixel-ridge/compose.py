import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;E=240;BAR=1920;BPM=140
tr={k:[] for k in("lead","arp","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(d),pitch=p,velocity=max(1,min(127,v))))
A1=[[(69,1),(74,1),(78,1),(81,2),(78,1),(76,1),(74,1)],[(76,3),(73,1),(76,1),(81,3)],[(83,2),(81,1),(78,1),(74,2),(78,1),(81,1)],[(79,3),(78,1),(76,2),(74,1),(71,1)],
    [(69,1),(74,1),(78,1),(81,1),(83,1),(81,1),(78,1),(74,1)],[(76,2),(78,1),(79,1),(81,2),(79,1),(78,1)],[(79,1),(78,1),(76,1),(74,1),(71,2),(74,1),(76,1)],[(76,4),(73,2),(69,2)]]
A2=A1[:7]+[[(73,1),(76,1),(74,6)]]
B=[[(78,3),(76,1),(74,2),(71,1),(74,1)],[(74,3),(71,1),(67,2),(71,1),(74,1)],[(78,2),(81,2),(86,4)],[(85,3),(83,1),(81,3),(76,1)],
   [(79,3),(78,1),(76,2),(71,1),(76,1)],[(79,2),(83,2),(86,2),(83,1),(79,1)],[(84,3),(79,1),(76,2),(79,1),(84,1)],[(81,1),(83,1),(85,1),(86,1),(88,4)]]
CA=[(62,[62,66,69]),(57,[57,61,64]),(59,[59,62,66]),(55,[55,59,62]),(62,[62,66,69]),(57,[57,61,64]),(55,[55,59,62]),(57,[57,61,64])]
CB=[(59,[59,62,66]),(55,[55,59,62]),(62,[62,66,69]),(57,[57,61,64]),(52,[52,55,59]),(55,[55,59,62]),(48,[48,52,55]),(57,[57,61,64])]
form=[("Intro",None,[CA[0]]*2,0.5),("A",A1,CA,0.8),("A'",A2,CA,0.85),("B",B,CB,0.9),("A reprise",A1,CA,1.0)]
bar=0;sections=[]
for name,mel,ch,en in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=en))
  for i,(root,tri) in enumerate(ch):
    t0=bar*BAR
    if mel:
      t=t0
      for p,l in mel[i]:
        add("lead",t,l*E*(0.9 if l==1 else 0.95),p,(104 if (t-t0)%960==0 else 92)+(6 if name=="A reprise" else 0))
        if V>=2 and name in("A'","B","A reprise") and l>=2: add("arp",t+E*1.5,E*0.5,p-12+12,40) # echo blip
        t+=l*E
    # arp 16ths up-down
    pat=tri+[tri[0]+12]+tri[::-1][:-1]+[tri[1]] if V>=2 else tri+[tri[0]+12]
    for s in range(16):
      p=pat[s%len(pat)]+12
      add("arp",t0+s*120,100,p,(62 if s%4==0 else 50) if mel else 46)
    # octave bass
    for s in range(8):
      p=root-24+(12 if s%2 else 0)
      if V>=2 and i%4==3 and s>=6: p=root-24+(7 if s==6 else 10)  # walk-up pickup
      add("bass",t0+s*E,E*0.8,p,108 if s%2==0 else 92)
    # drums
    for s in range(16):
      if s in(0,8,11) or (V>=2 and s==14 and i%2): add("drums",t0+s*120,100,36,112)
      if s in(4,12): add("drums",t0+s*120,100,38,108)
      if s%2==0: add("drums",t0+s*120,60,42,72 if s%4==0 else 56)
    if V>=2 and i==len(ch)-1: 
      for s in(12,13,14,15): add("drums",t0+s*120,100,38,80+s*2)
    if i==0 and name!="Intro": add("drums",t0,800,49,100)
    bar+=1
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if a["tick"]==c["tick"]: c["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[k]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
json.dump(dict(tracks=tr,sections=sections,bars=bar,bpm=BPM),open("plan.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('key_signature',key='D'),mido.MetaMessage('track_name',name='Sunrise Over Pixel Ridge')]
for k,(ch,prog) in {"lead":(0,80),"arp":(1,80),"bass":(2,38),"drums":(9,0)}.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"sunrise_over_pixel_ridge_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,mf.length)
