import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;E=240;S16=120;BAR=1920;BPM=100;SLUG="drifting_through_coral_cove"
tr={k:[] for k in("lead","arp","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(d),pitch=p,velocity=max(1,min(127,int(v)))))
# (bass root, arp chord tones)
F7=(41,[65,69,72,76]);GF=(43,[67,71,74,77]);Em7=(40,[64,67,71,74]);Am7=(45,[64,69,72,76]);Dm7=(38,[62,65,69,72])
G=(43,[62,67,71,74]);Bb7=(46,[65,69,70,74]);C=(36,[64,67,72,76]);Gm7=(43,[65,67,70,74]);Db7=(37,[65,68,72,73]);C7=(36,[64,67,70,72]);F=(41,[65,69,72,77])
INTRO=[[(0,6),(72,1),(74,1)],[(76,1),(79,1),(81,1),(84,1),(0,4)]]
MA=[[(72,2),(76,1),(79,1),(81,3),(79,1)],[(83,2),(81,1),(79,1),(76,4)],[(74,1),(76,1),(79,2),(83,2),(81,2)],[(79,3),(76,1),(72,4)],
    [(77,2),(81,1),(84,1),(86,3),(84,1)],[(83,2),(79,1),(81,1),(83,4)],[(81,1),(79,1),(77,1),(74,1),(77,2),(81,2)],[(79,6),(0,2)]]
MA2=MA[:6]+[[(81,1),(79,1),(77,1),(76,1),(74,2),(76,2)],[(77,6),(0,2)]]
MB=[[(74,1),(77,1),(81,2),(77,1),(81,1),(84,2)],[(84,3),(82,1),(79,4)],[(76,1),(79,1),(83,2),(84,4)],[(81,3),(77,1),(74,4)],
    [(74,1),(77,1),(82,2),(77,1),(82,1),(86,2)],[(84,3),(82,1),(79,2),(76,2)],[(77,2),(80,2),(84,2),(85,2)],[(84,4),(82,2),(79,2)]]
CA=[F7,GF,Em7,Am7,Dm7,G,Bb7,C];CA2=CA[:7]+[F];CB=[Bb7,C,Am7,Dm7,Gm7,C,Db7,C7]
form=[("Intro",INTRO,[F7,GF],0.4),("A",MA,CA,0.7),("A2",MA2,CA2,0.75),("B",MB,CB,0.9),("A loop",MA,CA,0.8)]
bar=0;sections=[]
for name,mel,ch,en in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=en))
  intro=name=="Intro"
  for i,(root,tones) in enumerate(ch):
    t0=bar*BAR;t=t0;last=i==len(ch)-1
    for p,l in mel[i]:
      if p:
        acc=(t-t0)%960==0
        add("lead",t,l*E*(0.7 if l==1 else 0.88),p,(98 if acc else 84)+(6 if name=="B" and V>=2 else 0))
        # v2: bubble echo, lead an octave up 3 sixteenths late, quiet (only on long notes in B / A loop 2nd half)
        if V>=2 and l>=2 and (name=="B" or (name=="A loop" and i>=4)): add("arp",t+3*S16,S16*1.5,p+12,30)
      t+=l*E
    # bubbly 16th arp: up-down through chord tones
    pat=[0,1,2,3,2,1,2,1] if V<2 else [0,2,1,3,2,1,3,2]
    if True:
      for s in range(16):
        if V>=2 and name=="B" and s%4==3: continue
        v=(46 if s%4==0 else 34)-(8 if intro else 0)
        add("arp",t0+s*S16,S16*0.6,tones[pat[s%8]]+(12 if name=="A2" else 0),v)
    # triangle bass: syncopated root / 5th / octave
    if intro: add("bass",t0,BAR*0.95,root,90)
    else:
      for s,(o,l) in zip((0,3,4,6),((0,3),(7,1),(12,2),(7,2))):
        add("bass",t0+s*E,l*E*0.85,root+o,104 if s==0 else 88)
      if last and V>=2:  # walk up into next section
        tr["bass"].pop();add("bass",t0+6*E,E*0.85,root+2,88);add("bass",t0+7*E,E*0.85,root+4,90)
    # light noise kit: kick 1 & 3-and, snare-ish rim on 2 & 4, shaker 16ths
    if not intro:
      add("drums",t0,120,36,92);add("drums",t0+5*E,120,36,72)
      for b in (1,3): add("drums",t0+b*Q,90,37 if name!="B" else 38,62 if name!="B" else 70)
      for s in range(0,16,2): add("drums",t0+s*S16,50,(69 if V>=2 else 42),(40 if s%4==0 else 30))
      if V>=2 and name=="B":
        for s in (2,6,10,14): add("drums",t0+s*S16,80,46,34)
      if last: 
        for s,p in zip((12,13,14,15),(48,47,45,43)): add("drums",t0+s*S16,90,p,70+s)
      if i==0: add("drums",t0,900,55,44 if V>=2 else 58)
    else:
      add("drums",t0+(BAR-2*S16),50,42,30)
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
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='F'),mido.MetaMessage('track_name',name='Drifting Through Coral Cove')]
for k,(ch,prog) in {"lead":(0,80),"arp":(1,80),"bass":(2,80),"drums":(9,0)}.items():
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=k));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,mf.length)
