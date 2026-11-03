import json
P=json.load(open('plan_v4.json'))
MIX=[("Alto Sax","alto",0,65,0,100,72,"melody","#d1a24a"),("Piano","piano",1,0,0,100,50,"harmony","#e0a96d"),("Upright Bass","bass",2,32,0,96,62,"bass","#9ae06d"),("Brushes","drums",9,40,0,84,60,"percussion","#e06d9a")]
tracks=[];notes=[];programs=[]
for i,(nm,k,ch,pr,bank,vol,pan,role,col) in enumerate(MIX):
  tid=f"t{i+1}"
  tracks.append(dict(id=tid,name=nm,channel=ch,color=col,visible=True,role=role,mix=dict(volume=vol,pan=pan,expression=127,mute=False,solo=False)))
  programs.append(dict(id=f"p{i}",trackId=tid,channel=ch,tick=0,program=pr,bankMsb=bank,bankLsb=0))
  for j,n in enumerate(P['tracks'][k]): notes.append(dict(id=f"{tid}n{j}",trackId=tid,channel=ch,**n))
proj=dict(schemaVersion=1,id="juniperblue-ember-hour",revision=0,name="Ember Hour",ppq=480,format=1,tracks=tracks,notes=notes,ccs=[],pitchBends=[],channelPressure=[],polyPressure=[],programs=programs,
  tempos=[dict(tick=0,microPerQuarter=round(60e6/P['bpm']))],timeSigs=[dict(tick=0,numerator=4,denominator=4)],raw=[],endTick=P['endTick'],
  sound=dict(tracks={},effects=dict(enabled=True,roomSize=0.55,damping=0.5,reverbLevel=0.24,chorusLevel=0,chorusDepthMs=1,chorusRateHz=0.4,chorusDelayMs=10)),
  meta=dict(key="Ab major",sections=P['sections'],style="jazz ballad"))
json.dump(proj,open('project.gbk.json','w'))
print(len(notes))
