import sys,numpy as np,soundfile as sf
x,sr=sf.read(sys.argv[1]);m=x.mean(1)
print("dur",round(len(x)/sr,2),"peak",round(np.abs(x).max(),3),"clip",(np.abs(x)>0.999).sum())
bl=int(sr*60/120*3)
r=[20*np.log10(np.sqrt((m[i:i+bl]**2).mean())+1e-9) for i in range(0,len(m)-bl,bl)]
print("bar rms dB",[round(v,1) for v in r])
a=int(4*bl);e=int(44*bl);w=int(sr*0.05)
print("seam rms end/start",[round(20*np.log10(np.sqrt((m[i:i+w]**2).mean())+1e-9),1) for i in (e-w,a)])
