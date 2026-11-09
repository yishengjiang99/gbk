# Render n{REV}.json -> MIDI -> fluidsynth WAV -> loudnorm MP3. usage: render.py REV [nolead]
import json,sys,os,subprocess,uuid,time,mido
REV=sys.argv[1]; NOLEAD=len(sys.argv)>2
d=json.load(open(f"/workspace/vr9/n{REV}.json"))
PPQ=480; BPM=d['bpm']; BAR=16*(PPQ//4)
outdir=f"/workspace/vr9/out{REV}"+("nl" if NOLEAD else "")
os.makedirs(outdir,exist_ok=True)
midpath=f"{outdir}/song.mid"; wavpath=f"{outdir}/song.wav"; mp3path=f"{outdir}/song.mp3"
prog=d['prog']; vol=list(d['vol']); pan=d['pan']; roles=d['roles']
if NOLEAD: vol[0]=0
TR=list(d['notes'].keys())
mid=mido.MidiFile(ticks_per_beat=PPQ)
meta=mido.MidiTrack(); mid.tracks.append(meta)
nb=len(d['bars'])
ev=[(0,mido.MetaMessage('time_signature',numerator=4,denominator=4)),
    (0,mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(BPM))),
    ((nb-2)*BAR,mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(80))),
    ((nb-1)*BAR,mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(70)))]
def flush(tr,events):
  events.sort(key=lambda e:(e[0],0 if e[1].type in('note_off','set_tempo','time_signature') else 1)); last=0
  for t,m in events: tr.append(m.copy(time=max(0,t-last))); last=t
flush(meta,ev)
for ch,name in enumerate(TR):
  tr=mido.MidiTrack(); mid.tracks.append(tr)
  mch=9 if name=='Drums' else ch
  events=[(0,mido.MetaMessage('track_name',name=name))]
  if name!='Drums':
    events.append((0,mido.Message('program_change',program=prog[ch],channel=mch)))
  events.append((0,mido.Message('control_change',control=7,value=vol[ch],channel=mch)))
  events.append((0,mido.Message('control_change',control=10,value=pan[ch],channel=mch)))
  for n in d['notes'][name]:
    t=n['tick']; dur=n['duration']; pt=n['pitch']; v=n['velocity']
    if NOLEAD and ch==0: continue
    events.append((t,mido.Message('note_on',note=pt,velocity=max(1,min(127,v)),channel=mch)))
    events.append((t+dur,mido.Message('note_off',note=pt,velocity=0,channel=mch)))
  flush(tr,events)
mid.save(midpath)
sf2="/workspace/clara4/GeneralUser-GS.sf2"
fs="/workspace/clara4/env/bin/fluidsynth"
raw=f"{outdir}/raw.wav"
subprocess.run([fs,"-ni","-g","0.55","-r","44100","-F",raw,sf2,midpath],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(["ffmpeg","-y","-loglevel","error","-i",raw,"-ar","44100",f"{outdir}/raw44.wav"],check=True)
import json as _json
probe=subprocess.run(["ffmpeg","-y","-loglevel","info","-i",raw,"-af","loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json","-f","null","-"],capture_output=True,text=True)
txt=probe.stderr
js=txt[txt.rfind('{'):txt.rfind('}')+1]
try:
  m=_json.loads(js)
  af="loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={input_i}:measured_TP={input_tp}:measured_LRA={input_lra}:measured_thresh={input_thresh}:offset={target_offset}:linear=true".format(**m)
except Exception as e:
  print("loudnorm probe fallback",e); af="loudnorm=I=-16:TP=-1.5:LRA=11"
subprocess.run(["ffmpeg","-y","-loglevel","error","-i",raw,"-af",af,"-ar","44100",wavpath],check=True)
subprocess.run(["ffmpeg","-y","-loglevel","error","-i",wavpath,"-b:a","192k",mp3path],check=True)
if not NOLEAD:
  tracks=[];notes=[];progs=[]; colors=["#f4d58d","#9ad1f5","#e8a0a0","#b8e0d2","#d4a5a5","#c9b1ff","#ffe5b4","#a8d8ea"]
  for ch,name in enumerate(TR):
    tid=f"trk_{ch}_{name.lower()}"
    tracks.append({"id":tid,"name":name,"channel":(9 if name=='Drums' else ch),"color":colors[ch%8],"visible":True,
      "mix":{"volume":vol[ch],"pan":pan[ch],"expression":127,"mute":False,"solo":False},"role":roles[ch]})
    for i,n in enumerate(d['notes'][name]):
      notes.append({"trackId":tid,"channel":(9 if name=='Drums' else ch),"tick":n['tick'],"duration":n['duration'],
                    "pitch":n['pitch'],"velocity":n['velocity'],"id":f"n_{ch}_{i:04d}"})
    if name!='Drums':
      progs.append({"id":f"pg_{ch}","trackId":tid,"channel":ch,"tick":0,"program":prog[ch],"bankMsb":0,"bankLsb":0})
  end=max(n['tick']+n['duration'] for n in notes)+PPQ
  tempos=[{"tick":0,"microPerQuarter":round(60e6/BPM)},
          {"tick":(nb-2)*BAR,"microPerQuarter":round(60e6/80)},
          {"tick":(nb-1)*BAR,"microPerQuarter":round(60e6/70)}]
  P={"schemaVersion":1,"id":"prj_"+uuid.uuid4().hex[:16],"revision":3,"name":d['title'],"ppq":PPQ,"format":1,
     "tracks":tracks,"notes":sorted(notes,key=lambda n:(n['tick'],n['pitch'])),"ccs":[],
     "pitchBends":[],"channelPressure":[],"polyPressure":[],"programs":progs,"tempos":tempos,
     "timeSigs":[{"tick":0,"numerator":4,"denominator":4}],"raw":[],"endTick":end,
     "selection":{"trackIds":[],"startTick":0,"endTick":0,"noteIds":[]},"loop":{"enabled":False,"startTick":0,"endTick":0},
     "meta":{"owner":"agent","createdAt":int(time.time()*1000),"key":"A dorian",
             "sections":d['secs'],"style":"neo-soul","descriptors":{"mood":"warm laid-back sunday","style":"sunday-drive-rnb","via":"script"}}}
  json.dump(P,open(f"{outdir}/project.json","w"))
  import shutil; shutil.copy(midpath,f"/workspace/vr9/lantern-rain.mid")
  json.dump(P,open(f"/workspace/vr9/project.json","w"))
dur=float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",mp3path],capture_output=True,text=True).stdout)
print("rendered",outdir,"dur",round(dur,1),"notes",sum(len(v) for v in d['notes'].values()))
