import sys,json,numpy as np,wave
w=wave.open(sys.argv[1]);sr=w.getframerate();x=np.frombuffer(w.readframes(w.getnframes()),np.int16).reshape(-1,2)/32768
P=json.load(open(sys.argv[2]));bs=60/P['bpm']*4
print('dur %.1fs peak %.3f rms %.1f dBFS'%(len(x)/sr,abs(x).max(),20*np.log10(np.sqrt((x**2).mean()))))
for s in P['sections']:
  a=int((s['startBar']-1)*bs*sr);b=int((s['startBar']-1+s['bars'])*bs*sr);seg=x[a:b]
  print('%-12s %5.1fs rms %.1f dB  L/R %.2f'%(s['name'],a/sr,20*np.log10(np.sqrt((seg**2).mean())),np.sqrt((seg[:,0]**2).mean()/(seg[:,1]**2).mean())))
