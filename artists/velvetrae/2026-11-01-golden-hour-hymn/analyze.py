# Listen-back numbers for a render: density, hook count, per-section loudness, bands, lead-vs-backing. usage: analyze.py REV
import json,sys,subprocess,glob,numpy as np
from scipy.io import wavfile
from scipy.signal import butter,sosfilt
R=sys.argv[1]; d=json.load(open(f"n{R}.json")); BAR=1440
secs=[]
for i,b in enumerate(d['bars']):
  if not secs or secs[-1][0]!=b['sec']: secs.append([b['sec'],i,0])
  secs[-1][2]+=1
nb=len(d['bars']); bpm=[78]*(nb-2)+[74,66]; start=np.concatenate([[0],np.cumsum([3*60/x for x in bpm])])
print("notes/bar:")
for n,s,c in secs:
  print(f"  {n:13s}",{k[:5]:round(sum(1 for x in v if s*BAR<=x['tick']<(s+c)*BAR)/c,1) for k,v in d['notes'].items()})
lead=sorted(d['notes']['Flute'],key=lambda x:x['tick']); iv=[b['pitch']-a['pitch'] for a,b in zip(lead,lead[1:])]
print("hook head (+2,+3,-1,-2) in lead:",sum(1 for i in range(len(iv)) if iv[i:i+4]==[2,3,-1,-2]))
dr=d['notes']['Drums']; print("drum ghosts (vel<40):",sum(1 for x in dr if x['velocity']<40 and x['pitch'] in(37,38)),"of",len(dr))
w=glob.glob(f"out{R}/*/song.wav")[0]; sr,a=wavfile.read(w); a=a.astype(np.float64)/32768; m=a.mean(1)
nl=glob.glob(f"out{R}nl/*/song.wav"); g=json.load(open(glob.glob(f"out{R}/*/song.json")[0]))['render']['loudness']['gainLinear']
if nl:
  g2=json.load(open(glob.glob(f"out{R}nl/*/song.json")[0]))['render']['loudness']['gainLinear']
  _,b2=wavfile.read(nl[0]); back=b2.astype(np.float64).mean(1)/32768*g/g2; n=min(len(m),len(back)); leadsig=m[:n]-back[:n]
bp=lambda lo,hi,x: sosfilt(butter(4,[lo,hi],'bandpass',fs=sr,output='sos'),x)
db=lambda x: 10*np.log10(np.mean(x**2)+1e-12)
bands=[(25,90),(90,250),(250,1000),(1000,4000),(4000,14000)]
print("section  LUFS | band dB rel total: sub low lowmid mid high | lead-vs-backing 500-4k dB")
for nme,s,c in secs:
  t0,t1=start[s],start[s+c]
  o=subprocess.run(["ffmpeg","-hide_banner","-ss",str(t0),"-t",str(t1-t0),"-i",w,"-af","ebur128","-f","null","-"],capture_output=True,text=True).stderr
  I=[l for l in o.splitlines() if l.strip().startswith("I:")][-1].split()[1]
  seg=m[int(t0*sr):int(t1*sr)]; tot=db(seg)
  bs=" ".join(f"{db(bp(lo,hi,seg))-tot:6.1f}" for lo,hi in bands)
  lv=""
  if nl:
    ls=leadsig[int(t0*sr):int(t1*sr)]; bk=back[int(t0*sr):int(t1*sr)]
    lv=f"{db(bp(500,4000,ls))-db(bp(500,4000,bk)):6.1f}" if np.abs(ls).max()>1e-4 else "  (no lead)"
  print(f"  {nme:13s} {I:>6s} | {bs} | {lv}")
o=subprocess.run(["ffmpeg","-hide_banner","-i",w,"-af","ebur128=peak=true","-f","null","-"],capture_output=True,text=True).stderr
print([l.strip() for l in o.splitlines()[-12:] if l.strip().split(':')[0] in('I','LRA','Peak')])
print("clipped samples:",int((np.abs(a)>=0.999).sum()))
