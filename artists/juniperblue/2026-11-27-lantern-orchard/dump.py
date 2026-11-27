import json,sys
P=json.load(open(sys.argv[1]));k=sys.argv[2];b0=int(sys.argv[3]);n=int(sys.argv[4])
NM='C Db D Eb E F Gb G Ab A Bb B'.split()
for b in range(b0,b0+n):
  ns=[x for x in P['tracks'][k] if b*1920<=x['tick']<(b+1)*1920]
  print(b+1,' '.join(f"{NM[x['pitch']%12]}{x['pitch']//12-1}@{(x['tick']-b*1920)/240:.1f}/{x['velocity']}" for x in ns))
