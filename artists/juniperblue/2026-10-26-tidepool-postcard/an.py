import sys,json,numpy as np,wave
w=wave.open(sys.argv[1]);sr=w.getframerate();x=np.frombuffer(w.readframes(w.getnframes()),np.int16).reshape(-1,2)/32768
P=json.load(open(sys.argv[2]));bs=60/P['bpm']*4
pk=abs(x).max()
print('dur %.1fs peak %.3f (%.2f dBFS) clipped %d rms %.1f dBFS'%(len(x)/sr,pk,20*np.log10(pk),int((abs(x)>=0.999).sum()),20*np.log10(np.sqrt((x**2).mean()))))
def band(seg,lo,hi):
  m=seg.mean(1);S=np.abs(np.fft.rfft(m))**2;f=np.fft.rfftfreq(len(m),1/sr);return 10*np.log10(S[(f>=lo)&(f<hi)].sum()/S.sum()+1e-12)
for s in P['sections']:
  a=int((s['startBar']-1)*bs*sr);b=int((s['startBar']-1+s['bars'])*bs*sr);seg=x[a:b]
  print('%-12s %5.1fs rms %6.1f dB  L/R %.2f  low<200 %5.1f  mid200-1k %5.1f  pres1k-4k %5.1f'%(s['name'],a/sr,20*np.log10(np.sqrt((seg**2).mean())),np.sqrt((seg[:,0]**2).mean()/(seg[:,1]**2).mean()),band(seg,20,200),band(seg,200,1000),band(seg,1000,4000)))
