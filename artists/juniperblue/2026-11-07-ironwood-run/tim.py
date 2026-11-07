import sys,numpy as np,wave,json
w=wave.open(sys.argv[1]);sr=w.getframerate();x=np.frombuffer(w.readframes(w.getnframes()),np.int16).reshape(-1,2).mean(1)/32768
P=json.load(open(sys.argv[2]));beat=60/P['bpm']
hop=256;fr=np.lib.stride_tricks.sliding_window_view(x,1024)[::hop]
S=np.abs(np.fft.rfft(fr*np.hanning(1024),axis=1));fl=np.maximum(0,np.diff(np.log1p(S),axis=0)).sum(1)
t=np.arange(len(fl))*hop/sr
# fold onset strength by beat phase (12 bins per beat)
ph=((t%beat)/beat*12).astype(int)%12
prof=np.array([fl[ph==i].mean() for i in range(12)]);print('beat-phase onset profile (12 bins):',' '.join('%.0f'%(100*v/prof.max()) for v in prof))
ac=np.correlate(fl-fl.mean(),fl-fl.mean(),'full')[len(fl)-1:];lag=np.arange(len(ac))*hop/sr
m=(lag>0.25)&(lag<0.5);print('tempo est %.1f BPM'%(60/lag[m][ac[m].argmax()]))
