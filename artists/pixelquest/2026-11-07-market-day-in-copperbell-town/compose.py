import json,sys,mido
V=int(sys.argv[1]) if len(sys.argv)>1 else 1
Q=480;BAR=1920;BPM=132;SLUG="market_day_in_copperbell_town"
SW=320  # swung offbeat 8th (2:1 shuffle)
def pos(k): return (k//2)*Q+(k%2)*SW
tr={k:[] for k in("lead","stab","harm","bass","drums")}
def add(k,t,d,p,v): tr[k].append(dict(tick=int(t),duration=int(max(30,d)),pitch=p,velocity=max(1,min(127,int(v)))))
# Bb major. (bass root, stab triad)
Bb=(34,[62,65,70]);F=(29,[60,65,69]);Gm=(31,[62,67,70]);Eb=(39,[63,67,70]);Cm=(36,[63,67,72])
Dm=(38,[62,65,69]);D7=(38,[60,66,69]);C7=(36,[60,64,70]);F7=(29,[63,65,69])
# Lead in swung eighths (pitch, length in eighths); 0 = rest.
INTRO=[[(86,2),(82,2),(77,4)],[(0,8)],[(84,2),(82,2),(79,2),(75,2)],[(77,4),(0,2),(72,1),(75,1)]]
MA=[
 [(77,1),(77,1),(74,1),(77,1),(79,2),(77,2)],            # market cry: F F D F G F
 [(75,1),(74,1),(72,1),(74,1),(72,2),(69,2)],
 [(70,1),(74,1),(79,1),(82,1),(81,1),(79,1),(77,1),(74,1)],
 [(75,3),(79,1),(82,2),(79,2)],
 [(77,1),(77,1),(74,1),(77,1),(82,2),(81,1),(79,1)],
 [(81,1),(84,1),(81,1),(77,1),(75,2),(74,1),(72,1)],
 [(70,1),(72,1),(76,1),(79,1),(82,2),(81,1),(79,1)],
 [(81,4),(0,2),(72,1),(75,1)],                            # half cadence on F, pickup back to the cry
]
MA2=MA[:6]+[[(75,1),(79,1),(84,1),(79,1),(81,2),(77,2)],[(82,3),(0,1),(74,1),(77,1),(79,1),(81,1)]]
MB=[
 [(82,2),(79,1),(82,1),(84,2),(82,2)],
 [(81,1),(77,1),(81,1),(84,1),(86,2),(84,2)],
 [(86,3),(84,1),(81,2),(77,2)],
 [(79,2),(82,2),(86,4)],
 [(87,2),(86,1),(84,1),(79,2),(75,2)],
 [(78,1),(81,1),(84,1),(86,1),(84,2),(81,2)],
 [(82,2),(81,1),(79,1),(74,2),(79,2)],
 [(77,1),(81,1),(84,1),(87,1),(86,2),(84,1),(81,1)],
]
CI=[Bb,F,Eb,F];CA=[Bb,F,Gm,Eb,Bb,F,C7,F];CA2=[Bb,F,Gm,Eb,Bb,F,Cm,Bb];CB=[Eb,F,Dm,Gm,Cm,D7,Gm,F7]
form=[("Intro",INTRO,CI),("A",MA,CA),("A2",MA2,CA2),("B",MB,CB),("A loop",MA,CA)]
EN={"Intro":0.4,"A":0.7,"A2":0.75,"B":0.9,"A loop":0.8}
bar=0;sections=[]
for name,mel,ch in form:
  sections.append(dict(name=name,startBar=bar+1,bars=len(ch),energy=EN[name]))
  intro=name=="Intro";isB=name=="B"
  for i,(root,tri) in enumerate(ch):
    t0=bar*BAR;k=0;last=i==len(ch)-1
    lead_notes=[]
    for p,l in mel[i]:
      if p:
        st=pos(k);en=pos(k+l);on=k%2==0
        v=(98 if k%4==0 else 88 if on else 80)+(6 if isB else 0)-(14 if intro else 0)
        if V>=2 and not on: v+=4   # v2: push the swung offbeats a bit
        g=0.72 if l==1 else 0.9
        if V>=2 and last and k+l==8: g=0.97   # legato pickup across the loop seam
        add("lead",t0+st,(en-st)*g,p,v);lead_notes.append((st,en,p,l))
      k+=l
    # harmony: v2 adds a 3rd/6th-below pulse line in A2/B/A loop on long notes
    if V>=2 and name in("A2","B","A loop"):
      pcs=set(x%12 for x in tri)
      for st,en,p,l in lead_notes:
        if l<2: continue
        for d in (3,4,5,8,9):
          if (p-d)%12 in pcs: add("harm",t0+st,(en-st)*0.85,p-d,(70 if isB else 60));break
    # oom-pah: bass on 1 & 3, stabs on 2 & 4 + swung 'and' of 4
    if V>=2: root+=12
    if intro and i<2:
      add("bass",t0,Q*1.5,root,80)
      for b in (1,3):
        for n in tri: add("stab",t0+b*Q,110,n,52)
    else:
      bv=100+(6 if isB else 0)-(10 if intro else 0)
      add("bass",t0,Q*0.8,root,bv)
      add("bass",t0+2*Q,Q*0.8,root+7,bv-10)
      if V>=2 and isB:
        for b in (1,3): add("bass",t0+b*Q+SW,130,root+12,bv-22)
      if isB or (V>=2 and not intro):
        # swung walk-up on beat 4 into the next bar
        add("bass",t0+3*Q,Q*0.55,root+(12 if not isB else 9),bv-16)
        add("bass",t0+3*Q+SW,(150 if V<2 else 155),root+(11 if not isB else 10),bv-20)
      else:
        add("bass",t0+3*Q,Q*0.6,root+12,bv-14)
      sv=(62 if not isB else 70)-(8 if intro else 0)
      for b in (1,3):
        for n in tri: add("stab",t0+b*Q,120,n,sv)
      for n in tri: add("stab",t0+3*Q+SW,(90 if V<2 else 140),n,sv-14)
      if isB:
        for n in tri: add("stab",t0+1*Q+SW,90,n,sv-18)
    # drums: shuffle kit — kick 1&3, snare 2&4, swung hats, cowbell, tambourine in B
    if intro:
      for b in range(4): add("drums",t0+b*Q,60,76 if b%2==0 else 77,46+i*6)   # woodblock tick-tock
      if i>=2:
        for b in range(4): add("drums",t0+b*Q+SW,40,42,30)
      if last:
        for s,p in zip((8,9,10,11,12,13,14,15),(38,38,45,45,43,43,41,38)):
          add("drums",t0+pos(s),70,p,48+s*3)
    else:
      add("drums",t0,100,36,92);add("drums",t0+2*Q,100,36,80)
      for b in (1,3): add("drums",t0+b*Q,80,38,(70 if isB else 62))
      for b in range(4):
        add("drums",t0+b*Q,40,42,40+(6 if isB else 0));add("drums",t0+b*Q+SW,40,42,28+(6 if isB else 0))
      if isB:
        for b in (1,3): add("drums",t0+b*Q,60,54,40)
      add("drums",t0+3*Q+SW,60,56,(34 if V>=2 else 44))  # cowbell on swung and-of-4
      if i==0: add("drums",t0,600,49,(62 if isB else 46) if V<2 else (58 if isB else 36))
      if last:
        for s,p in zip((12,13,14,15),(45,43,41,38)): add("drums",t0+pos(s),70,p,56+s)
    bar+=1
for kk,N in tr.items():
  N.sort(key=lambda n:(n["pitch"],n["tick"]))
  for a,c in zip(N,N[1:]):
    if a["pitch"]==c["pitch"] and a["tick"]+a["duration"]>c["tick"]:
      if a["tick"]==c["tick"]: c["velocity"]=0
      else: a["duration"]=max(30,c["tick"]-a["tick"]-10)
  tr[kk]=sorted([n for n in N if n["velocity"]>0],key=lambda n:(n["tick"],n["pitch"]))
mix=[m for m in json.load(open("mix.json")) if tr.get(m[1])]
json.dump(dict(tracks=tr,sections=sections,bars=bar,bpm=BPM),open("plan.json","w"))
json.dump(mix,open("mix_used.json","w"))
mf=mido.MidiFile(type=1,ticks_per_beat=Q);t0=mido.MidiTrack();mf.tracks.append(t0)
t0+=[mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM)),mido.MetaMessage('time_signature',numerator=4,denominator=4),mido.MetaMessage('key_signature',key='Bb'),mido.MetaMessage('track_name',name='Market Day in Copperbell Town')]
for nm,k,ch,prog,vol,pan in mix:
  t=mido.MidiTrack();mf.tracks.append(t);t.append(mido.MetaMessage('track_name',name=nm));t.append(mido.Message('program_change',channel=ch,program=prog))
  t.append(mido.Message('control_change',channel=ch,control=7,value=min(127,vol)));t.append(mido.Message('control_change',channel=ch,control=10,value=pan))
  ev=[]
  for n in tr[k]: ev+=[(n["tick"],1,mido.Message('note_on',channel=ch,note=n["pitch"],velocity=n["velocity"])),(n["tick"]+n["duration"],0,mido.Message('note_off',channel=ch,note=n["pitch"]))]
  ev.sort(key=lambda e:(e[0],e[1]));l=0
  for tk,_,m in ev: t.append(m.copy(time=tk-l));l=tk
mf.save(f"{SLUG}_v{V}.mid")
print({k:len(v) for k,v in tr.items()},bar,round(mf.length,2))
