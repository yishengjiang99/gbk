import json,sys
V=sys.argv[1] if len(sys.argv)>1 else '1'
P=json.load(open(f'plan_v{V}.json'))
MIX=[("Tenor Sax","tenor",0,66,0,104,70,"melody","#d1a24a"),("Vibraphone","vibes",1,11,0,88,48,"melody","#7ec8e3"),("Acoustic Grand Piano","piano",2,0,0,92,54,"harmony","#e0a96d"),("Acoustic Bass","bass",3,32,0,108,62,"bass","#9ae06d"),("Standard Kit","drums",9,0,0,90,64,"percussion","#e06d9a")]
# allow MIX override via env-like file
import os
if os.path.exists(f'mix_v{V}.json'):
  MIX=json.load(open(f'mix_v{V}.json'))
tracks=[];notes=[];programs=[]
for i,row in enumerate(MIX):
  nm,k,ch,pr,bank,vol,pan,role,col=row
  tid=f"t{i+1}"
  tracks.append(dict(id=tid,name=nm,channel=ch,color=col,visible=True,role=role,mix=dict(volume=vol,pan=pan,expression=127,mute=False,solo=False)))
  programs.append(dict(id=f"p{i}",trackId=tid,channel=ch,tick=0,program=pr,bankMsb=bank,bankLsb=0))
  for j,n in enumerate(P['tracks'][k]): notes.append(dict(id=f"{tid}n{j}",trackId=tid,channel=ch,**n))
proj=dict(schemaVersion=1,id="juniperblue-cedar-switch",revision=0,name="Cedar Switch",ppq=480,format=1,tracks=tracks,notes=notes,ccs=[],pitchBends=[],channelPressure=[],polyPressure=[],programs=programs,
  tempos=[dict(tick=0,microPerQuarter=round(60e6/P['bpm']))],timeSigs=[dict(tick=0,numerator=4,denominator=4)],raw=[],endTick=P['endTick'],
  sound=dict(tracks={},effects=dict(enabled=True,roomSize=0.5,damping=0.45,reverbLevel=0.22,chorusLevel=0.08,chorusDepthMs=1.2,chorusRateHz=0.35,chorusDelayMs=10)),
  meta=dict(key="Eb major",sections=P['sections'],style="cool west coast jazz"))
json.dump(proj,open('project.gbk.json','w'))
print('notes',len(notes),'bars',P['bars'])
