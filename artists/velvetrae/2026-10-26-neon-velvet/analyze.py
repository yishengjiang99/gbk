import json,sys,subprocess,glob,collections
R=sys.argv[1]; d=json.load(open(f"n{R}.json")); bpm=d['bpm']; BAR=1920
secs=[];
for i,b in enumerate(d['bars']):
  if not secs or secs[-1][0]!=b['sec']: secs.append([b['sec'],i,0])
  secs[-1][2]+=1
print("density notes/bar:")
for n,s,c in secs:
  row={k:round(sum(1 for x in v if s*BAR<=x['tick']<(s+c)*BAR)/c,1) for k,v in d['notes'].items()}
  print(f"  {n:13s}",row)
lead=sorted(d['notes']['Synth Lead'],key=lambda x:x['tick']); iv=[b['pitch']-a['pitch'] for a,b in zip(lead,lead[1:])]
hook=[-2,-3,3,2,3]; print("hook interval-pattern occurrences in lead:",sum(1 for i in range(len(iv)) if iv[i:i+5]==hook))
print("lead pitch range",min(x['pitch'] for x in lead),max(x['pitch'] for x in lead),"avg vel",round(sum(x['velocity'] for x in lead)/len(lead)))
w=glob.glob(f"out{R}/*/song.wav")[0] if len(sys.argv)<3 else sys.argv[2]
for n,s,c in secs:
  st=s*4*60/bpm; du=c*4*60/bpm
  o=subprocess.run(["ffmpeg","-hide_banner","-ss",str(st),"-t",str(du),"-i",w,"-af","ebur128","-f","null","-"],capture_output=True,text=True).stderr
  I=[l for l in o.splitlines() if l.strip().startswith("I:")][-1].split()[1]
  print(f"  {n:13s} {I} LUFS")
o=subprocess.run(["ffmpeg","-hide_banner","-i",w,"-af","ebur128=peak=true","-f","null","-"],capture_output=True,text=True).stderr
print([l.strip() for l in o.splitlines()[-12:] if l.strip().split(':')[0] in('I','LRA','Peak')])
