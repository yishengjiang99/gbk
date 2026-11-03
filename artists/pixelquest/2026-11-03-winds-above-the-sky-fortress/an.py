import sys,numpy as np,soundfile as sf
x,sr=sf.read(sys.argv[1]);m=x.mean(1);BPM=160;BARS=44;LOOP=12  # loop returns to bar 5 (A)
print("dur",round(len(x)/sr,2),"peak",round(np.abs(x).max(),3),"clip",(np.abs(x)>0.999).sum(),"rms dB",round(20*np.log10(np.sqrt((m**2).mean())),1))
bl=int(sr*60/BPM*4)
r=[20*np.log10(np.sqrt((m[i:i+bl]**2).mean())+1e-9) for i in range(0,BARS*bl,bl)]
print("bar rms dB",[round(float(v),1) for v in r])
for n,a,b in(("Intro",0,4),("A",4,12),("A2",12,20),("B",20,28),("Storm",28,36),("A loop",36,44)): print(n,round(float(np.mean(r[a:b])),1))
a=4*bl;e=BARS*bl;w=int(sr*0.05)
print("seam rms end/start",[round(float(20*np.log10(np.sqrt((m[i:i+w]**2).mean())+1e-9)),1) for i in (e-w,a)])
