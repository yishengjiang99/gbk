# "listening" pass: python3 analyze.py <dir> [wav]
import sys,json,subprocess,numpy as np,soundfile as sf
D=sys.argv[1];f=sys.argv[2] if len(sys.argv)>2 else D+"/gbk_raw.wav"
S=json.load(open(D+"/song.json"));P=json.load(open(D+"/plan.json"))
x,sr=sf.read(f);m=x.mean(1) if x.ndim>1 else x
db=lambda v:round(20*np.log10(v+1e-9),1)
print("dur",round(len(m)/sr,2),"peak",db(np.abs(x).max()),"clipped",int((np.abs(x)>=0.999).sum()))
bs=4*60/S['bpm']
for s in S['sections']:
  seg=m[int((s['startBar']-1)*bs*sr):int((s['startBar']-1+s['bars'])*bs*sr)]
  print(f"  {s['name']:6s} rms {db(np.sqrt((seg**2).mean()))}")
tail=m[-int(0.5*sr):];print("  tail(last .5s) rms",db(np.sqrt((tail**2).mean())))
# spectrum balance
F=np.abs(np.fft.rfft(m[:sr*60]*np.hanning(sr*60)))**2;fr=np.fft.rfftfreq(sr*60,1/sr)
tot=F.sum();print("  spectrum low<150 %.0f%% mid150-2k %.0f%% high>2k %.0f%%"%tuple(100*F[(fr>=a)&(fr<b)].sum()/tot for a,b in((0,150),(150,2000),(2000,22050))))
r=subprocess.run(["ffmpeg","-hide_banner","-nostats","-i",f,"-af","ebur128=peak=true","-f","null","-"],capture_output=True,text=True).stderr
print("  "+" | ".join(l.strip() for l in r.splitlines()[-20:] if any(k in l for k in("I:","LRA:","Peak:"))))
# score
L=P['lead'];allN=[n for N in P.values() for n in N]
print("notes",{k:len(v) for k,v in P.items()},"maxdur",max(n['duration'] for n in allN),"last note end tick",max(n['tick']+n['duration'] for n in allN))
pp=[n['pitch'] for n in L];iv=np.diff(pp)
print("lead range",min(pp),max(pp),"steps<=2 %.0f%%"%(100*np.mean(np.abs(iv)<=2)),"leaps>=5 %.0f%%"%(100*np.mean(np.abs(iv)>=5)),"repeated-pitch %.0f%%"%(100*np.mean(iv==0)),
 "mean dur(16ths) %.1f"%(np.mean([n['duration'] for n in L])/120))
ch=S['chords'];C={}
# strong-beat chord-tone fit
import re
cnt=ok=0
for n in L:
  b=n['tick']//1920+1;t=n['tick']%1920
  if t%960==0:
    cnt+=1
for k,N in P.items():
  if k in("drums",):continue
  print(f"  {k}: vel {min(n['velocity'] for n in N)}-{max(n['velocity'] for n in N)} durs {min(n['duration'] for n in N)}-{max(n['duration'] for n in N)}")
# comp voice-leading: mean top-voice motion between bars
tops=[];
for b in range(1,S['last']+1):
  bn=[n['pitch'] for n in P['comp'] if (b-1)*1920<=n['tick']<(b-1)*1920+200]
  if bn: tops.append(max(bn))
print("comp top-voice mean move (semitones) %.2f"%np.mean(np.abs(np.diff(tops))))
