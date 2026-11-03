import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;E=240;S16=120;BAR=1920;BPM=160;SLUG="winds_above_the_sky_fortress"
tr={k:[] for k in("lead","harm","arp","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(d),pitch=p,velocity=max(1,min(127,int(v)))))
# (bass root, chord tones)  E Dorian
Em=(40,[64,67,71,74]);A=(45,[64,69,73,76]);G=(43,[62,67,71,74]);D=(38,[62,66,69,74]);C=(36,[64,67,71,72])
B7=(35,[63,66,69,71]);Bm=(47,[62,66,71,74]);Am=(45,[64,67,69,72]);F=(41,[65,69,72,76])
INTRO=[[],[],[],[(0,4),(83,1),(81,1),(79,1),(78,1)]]
MA=[[(76,1),(79,1),(83,2),(81,1),(79,1),(78,1),(79,1)],[(81,3),(76,1),(73,2),(76,2)],[(74,1),(76,1),(79,2),(83,1),(81,1),(79,2)],[(78,6),(74,1),(76,1)],
    [(79,1),(84,1),(83,2),(79,2),(76,2)],[(78,1),(81,1),(86,2),(85,2),(81,2)],[(83,3),(79,1),(76,2),(79,2)],[(78,4),(75,2),(71,2)]]
MA2=MA[:6]+[[(83,2),(81,1),(78,1),(75,2),(78,2)],[(76,6),(0,2)]]
MB=[[(84,3),(83,3),(79,2)],[(81,3),(78,3),(74,2)],[(78,1),(81,1),(86,3),(85,1),(83,2)],[(83,6),(79,1),(81,1)],
    [(84,3),(83,3),(81,2)],[(81,2),(78,2),(81,2),(86,2)],[(86,3),(88,1),(86,2),(83,2)],[(87,2),(83,2),(78,2),(75,2)]]
MS=[[(81,4),(84,4)],[(83,6),(79,2)],[(79,4),(76,2),(79,2)],[(78,8)],[(81,4),(84,4)],[(88,6),(86,2)],[(84,4),(81,2),(77,2)],[(78,2),(75,2),(78,2),(81,2)]]
CI=[Em,D,C,B7];CA=[Em,A,G,D,C,D,Em,B7];CA2=CA[:6]+[B7,Em];CB=[C,D,Bm,Em,Am,D,G,B7];CS=[Am,Em,C,B7,Am,Em,F,B7]
form=[("Intro",INTRO,CI,0.5),("A",MA,CA,0.75),("A2",MA2,CA2,0.8),("B",MB,CB,0.95),("Storm",MS,CS,0.6),("A loop",MA,CA,0.85)]
bar=0;sections=[]
for name,mel,ch,en in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=en))
  intro=name=="Intro";storm=name=="Storm"
  for i,(root,tones) in enumerate(ch):
    t0=bar*BAR;t=t0;last=i==len(ch)-1
    for p,l in mel[i]:
      if p:
        acc=(t-t0)%960==0
        add("lead",t,l*E*(0.62 if l==1 else 0.86),p,(102 if acc else 88)+(4 if name=="B" else 0))
        # harmony pulse: a diatonic 3rd/6th below on long notes in B and A loop
        if V>=2 and l>=2 and (name=="B" or (name=="A loop" and i>=4)):
          h=max([x for x in tones+[x-12 for x in tones]+[x+12 for x in tones] if x<=p-3]); add("harm",t,l*E*0.8,h,70)
      t+=l*E
    # pulse arp: 16ths up through chord tones (driving), 8ths in Storm
    pat=[0,1,2,3,2,3,1,2]
    for s in range(16):
      if storm and s%2: continue
      if intro and i<2 and s%2: continue
      v=(52 if s%4==0 else 38)-(6 if intro else 0)-(10 if V>=2 and storm else 0)+(8 if V>=2 and name=="B" else 0)
      add("arp",t0+s*S16,S16*(1.6 if storm else 0.55),tones[pat[s%8]]+(12 if name in("A2","B") else 0),v)
    # bass: driving 8th octaves (root-root-oct-root), whole notes in Storm
    if storm:
      add("bass",t0,BAR*0.48,root,96 if V<2 else 84);add("bass",t0+BAR//2,BAR*0.48,root+(12 if i%2 else 7),88)
    else:
      for s in range(8):
        o=12 if s in(2,5) else (7 if s==7 and V>=2 else 0)
        add("bass",t0+s*E,E*0.7,root+o,(104 if s in (0,4) else 86)-(10 if intro and i<2 else 0)+(6 if V>=2 and name=="B" else 0))
    # drums
    if intro:
      for b in range(4): add("drums",t0+b*Q,100,36,(90 if V<2 else 58+i*8))
      if i>=2:
        for s in range(0,16,2): add("drums",t0+s*S16,50,42,40)
      if last:
        for s,p in zip(range(8,16),(38,38,38,38,48,47,45,43)): add("drums",t0+s*S16,90,p,(64+s*3) if V<2 else (44+s*3))
    elif storm:
      add("drums",t0,120,36,90);add("drums",t0+2*Q,90,38,78 if V<2 else 70)
      for b in range(4): add("drums",t0+b*Q+E,60,42,30)
      if i==0: add("drums",t0,1600,49,60 if V<2 else 48)
      if last:
        for s,p in zip(range(8,16),(38,38,38,38,48,47,45,43)): add("drums",t0+s*S16,90,p,(60+s*3) if V<2 else (42+s*3))
    else:
      # driving beat: kick 1, 2-and, 3; snare 2 & 4; 8th hats
      for tk in (0,3*E,2*Q): add("drums",t0+tk,120,36,96 if tk%Q==0 else 78)
      for b in (1,3): add("drums",t0+b*Q,90,38,84)
      for s in range(0,16,2): add("drums",t0+s*S16,50,46 if (V>=2 and name=="B" and s%4==2) else 42,(44 if s%4==0 else 34))
      if last:
        for s,p in zip((12,13,14,15),(38,38,38,38)): add("drums",t0+s*S16,80,p,(70+s*2) if V<2 else (50+s*2))
      if i==0: add("drums",t0,900,49,64 if V<2 else 56)
    bar+=1
for k,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if a["tick"]==c["tick"]: c["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[k]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
if not tr["harm"]: del tr["harm"]
json.dump(dict(tracks=tr,sections=sections,bars=bar,bpm=BPM),open("plan.json","w"))
mix=json.load(open("mix.json"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Em'),mido.MetaMessage('track_name',name='Winds Above the Sky Fortress')]
for nm,k,ch,prog,vol,pan in mix:
  if k not in tr: continue
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm));t.append(mido.Message('program_change',channel=ch,program=prog))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,mf.length)
