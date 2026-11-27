import sys,glob,numpy as np,wave,json
V=sys.argv[1]; P=json.load(open(f'plan_{V}.json'))
for row in P['meta']['mix']:
  k=row[1]; f=glob.glob(f"{P['meta']['slug']}_{V}S{k}.wav")
  if not f: print(k,'missing');continue
  w=wave.open(f[0]);x=np.frombuffer(w.readframes(w.getnframes()),np.int16).reshape(-1,2)/32768
  # active rms: frames of 50ms above -60 dB
  m=x.mean(1);n=len(m)//2205;fr=m[:n*2205].reshape(n,2205);r=np.sqrt((fr**2).mean(1));a=r[r>1e-3]
  L=np.sqrt((x[:,0]**2).mean());R=np.sqrt((x[:,1]**2).mean())
  print('%-10s active rms %6.1f dB  p90 %6.1f  peak %6.1f  L/R %.2f'%(k,20*np.log10(np.sqrt((a**2).mean())+1e-12),20*np.log10(np.percentile(a,90)+1e-12),20*np.log10(abs(x).max()+1e-12),L/(R+1e-12)))
