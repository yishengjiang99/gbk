# add soft vinyl crackle + fade, then loudnorm to -16 LUFS / -1.5 dBTP. usage: python3 master.py in.wav out.wav [fade_s]
import sys,subprocess,json,numpy as np,soundfile as sf
x,sr=sf.read(sys.argv[1]);fade=float(sys.argv[3]) if len(sys.argv)>3 else 3.5
if x.ndim==1:x=np.stack([x,x],1)
rng=np.random.default_rng(21);n=len(x)
# trim trailing silence to music end + 0.3 s
e=np.where(np.abs(x).max(1)>1e-4)[0];x=x[:min(n,e[-1]+int(0.3*sr))] if len(e) else x;n=len(x)
hiss=rng.normal(0,1,(n,2));
from scipy.signal import butter,lfilter
b,a=butter(2,[1500/(sr/2),7000/(sr/2)],'band');hiss=lfilter(b,a,hiss,axis=0)*0.0016
cr=np.zeros((n,2));k=rng.random(n)<(9/sr)
idx=np.where(k)[0]
for i in idx:
  L=rng.integers(8,40);amp=rng.uniform(0.004,0.02)*(1 if rng.random()<.85 else 2.2)
  env=np.exp(-np.arange(L)/(L/4))*rng.choice([-1,1])
  ch=rng.integers(0,2);seg=min(L,n-i);cr[i:i+seg,ch]+=env[:seg]*amp;cr[i:i+seg,1-ch]+=env[:seg]*amp*0.5
b2,a2=butter(1,800/(sr/2),'high');cr=lfilter(b2,a2,cr,axis=0)
y=x+hiss+cr
ramp=np.ones(n);fl=int(fade*sr);ramp[-fl:]=np.linspace(1,0,fl)**2;fi=int(0.4*sr);ramp[:fi]*=np.linspace(0,1,fi)
y*=ramp[:,None]
sf.write('/tmp/_m.wav',y,sr,subtype='FLOAT')
r=subprocess.run(["ffmpeg","-hide_banner","-nostats","-y","-i","/tmp/_m.wav","-af","loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json","-f","null","-"],capture_output=True,text=True).stderr
m=json.loads(r[r.rindex('{'):r.rindex('}')+1])
af=f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=44100"
subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-i","/tmp/_m.wav","-af",af,"-c:a","pcm_s16le",sys.argv[2]],check=True)
print("in",m['input_i'],m['input_tp'])
