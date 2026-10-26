import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;E=240;S=120;BAR=1920;BPM=170;SLUG="boss_of_the_iron_citadel"
tr={k:[] for k in("lead","arp","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(d),pitch=p,velocity=max(1,min(127,int(v)))))
# E minor. pitch 0 = rest. lengths in eighths
INTRO=[[(76,1),(0,1),(76,1),(0,1),(77,2),(76,2)],[(75,4),(71,4)],[(83,8)],[(88,1),(83,1),(79,1),(76,1),(75,1),(71,1),(75,1),(71,1)]]
A=[[(76,2),(76,1),(74,1),(76,1),(79,1),(78,1),(76,1)],[(71,3),(74,1),(76,2),(71,2)],[(72,2),(76,1),(79,1),(84,2),(83,1),(79,1)],[(81,3),(78,1),(74,2),(78,1),(81,1)],
   [(83,2),(83,1),(81,1),(79,1),(78,1),(76,1),(79,1)],[(78,3),(76,1),(71,4)],[(72,1),(76,1),(79,1),(84,1),(83,1),(79,1),(76,1),(72,1)],[(75,2),(78,2),(81,2),(83,2)]]
A2=A[:6]+[[(84,2),(83,1),(81,1),(79,2),(78,2)],[(75,1),(78,1),(83,6)]]
B=[[(81,3),(84,1),(83,2),(81,2)],[(78,3),(81,1),(75,4)],[(76,1),(79,1),(83,1),(88,3),(86,1),(83,1)],[(84,4),(79,2),(76,2)],
   [(72,1),(76,1),(81,1),(84,1),(88,2),(86,2)],[(86,2),(81,1),(78,1),(74,2),(78,2)],[(75,1),(78,1),(81,1),(83,1),(87,2),(83,1),(81,1)],[(83,8)]]
Em=(40,[64,67,71]);C=(36,[60,64,67]);Dm=(38,[62,66,69]);Bm=(35,[63,66,71]);Am=(33,[57,60,64])
CA=[Em,Em,C,Dm,Em,Em,C,Bm];CB=[Am,Bm,Em,C,Am,Dm,Bm,Bm]
form=[("Intro stinger",INTRO,[Em,Em,Bm,Bm],0.7),("A",A,CA,0.85),("A2",A2,CA,0.9),("B",B,CB,0.95),("B2",B,CB,1.0),("A loop",A,CA,0.9)]
bar=0;sections=[]
for name,mel,ch,en in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=en))
  intro=name.startswith("Intro")
  for i,(root,tri) in enumerate(ch):
    t0=bar*BAR;t=t0
    for p,l in mel[i]:
      if p: 
        acc=(t-t0)%960==0
        add("lead",t,l*E*(0.8 if l==1 else 0.92),p,(112 if acc else 98)+(4 if name=="B2" else 0))
        if name=="B2" and V>=2: add("arp",t,l*E*0.85,p-12,58)  # octave doubling in B2
      t+=l*E
    # arp
    if intro and i<2: pass
    elif intro:
      run=[40,43,47,52,55,59,64,67,71,76,79,83,88,91,95,100] if i==2 else [100,95,91,88,83,79,76,71,67,64,59,55,52,47,43,40]
      for s,p in enumerate(run): add("arp",t0+s*S,100,min(p,108)-(0 if p<100 else 0),60)
    else:
      if name.startswith("B"): pat=[tri[0]+12,tri[1]+12,tri[2]+12,tri[0]+24,tri[1]+24,tri[2]+24,tri[0]+24,tri[2]+12]
      else: pat=tri+[tri[0]+12]+[tri[2],tri[1]] if V>=2 else tri+[tri[0]+12]
      skip=(name.startswith("B2") and V>=2)
      for s in range(16):
        if skip and s%2: continue
        add("arp",t0+s*S,96,pat[s%len(pat)]+12,(60 if s%4==0 else 48))
    # bass ostinato 16ths
    if intro and i<2:
      for s in (0,2,4,10,12): add("bass",t0+s*S,S*0.9 if s!=10 else E*2,40 if s<10 else (41 if s==10 else 40),118)
    else:
      off=[0,0,12,0,7,0,12,10,0,0,12,0,7,12,10,7]
      for s in range(16): add("bass",t0+s*S,S*0.8,root+off[s],(120 if s%4==0 else 96 if s%2==0 else 84)-(10 if intro else 0))
    # drums
    if intro and i<2:
      for s in (0,2,4,10): add("drums",t0+s*S,100,36,122)
      for s in (0,4,10): add("drums",t0+s*S,800,49,105)
    elif intro:
      for s in range(16): add("drums",t0+s*S,90,38,60+s*3+(20 if i==3 else 0))
      add("drums",t0,100,36,115)
    else:
      kicks=(0,3,6,8,10,14) if not name.startswith("B") else (0,2,4,6,8,10,12,14)
      for s in range(16):
        if s in kicks: add("drums",t0+s*S,100,36,116 if s%4==0 else 104)
        if s in(4,12): add("drums",t0+s*S,100,38,118)
        add("drums",t0+s*S,50,42,(76 if s%4==0 else 62 if s%2==0 else 50))
      if i==len(ch)-1 or (V>=2 and i==3):
        for s in (12,13,14,15) if i==3 else (8,10,12,13,14,15): add("drums",t0+s*S,90,38,90+s)
        add("drums",t0+14*S,90,45,100); add("drums",t0+15*S,90,41,105)
      if i==0: add("drums",t0,900,49,112)
    bar+=1
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if a["tick"]==c["tick"]: c["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  N=[n for n in N if n["velocity"]>0]
  if k=="drums":
    for n in N: n["velocity"]=min(n["velocity"],127)
  tr[k]=sorted(N,key=lambda n:(n["tick"],n["pitch"]))
json.dump(dict(tracks=tr,sections=sections,bars=bar,bpm=BPM),open("plan.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('key_signature',key='Em'),mido.MetaMessage('track_name',name='Boss of the Iron Citadel')]
for k,(ch,prog) in {"lead":(0,80),"arp":(1,80),"bass":(2,38),"drums":(9,0)}.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,mf.length)
