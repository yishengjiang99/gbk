# lead-only vs full mix level per section (dB). usage: python3 leadmix.py <dir>
import sys,json,numpy as np,soundfile as sf
D=sys.argv[1];S=json.load(open(D+"/song.json"))
a,sr=sf.read(D+"/gbk_raw.wav");l,_=sf.read(D+"_lead/gbk_raw.wav")
a=a.mean(1);l=l.mean(1);n=min(len(a),len(l));bs=4*60/S['bpm']
db=lambda v:20*np.log10(np.sqrt((v**2).mean())+1e-9)
out=[]
for s in S['sections']:
  i,j=int((s['startBar']-1)*bs*sr),int((s['startBar']-1+s['bars'])*bs*sr)
  out.append(f"{s['name']} {db(l[i:j])-db(a[i:j]):+.1f}")
F=lambda x:np.abs(np.fft.rfft(x[:sr*60]))**2
fr=np.fft.rfftfreq(sr*60,1/sr);L=F(l);print(D,"lead-mix dB:"," ".join(out),"| lead centroid Hz %.0f"%((L*fr).sum()/L.sum()))
