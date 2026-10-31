import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;E=240;BAR=1440;BPM=120;SLUG="lanterns_of_hollowmere_manor"
tr={k:[] for k in("lead","arp","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(d),pitch=p,velocity=max(1,min(127,int(v)))))
Dm=(38,[62,65,69]);Bb=(34,[62,65,70]);A=(33,[61,64,69]);A7=(33,[61,64,67]);Gm=(31,[62,67,70]);D=(38,[62,66,69]);Eb=(39,[63,67,70])
INTRO=[[],[],[(74,1),(73,1),(72,1),(71,1),(70,1),(69,1)],[(68,3),(69,3)]]
MA=[[(74,3),(73,1),(74,1),(77,1)],[(76,2),(75,1),(74,3)],[(70,1),(74,1),(77,1),(82,2),(81,1)],[(80,1),(81,2),(76,3)],
    [(77,3),(76,1),(77,1),(81,1)],[(79,2),(78,1),(79,1),(82,2)],[(81,1),(80,1),(79,1),(78,1),(77,1),(76,1)],[(73,3),(0,3)]]
MA2=MA[:6]+[[(76,1),(77,1),(73,1),(76,2),(73,1)],[(74,6)]]
MB=[[(77,2),(74,1),(70,3)],[(73,1),(76,1),(79,1),(81,3)],[(82,2),(81,1),(79,2),(74,1)],[(78,3),(0,1),(78,1),(81,1)],
    [(86,2),(85,1),(84,2),(82,1)],[(79,1),(82,1),(86,1),(85,3)],[(84,2),(82,1),(79,2),(75,1)],[(73,3),(76,1),(79,1),(81,1)]]
CA=[Dm,Dm,Bb,A,Dm,Gm,A7,A];CA2=[Dm,Dm,Bb,A,Dm,Gm,A7,Dm];CB=[Bb,A,Gm,D,Bb,Gm,Eb,A]
form=[("Intro",INTRO,[Dm,Dm,Bb,A],0.5),("A",MA,CA,0.75),("A2",MA2,CA2,0.8),("B",MB,CB,0.9),("B2",MB,CB,1.0),("A loop",MA,CA,0.8)]
bar=0;sections=[]
for name,mel,ch,en in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=en))
  intro=name=="Intro"
  for i,(root,tri) in enumerate(ch):
    t0=bar*BAR;t=t0
    for p,l in mel[i]:
      if p:
        add("lead",t,l*E*(0.75 if l==1 else 0.9),p,(100 if (t-t0)%720==0 else 86)+(6 if name=="B2" else 0)+(4 if V>=2 and name.startswith("B") else 0))
        if name=="B2": add("arp",t+E,l*E*0.7,p-12,40)   # ghost echo one eighth late
        if V>=2 and name=="A loop" and i>=4: add("arp",t+E,l*E*0.7,p-12,34)
      t+=l*E
    # waltz arp: broken chord in eighths
    if not name=="B2":
      up=12 if name in("A2",) else 0
      pat=[tri[0],tri[1],tri[2],tri[1],tri[2],tri[1]]
      for s in range(6):
        if intro and s%3: continue
        add("arp",t0+s*E,E*0.8,pat[s]+up,(50 if s%3==0 else 38))
    # triangle bass: root dotted-quarter, fifth dotted-quarter; walk on last bar of section
    last=i==len(ch)-1
    add("bass",t0,E*2.6,root,104)
    if last and not intro and V>=2:
      for s,o in zip((3,4,5),(7,6,5)): add("bass",t0+s*E,E*0.85,root+o,92)
    else: add("bass",t0+3*E,E*2.6,root+7,90)
    # sparse noise percussion
    add("drums",t0,120,36,96 if not intro else 80)
    if not intro:
      for s in (2,5): add("drums",t0+s*E,60,42,44)
      if name.startswith("B"): add("drums",t0+3*E,100,38 if V<2 else 37,70)
      if i%4==3 and not last: add("drums",t0+5*E,200,46,58)
      if last: 
        for s,p in zip((3,4,5),(45,43,41)): add("drums",t0+s*E,100,p,78+s*4)
      if i==0: add("drums",t0,900,55 if V>=2 else 49,64 if V>=2 else 84)
    elif i>=2: add("drums",t0+3*E,60,42,40)
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
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=6,denominator=8),mido.MetaMessage('key_signature',key='Dm'),mido.MetaMessage('track_name',name='Lanterns of Hollowmere Manor')]
for k,(ch,prog) in {"lead":(0,80),"arp":(1,80),"bass":(2,80),"drums":(9,0)}.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,mf.length)
