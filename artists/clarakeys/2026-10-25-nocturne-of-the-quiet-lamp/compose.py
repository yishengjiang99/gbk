import json, mido, math
PPQ=480; E=240
NN={'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
def p(s):
    if s=='r': return None
    n=s[0]; i=1; a=0
    while i<len(s) and s[i] in 'b#':
        a+= -1 if s[i]=='b' else 1; i+=1
    return 12*(int(s[i:])+1)+NN[n]+a
# chord: (root, quality, bass_override)
Q={'M':[0,4,7],'m':[0,3,7],'7':[0,4,7,10],'m7':[0,3,7,10],'hd7':[0,3,6,10],'m6':[0,3,7,9]}
# bars: list of (chords [(name, beats)], melody string, dyn)
bars=[
 ([('Ab:M',4)], '', 'intro'),
 ([('Ab:M',4)], 'Eb5:4 C5:2 Db5:1 Eb5:1', 'A'),
 ([('F:m',4)],  'F5:5 Eb5:1 Db5:1 C5:1', 'A'),
 ([('Db:M',4)], 'Db5:2 F5:2 Ab5:3 F5:1', 'A'),
 ([('Eb:7',4)], 'Eb5:2 Db5:1 C5:1 Bb4:4', 'A'),
 ([('Ab:M',4)], 'Eb5:4 C5:2 Db5:1 Eb5:1', 'A'),
 ([('Bb:m7',4)],'F5:3 Db5:1 Bb5:3 Ab5:1', 'A'),
 ([('Ab:M/Eb',2),('Eb:7',2)], 'Ab5:3 G5:1 F5:2 G5:2', 'A'),
 ([('Ab:M',4)], 'Ab5:6 r:2', 'A'),
 ([('Ab:7',4)], 'Eb5:2 Gb5:2 C6:3 Bb5:1', 'A'),
 ([('Db:M',4)], 'Ab5:4 F5:2 Db5:2', 'A'),
 ([('Db:m',4)], 'Ab5:3 E5:1 Eb5:2 Db5:2', 'A'),
 ([('Ab:M/Eb',2),('Eb:7',2)], 'C5:2 Eb5:2 Db5:2 Bb4:2', 'A'),
 ([('Ab:M',4)], 'Ab4:6 r:2', 'A'),
 # B: F minor, triplet LH
 ([('F:m',4)],  'C5:2 F5:3 E5:1 F5:2', 'B'),
 ([('C:7',4)],  'G5:3 F5:1 E5:2 C5:2', 'B'),
 ([('F:m',4)],  'Ab5:3 G5:1 F5:2 C6:2', 'B'),
 ([('Bb:m',4)], 'Db6:3 C6:1 Bb5:2 F5:2', 'B'),
 ([('G:hd7',4)],'Bb5:3 Ab5:1 G5:2 Db6:2', 'B'),
 ([('C:7',4)],  'C6:3 Bb5:1 G5:2 E5:2', 'B'),
 ([('F:m',4)],  'F5:2 Ab5:2 C6:2 F6:2', 'B'),
 ([('Db:M',4)], 'F6:4 Eb6:1 Db6:1 C6:1 Bb5:1', 'B'),
 ([('Bb:m7',4)],'Db6:2 Bb5:2 Ab5:2 F5:2', 'B'),
 ([('Eb:7',4)], 'G5:2 Bb5:2 Db6:3 C6:1', 'R'),
 ([('Eb:7',4)], 'Bb5:2 G5:2 Eb5:2 Db5:2', 'R'),
 # A'
 ([('Ab:M',4)], 'C5:2 Eb5:2 C5:2 Db5:1 Eb5:1', 'A2'),
 ([('F:m',4)],  'F5:4 G5:.5 F5:.5 Eb5:1 Db5:1 C5:1', 'A2'),
 ([('Db:M',4)], 'Db5:2 F5:2 Ab5:2 Db6:2', 'A2'),
 ([('Eb:7',4)], 'C6:1 Bb5:3 G5:2 Eb5:2', 'A2'),
 ([('Ab:7',4)], 'Eb5:2 Gb5:2 C6:3 Bb5:1', 'A2o'),
 ([('Db:M',4)], 'Ab5:4 F5:2 Db5:2', 'A2o'),
 ([('Db:m',4)], 'Ab5:3 E5:1 Eb5:2 Db5:2', 'A2'),
 ([('Ab:M/Eb',2),('Eb:7',2)], 'C5:2 Eb5:2 Db5:2 Bb4:2', 'A2'),
 ([('Ab:M',4)], 'Ab4:6 C5:1 Eb5:1', 'C'),
 ([('Db:M/Ab',4)], 'F5:4 Eb5:4', 'C'),
 ([('Db:m/Ab',4)], 'E5:4 Eb5:4', 'C'),
 ([('Ab:M',4)], 'END', 'C'),
]
# tempo (bpm) per bar, rubato
base=63
def bar_bpm(i,sec):
    t=base
    if sec=='B': t=67
    if sec=='R': t=60 if i==23 else 54
    if i in (8,13): t-=5
    if i in (21,): t=64   # climax broadening
    if i>=33: t=[58,54,50,44][i-33]
    return t
def pcs(ch):
    nm,rest=ch.split(':'); q=rest.split('/')[0]
    r=NN[nm[0]]+(-1 if 'b' in nm[1:] else 0)
    bass=(NN[rest.split('/')[1][0]]+(-1 if 'b' in rest.split('/')[1][1:] else 0))%12 if '/' in rest else r%12
    return [(r+x)%12 for x in Q[q]], bass
notes=[]; ccs=[]; tempos=[]
tick=0
def vel_curve(x,lo,hi):  # arch
    return int(lo+(hi-lo)*math.sin(math.pi*min(max(x,0),1)))
for i,(chs,mel,sec) in enumerate(bars):
    t0=i*4*PPQ
    tempos.append((t0,bar_bpm(i,sec)))
    # dynamics envelope
    dyn={'intro':(40,44),'A':(56,70),'B':(66,92),'R':(70,54),'A2':(52,66),'A2o':(62,80),'C':(46,38)}[sec]
    if sec=='B': dyn=(62+ (i-14)*3, 74+(i-14)*3) if i<=21 else (80,70)
    # LH
    ct=t0
    for (ch,beats) in chs:
        P,b=pcs(ch)
        bass=36+((b-36)%12)
        if bass>45: bass-=12
        if sec in ('C',) : bass=44 if b==8 else bass
        tones=[x for x in range(bass+7,66) if x%12 in P]
        sel=[]
        for x in tones:
            if not sel or x-sel[-1]>=3: sel.append(x)
        sel=sel[:4]
        if sec=='B':
            pat=[bass]+sel[:3]+[sel[3] if len(sel)>3 else sel[2]+12]+sel[2:0:-1]  # 6-note up/down
            n=int(beats*3); step=PPQ//3
            seq=(pat*4)[:n]
        elif sec=='C' and i==len(bars)-1:
            seq=[bass-12]; step=PPQ*4
        elif sec=='C' and i>=34:
            seq=[bass]+sel[:3]; step=PPQ
        else:
            pat=[bass,sel[0],sel[1],sel[2],sel[3] if len(sel)>3 else sel[2]+12,sel[2],sel[1],sel[0]]
            n=beats*2; step=E; seq=(pat*2)[:n]
        L=len(seq)
        for k,ptch in enumerate(seq):
            v=int(dyn[0]-14 + 8*math.sin(math.pi*k/max(L,1))) + (6 if k==0 else 0) + ((i*7+k*3)%5-2)
            dur=step*L-k*step if k==0 else int(step*1.6)
            notes.append(dict(tick=ct+k*step,duration=dur,pitch=ptch,velocity=max(20,min(110,v)),hand='L'))
        # pedal
        ccs.append((max(0,ct-12),0)); ccs.append((ct+40,100))
        ct+=beats*PPQ
    # RH melody
    if mel=='END':
        for k,ptch in enumerate([56,63,68,72,75,80]):
            notes.append(dict(tick=t0+k*45,duration=4*PPQ*2,pitch=ptch,velocity=40-k*2 if ptch!=80 else 44,hand='R'))
        continue
    if not mel: continue
    toks=[x.split(':') for x in mel.split()]
    total=sum(float(d) for _,d in toks)
    pos=0
    for j,(n,d) in enumerate(toks):
        d=float(d); pt=p(n)
        if pt is not None:
            x=(i+pos/8.0) # phrase position
            ph=((i-1)%4 + pos/8)/4 if sec in('A','A2','A2o') else (pos/8)
            v=vel_curve(ph,dyn[0],dyn[1]) if sec not in('R','C') else int(dyn[0]+(dyn[1]-dyn[0])*((i-23 if sec=='R' else i-33)+pos/8)/ (2 if sec=='R' else 3))
            if d<1: v-=8
            delay=18 if (pos==0 and j==0) else 0
            tk=t0+int(pos*E)+delay
            dur=int(d*E*0.96)-delay
            notes.append(dict(tick=tk,duration=dur,pitch=pt,velocity=v,hand='R'))
            if sec=='A2o':  # octave doubling below
                notes.append(dict(tick=tk,duration=dur,pitch=pt-12,velocity=v-14,hand='R'))
            # inner alto voice in A2/B at bar starts for warmth
            if sec in ('B','A2o') and pos==0:
                P,b=pcs(chs[0][0])
                alt=[x for x in range(pt-9,pt-2) if x%12 in P]
                if alt: notes.append(dict(tick=tk,duration=int(4*E*0.95),pitch=alt[-1],velocity=v-18,hand='R'))
        pos+=d
    assert abs(pos-8)<1e-6,(i,pos)
ccs.append((len(bars)*4*PPQ+PPQ*4,0))
end=len(bars)*4*PPQ+PPQ*4
json.dump(dict(notes=notes,ccs=ccs,tempos=tempos,end=end),open('score.json','w'))
mid=mido.MidiFile(ticks_per_beat=PPQ); tr=mido.MidiTrack(); mid.tracks.append(tr)
ev=[(0,mido.MetaMessage('track_name',name='Piano')),(0,mido.Message('program_change',program=0,channel=0)),
    (0,mido.MetaMessage('time_signature',numerator=4,denominator=4))]
for t,b in tempos: ev.append((t,mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(b))))
for t,v in ccs: ev.append((t,mido.Message('control_change',control=64,value=v,channel=0)))
for n in notes:
    ev.append((n['tick'],mido.Message('note_on',note=n['pitch'],velocity=n['velocity'],channel=0)))
    ev.append((n['tick']+n['duration'],mido.Message('note_off',note=n['pitch'],velocity=0,channel=0)))
ev.sort(key=lambda e:(e[0], 0 if e[1].type=='note_off' else 1))
last=0
for t,m in ev: tr.append(m.copy(time=t-last)); last=t
mid.save('nocturne.mid'); print(len(notes),'notes', mid.length,'sec')
