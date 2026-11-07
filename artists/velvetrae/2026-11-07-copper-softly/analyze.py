# Listen-back: density, hook count, per-section loudness, bands, lead-vs-backing. usage: analyze.py REV
import json,sys,subprocess,numpy as np,os
from scipy.io import wavfile
from scipy.signal import butter,sosfilt
R=sys.argv[1]; d=json.load(open(f"/workspace/vr8/n{R}.json")); BAR=1920; BPM=d.get('bpm',72)
secs=[]
for i,b in enumerate(d['bars']):
  if not secs or secs[-1][0]!=b['sec']: secs.append([b['sec'],i,0])
  secs[-1][2]+=1
nb=len(d['bars']); bpm=[BPM]*(nb-2)+[66,58]; start=np.concatenate([[0],np.cumsum([4*60/x for x in bpm])])
print("notes/bar:")
for n,s,c in secs:
  print(f"  {n:13s}",{k[:5]:round(sum(1 for x in v if s*BAR<=x['tick']<(s+c)*BAR)/c,1) for k,v in d['notes'].items()})
lead=sorted(d['notes']['Trumpet'],key=lambda x:x['tick']); iv=[b['pitch']-a['pitch'] for a,b in zip(lead,lead[1:])]
heads=sum(1 for i in range(len(iv)) if iv[i:i+4] in([3,2,-1,-2],[3,2,-2,-1]))
invs=sum(1 for i in range(len(iv)) if iv[i:i+4] in([-3,-2,2,3],[-2,-1,2,3],[-3,-2,1,2]))
print("hook head (+3,+2,±1/2) in lead:",heads,"inverted:",invs)
def count_pat(ivs,pat):
  return sum(1 for i in range(len(ivs)-len(pat)+1) if ivs[i:i+len(pat)]==pat)
print("  also +3+2 and -3-2 pairs:",count_pat(iv,[3,2]),count_pat(iv,[-3,-2]))
dr=d['notes']['Drums']; print("drum ghosts (vel<40):",sum(1 for x in dr if x['velocity']<40 and x['pitch'] in(37,38)),"of",len(dr))
w=f"/workspace/vr8/out{R}/song.wav"
raw=f"/workspace/vr8/out{R}/raw44.wav"
rawnl=f"/workspace/vr8/out{R}nl/raw44.wav"
sr,a=wavfile.read(w); a=a.astype(np.float64)/32768; m=a.mean(1) if a.ndim>1 else a
leadsig=None; back=None
if os.path.exists(raw) and os.path.exists(rawnl):
  _,rf=wavfile.read(raw); _,rn=wavfile.read(rawnl)
  rf=rf.astype(np.float64); rn=rn.astype(np.float64)
  rf=rf.mean(1)/32768 if rf.ndim>1 else rf/32768
  rn=rn.mean(1)/32768 if rn.ndim>1 else rn/32768
  n=min(len(rf),len(rn)); leadsig=rf[:n]-rn[:n]; back=rn[:n]
bp=lambda lo,hi,x: sosfilt(butter(4,[lo/(sr/2),min(hi,sr/2-1)/(sr/2)],'bandpass',output='sos'),x)
db=lambda x: 10*np.log10(np.mean(x**2)+1e-12)
bands=[(25,90),(90,250),(250,1000),(1000,4000),(4000,14000)]
print("section  LUFS | band dB rel total: sub low lowmid mid high | lead-vs-backing 500-4k dB")
for nme,s,c in secs:
  t0,t1=start[s],start[s+c]
  o=subprocess.run(["ffmpeg","-hide_banner","-ss",str(t0),"-t",str(t1-t0),"-i",w,"-af","ebur128","-f","null","-"],capture_output=True,text=True).stderr
  I=[l for l in o.splitlines() if l.strip().startswith("I:")]
  I=I[-1].split()[1] if I else "?"
  seg=m[int(t0*sr):int(t1*sr)]; tot=db(seg)
  bs=" ".join(f"{db(bp(lo,hi,seg))-tot:6.1f}" for lo,hi in bands)
  lv=""
  if leadsig is not None:
    ls=leadsig[int(t0*sr):int(t1*sr)]; bk=back[int(t0*sr):int(t1*sr)]
    if len(ls)>100 and np.abs(ls).max()>1e-4:
      lv=f"{db(bp(500,4000,ls))-db(bp(500,4000,bk)):6.1f}"
    else:
      lv="  (no lead)"
  print(f"  {nme:13s} {I:>6s} | {bs} | {lv}")
o=subprocess.run(["ffmpeg","-hide_banner","-i",w,"-af","ebur128=peak=true","-f","null","-"],capture_output=True,text=True).stderr
print([l.strip() for l in o.splitlines()[-14:] if any(l.strip().startswith(x) for x in ('I:','LRA:','Peak:','True peak:'))])
print("clipped samples:",int((np.abs(a)>=0.999).sum()))
