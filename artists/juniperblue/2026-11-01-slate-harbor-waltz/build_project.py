import json
P=json.load(open('plan_v4.json'))
MIX=[("Vibraphone","vibes",0,11,100,76,"melody","#4a7fd1"),("Trumpet","trumpet",1,56,110,52,"melody","#d1a24a"),("Piano","piano",2,0,90,58,"harmony","#e0a96d"),("Upright Bass","bass",3,32,104,64,"bass","#9ae06d"),("Drums","drums",9,0,80,62,"percussion","#e06d9a")]
tracks=[];notes=[];programs=[]
for i,(nm,k,ch,pr,vol,pan,role,col) in enumerate(MIX):
  tid=f"t{i+1}"
  tracks.append(dict(id=tid,name=nm,channel=ch,color=col,visible=True,role=role,mix=dict(volume=vol,pan=pan,expression=127,mute=False,solo=False)))
  programs.append(dict(id=f"p{i}",trackId=tid,channel=ch,tick=0,program=pr,bankMsb=0,bankLsb=0))
  for j,n in enumerate(P['tracks'][k]): notes.append(dict(id=f"{tid}n{j}",trackId=tid,channel=ch,**n))
proj=dict(schemaVersion=1,id="juniperblue-slate-harbor-waltz",revision=0,name="Slate Harbor Waltz",ppq=480,format=1,tracks=tracks,notes=notes,ccs=[],pitchBends=[],channelPressure=[],polyPressure=[],programs=programs,
  tempos=[dict(tick=0,microPerQuarter=round(60e6/P['bpm']))],timeSigs=[dict(tick=0,numerator=3,denominator=4)],raw=[],endTick=P['endTick'],
  sound=dict(tracks={},effects=dict(enabled=True,roomSize=0.4,damping=0.55,reverbLevel=0.18,chorusLevel=0,chorusDepthMs=1,chorusRateHz=0.4,chorusDelayMs=10)),
  meta=dict(key="D dorian",sections=P['sections'],style="modal jazz waltz"))
json.dump(proj,open('project.gbk.json','w'))
print(len(notes))
