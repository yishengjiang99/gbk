import json
P=json.load(open('plan_v3.json'))
MIX=[("Flute","flute",0,73,104,76,"melody","#4a7fd1"),("Nylon Guitar","guitar",1,24,92,44,"harmony","#d1a24a"),("Piano","piano",2,0,112,82,"harmony","#e0a96d"),("Acoustic Bass","bass",3,32,104,62,"bass","#9ae06d"),("Drums","drums",9,0,80,58,"percussion","#e06d9a")]
tracks=[];notes=[];programs=[]
for i,(nm,k,ch,pr,vol,pan,role,col) in enumerate(MIX):
  tid=f"t{i+1}"
  tracks.append(dict(id=tid,name=nm,channel=ch,color=col,visible=True,role=role,mix=dict(volume=vol,pan=pan,expression=127,mute=False,solo=False)))
  programs.append(dict(id=f"p{i}",trackId=tid,channel=ch,tick=0,program=pr,bankMsb=0,bankLsb=0))
  for j,n in enumerate(P['tracks'][k]): notes.append(dict(id=f"{tid}n{j}",trackId=tid,channel=ch,**n))
proj=dict(schemaVersion=1,id="juniperblue-tidepool-postcard",revision=0,name="Tidepool Postcard",ppq=480,format=1,tracks=tracks,notes=notes,ccs=[],pitchBends=[],channelPressure=[],polyPressure=[],programs=programs,
  tempos=[dict(tick=0,microPerQuarter=round(60e6/P['bpm']))],timeSigs=[dict(tick=0,numerator=4,denominator=4)],raw=[],endTick=P['endTick'],
  sound=dict(tracks={},effects=dict(enabled=True,roomSize=0.4,damping=0.55,reverbLevel=0.18,chorusLevel=0,chorusDepthMs=1,chorusRateHz=0.4,chorusDelayMs=10)),
  meta=dict(key="F major",sections=P['sections'],style="bossa nova"))
json.dump(proj,open('project.gbk.json','w'))
print(len(notes))
