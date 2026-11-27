# melody lint: flag strong-eighth notes outside chord tones+tensions, and bar overflow
from jazz import *
NM='C Db D Eb E F Gb G Ab A Bb B'.split()
def lint(name,bars,m,epb=8):
  notes,tot=melody(m); bad=0
  if tot!=len(bars)*epb: print(f'{name}: length {tot} eighths, expected {len(bars)*epb}')
  for pos,p,l,acc in notes:
    b=int(pos//epb); e=pos%epb
    if b>=len(bars): print(f'{name}: note past end at bar {b+1}'); continue
    c=bars[b]; r,q=c[0] if (len(c)==1 or e<epb/2) else c[1]
    rel=(p-r)%12; ok=rel in [x%12 for x in CT[q]]+TEN[q]; sc=rel in SC[q]
    strong=e%2==0 or l>=2 or acc
    if strong and not ok: bad+=1; print(f'  {name} b{b+1} e{e} {NM[p%12]}{p//12-1} over {NM[r]}{q} ({"scale" if sc else "OUT"}) len {l}')
  print(f'{name}: {len(notes)} notes, {bad} flagged')
