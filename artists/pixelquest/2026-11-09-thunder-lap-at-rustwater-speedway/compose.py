import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;S=120;BAR=1920;BPM=176;SLUG="thunder_lap_at_rustwater_speedway"
tr={k:[] for k in("lead","arp","harm","count","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(max(30,d)),pitch=p,velocity=max(1,min(127,int(v)))))
# F# minor. (bass root, triad)
Fm=(30,[66,69,73]);D=(26,[62,66,69]);E=(28,[64,68,71]);Cs=(25,[61,65,68]);Bm=(23,[62,66,71]);A=(33,[64,69,73]);Cs7=(25,[59,65,68])
# Lead in 16ths (pitch, length); 0 = rest.
MA=[
 [(78,2),(78,1),(81,1),(80,2),(78,2),(73,3),(76,1),(78,4)],
 [(81,2),(78,2),(74,2),(78,2),(81,3),(83,1),(81,2),(78,2)],
 [(80,2),(76,2),(71,2),(76,2),(80,3),(81,1),(83,4)],
 [(85,6),(83,2),(80,2),(77,2),(73,4)],
 [(78,2),(78,1),(81,1),(80,2),(78,2),(85,3),(83,1),(81,4)],
 [(86,3),(85,1),(83,2),(81,2),(78,4),(74,4)],
 [(74,2),(78,2),(83,2),(86,2),(85,2),(83,2),(81,2),(80,2)],
 [(77,4),(80,4),(85,6),(0,2)],
]
MA2=MA[:6]+[[(80,2),(83,2),(88,2),(86,2),(85,2),(83,2),(80,2),(76,2)],[(78,8),(0,4),(73,2),(76,2)]]
MB=[
 [(81,6),(85,2),(88,4),(85,4)],[(83,6),(80,2),(76,4),(80,4)],
 [(81,4),(78,2),(81,2),(86,4),(85,2),(83,2)],[(83,8),(80,4),(83,4)],
 [(85,4),(88,2),(85,2),(81,4),(85,4)],[(88,6),(86,2),(83,4),(80,4)],
 [(86,4),(83,2),(78,2),(83,4),(86,4)],[(85,4),(83,4),(80,2),(77,2),(73,2),(77,2)],
]
MC=[
 [(66,1),(0,1),(69,1),(0,1),(73,1),(0,1),(78,2),(0,8)],[(0,8),(78,1),(0,1),(76,1),(0,1),(73,2),(76,2)],
 [(74,1),(0,1),(78,1),(0,1),(81,1),(0,1),(86,2),(0,8)],[(0,8),(85,1),(0,1),(83,1),(0,1),(81,2),(78,2)],
 [(71,1),(0,1),(74,1),(0,1),(78,1),(0,1),(83,2),(0,8)],[(0,8),(86,1),(0,1),(83,1),(0,1),(78,2),(83,2)],
 [(77,2),(80,2),(85,2),(80,2),(77,2),(80,2),(85,2),(89,2)],[(85,12),(73,2),(76,2)],
]
MI=[[(0,16)]]*4
CI=[Fm,Fm,Fm,Cs];CA=[Fm,D,E,Cs,Fm,D,Bm,Cs];CA2=[Fm,D,E,Cs,Fm,D,E,Fm]
CB=[A,E,D,E,A,E,Bm,Cs7];CC=[Fm,Fm,D,D,Bm,Bm,Cs,Cs]
form=[("Intro",MI,CI),("A",MA,CA),("A2",MA2,CA2),("B",MB,CB),("C",MC,CC),("A loop",MA,CA)]
EN={"Intro":0.4,"A":0.8,"A2":0.85,"B":0.9,"C":0.7,"A loop":0.9}
bar=0;sections=[]
for name,mel,ch in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=EN[name]))
  intro=name=="Intro";isB=name=="B";isC=name=="C"
  for i,(root,tri) in enumerate(ch):
    t0=bar*BAR;k=0;last=i==len(ch)-1;lead=[]
    for p,l in mel[i]:
      if p:
        v=(100 if k%4==0 else 88)+(4 if isB else 0)+(8 if V>=2 and isB else 0)
        g=0.6 if l==1 else 0.85 if l<4 else 0.92
        add("lead",t0+k*S,l*S*g,p,v);lead.append((k,l,p))
      k+=l
    if V>=2 and (isB or name=="A loop" or name=="A2"):
      pcs=set(x%12 for x in tri)
      for k0,l,p in lead:
        if l<2: continue
        for d in (3,4,5,8,9):
          if (p-d)%12 in pcs: add("harm",t0+k0*S,l*S*0.8,p-d,62+(8 if isB else 0));break
    # countdown: 3 beeps then GO
    if intro:
      if i<3: add("count",t0,Q*1.6,81,96)
      else:
        for n in (81,85,90,93): add("count",t0,Q*2.5,n,104)
      # engine idle: low 16th pulse
      for s in range(16):
        if i<3 or s<8: add("bass",t0+s*S,70,root+12,(54 if s%4==0 else 38)+i*8)
      if i==3:
        for s in range(8,16): add("bass",t0+s*S,90,root+12+(s-8),70+s*2)
        for s in range(8,16): add("drums",t0+s*S,70,38,60+s*3)
        add("drums",t0+15*S,100,49,90)
      else:
        add("drums",t0,80,36,70)
      bar+=1;continue
    # arp: 16th chord arps up/down (two octaves)
    up=tri+[tri[0]+12,tri[1]+12,tri[2]+12]
    pat=up+up[-2:0:-1]+up[:6]
    if V>=2 and not isC: pat=[x+12 for x in pat]
    for s in range(16):
      if isC and i<6 and s%2: continue
      add("arp",t0+s*S,S*0.7,pat[s%len(pat)],(64 if s%4==0 else 50)+(6 if isB else 0))
    # bass: driving 8th octaves; 16ths in C
    br=root+12 if V>=2 else root
    bv=(104 if not isC else 96)-(0 if V<2 else 6 if not isC else 18)
    step=1 if isC else 2
    for s in range(0,16,step):
      p=br+(12 if (s//step)%2 else 0)
      add("bass",t0+s*S,S*step*0.7,p,bv-(0 if s%4==0 else 14))
    # drums: racing beat
    kv=(0.8 if V>=2 else 1.0)
    if V>=2 and isC and i<4: add("drums",t0,100,36,80)
    else: add("drums",t0,100,36,100*kv);add("drums",t0+6*S,100,36,84*kv);add("drums",t0+8*S,100,36,92*kv)
    if not isC or i>=4:
      for s in (4,12): add("drums",t0+s*S,90,38,84)
    hs=1 if (isB or (isC and i>=6)) else 2
    for s in range(0,16,hs): add("drums",t0+s*S,30,42,(44 if s%4==0 else 32))
    if i==0: add("drums",t0,800,49,(88 if V<2 else 72))
    if isB: add("drums",t0+4*S,60,54,46);add("drums",t0+12*S,60,54,46)
    if last:
      for s,p in zip(range(8,16),(38,38,45,45,43,43,41,38)): add("drums",t0+s*S,70,p,64+s*2)
    bar+=1
for kk,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if a["tick"]==c["tick"]: c["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[kk]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
mix=[m for m in json.load(open(f"mix_v{V}.json")) if tr.get(m[1])]
json.dump(dict(tracks=tr,sections=sections,bars=bar,bpm=BPM),open("plan.json","w"))
json.dump(mix,open("mix_used.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='F#m'),mido.MetaMessage('track_name',name='Thunder Lap at Rustwater Speedway')]
for nm,k,ch,prog,vol,pan in mix:
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm));t.append(mido.Message('program_change',channel=ch,program=prog))
  t.append(mido.Message('control_change',channel=ch,control=7,value=min(127,vol)));t.append(mido.Message('control_change',channel=ch,control=10,value=pan))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,round(mf.length,2))
