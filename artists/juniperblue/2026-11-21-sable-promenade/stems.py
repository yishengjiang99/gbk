# plan_<V>.json -> plan_<V>S<track>.json (one track each, optional bar range) for NORM=none stem renders
import json,sys
V=sys.argv[1]; b0=int(sys.argv[2]) if len(sys.argv)>2 else 0; b1=int(sys.argv[3]) if len(sys.argv)>3 else 10**6
P=json.load(open(f'plan_{V}.json'))
for row in P['meta']['mix']:
  k=row[1]; Q=dict(P); BAR=1920
  Q['tracks']={k:[dict(n,tick=n['tick']-b0*BAR) for n in P['tracks'][k] if b0*BAR<=n['tick']<b1*BAR]}
  Q['meta']=dict(P['meta'],mix=[row]); Q['endTick']=min(P['endTick'],(b1-b0)*BAR+BAR)
  Q['sections']=[dict(s,startBar=s['startBar']-b0) for s in P['sections'] if b0<s['startBar']<=b1] or [dict(name='x',startBar=1,bars=b1-b0,energy=0.5)]
  json.dump(Q,open(f'plan_{V}S{k}.json','w')); print(f'{V}S{k}')
