import json, mido, math, subprocess, time, requests, os
PPQ=480
NN={'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
def p(s):
    n=s[0]; i=1; a=0
    while i<len(s) and s[i] in 'b#': a+= -1 if s[i]=='b' else 1; i+=1
    return 12*(int(s[i:])+1)+NN[n]+a
Q={'M':[0,4,7],'m':[0,3,7],'7':[0,4,7,10],'m7':[0,3,7,10],'hd7':[0,3,6,10],'d7':[0,3,6,9],'M7':[0,4,7,11],'d':[0,3,6],'sus4':[0,5,7],'aug':[0,4,8]}
def pc(nm):
    r=NN[nm[0]]
    for c in nm[1:]: r+= -1 if c=='b' else 1
    return r%12
def chord(ch):
    "Root:qual[/bass]"
    nm,rest=ch.split(':'); q=rest.split('/')[0]; r=pc(nm)
    bass=pc(rest.split('/')[1]) if '/' in rest else r
    return [(r+x)%12 for x in Q[q]], bass
def mel(s, t0, unit, vel, ch_fn=None):
    "parse 'Eb5:2 r:1 ...' durations in units; returns notes, end tick"
    out=[]; t=t0
    for tok in s.split():
        n,d=tok.split(':'); d=float(d); dur=int(d*unit)
        if n!='r': out.append([t,int(dur*0.95),p(n),vel(t) if callable(vel) else vel])
        t+=dur
    return out,t
def to_midi(S, path):
    mid=mido.MidiFile(ticks_per_beat=PPQ)
    meta=mido.MidiTrack(); mid.tracks.append(meta)
    ev=[(0,mido.MetaMessage('time_signature',numerator=S['ts'][0],denominator=S['ts'][1]))]
    for t,b in S['tempos']: ev.append((t,mido.MetaMessage('set_tempo',tempo=mido.bpm2tempo(b))))
    def flush(tr,ev):
        ev.sort(key=lambda e:(e[0],0 if e[1].type=='note_off' else 1)); last=0
        for t,m in ev: tr.append(m.copy(time=t-last)); last=t
    flush(meta,ev)
    for ch,T in enumerate(S['tracks']):
        tr=mido.MidiTrack(); mid.tracks.append(tr)
        ev=[(0,mido.MetaMessage('track_name',name=T['name'])),(0,mido.Message('program_change',program=T['program'],channel=ch))]
        for c,t,v in T.get('ccs',[]): ev.append((t,mido.Message('control_change',control=c,value=v,channel=ch)))
        for t,d,pt,v in T['notes']:
            ev.append((t,mido.Message('note_on',note=pt,velocity=max(1,min(127,v)),channel=ch)))
            ev.append((t+d,mido.Message('note_off',note=pt,velocity=0,channel=ch)))
        flush(tr,ev)
    mid.save(path); return mid.length
def render(mid, mp3):
    subprocess.run(f"/workspace/clara4/env/bin/fluidsynth -ni -g 0.6 -r 44100 -F /tmp/r.wav /workspace/clara4/GeneralUser-GS.sf2 {mid} >/dev/null 2>&1",shell=True,check=True)
    subprocess.run(f'ffmpeg -y -loglevel error -i /tmp/r.wav -af "areverse,silenceremove=start_periods=1:start_threshold=-60dB,areverse,loudnorm=I=-16:TP=-1.5" -b:a 192k {mp3}',shell=True,check=True)
    o=subprocess.run(f"ffmpeg -i {mp3} -af ebur128 -f null - 2>&1",shell=True,capture_output=True,text=True).stdout
    import re
    M=[(float(a),float(b)) for a,b in re.findall(r't:\s*([0-9.]+)\s.*?M:\s*(-?[0-9.]+)',o)]
    env=[f"{int(t)}s:{m}" for t,m in M if abs(t-round(t/15)*15)<0.06 and t>1]
    dur=float(subprocess.run(f"ffprobe -v error -show_entries format=duration -of csv=p=0 {mp3}",shell=True,capture_output=True,text=True).stdout)
    return dur, env
def check(S, chords, melodic):
    "chords: list of (tick_start, tick_end, chordname); report strong-beat non-chord tones longer than an eighth in melodic tracks, ranges"
    rep=[]
    for T in S['tracks']:
        ps=[n[2] for n in T['notes']]; rep.append(f"{T['name']}: {len(ps)} notes range {min(ps)}-{max(ps)}")
    beat=PPQ*S['ts'][0]*4//S['ts'][1]//(2 if S['ts'][0] in (4,) else 1)
    for T in S['tracks']:
        if T['name'] not in melodic: continue
        for t,d,pt,v in T['notes']:
            if t%beat==0 and d>=PPQ//2*0.9:
                for a,b,c in chords:
                    if a<=t<b:
                        P,_=chord(c)
                        if pt%12 not in P: rep.append(f"  NCT {T['name']} bar{t//(PPQ*S['ts'][0]*4//S['ts'][1])+1} pitch{pt} over {c}")
    return rep
def project(S, pid, title, key, mood, sections):
    tracks=[];notes=[];ccs=[];progs=[]
    for ch,T in enumerate(S['tracks']):
        tid=f"trk_{ch}_{T['name'].lower()}"
        tracks.append({"id":tid,"name":T['name'],"channel":ch,"color":["#f4d58d","#9ad1f5","#e8a0a0"][ch%3],"visible":True,"mix":{"volume":100,"pan":T.get('pan',64),"expression":127,"mute":False,"solo":False},"role":T.get('role','melody')})
        for i,(t,d,pt,v) in enumerate(T['notes']): notes.append({"trackId":tid,"channel":ch,"tick":t,"duration":d,"pitch":pt,"velocity":max(1,min(127,v)),"id":f"n_{ch}_{i:04d}"})
        for i,(c,t,v) in enumerate(T.get('ccs',[])): ccs.append({"id":f"cc_{ch}_{i:04d}","trackId":tid,"channel":ch,"controller":c,"tick":t,"value":v})
        progs.append({"id":f"pg_{ch}","trackId":tid,"channel":ch,"tick":0,"program":T['program'],"bankMsb":0,"bankLsb":0})
    end=max(n['tick']+n['duration'] for n in notes)+PPQ
    return {"schemaVersion":1,"id":pid,"revision":3,"name":title,"ppq":PPQ,"format":1,"tracks":tracks,"notes":sorted(notes,key=lambda n:(n['tick'],n['pitch'])),"ccs":ccs,
     "pitchBends":[],"channelPressure":[],"polyPressure":[],"programs":progs,
     "tempos":[{"tick":t,"microPerQuarter":round(60e6/b)} for t,b in S['tempos']],
     "timeSigs":[{"tick":0,"numerator":S['ts'][0],"denominator":S['ts'][1]}],"raw":[],"endTick":end,
     "selection":{"trackIds":[],"startTick":0,"endTick":0,"noteIds":[]},"loop":{"enabled":False,"startTick":0,"endTick":0},
     "meta":{"owner":"agent","createdAt":int(time.time()*1000),"key":key,"descriptors":{"mood":mood,"style":"classical","via":"script"},"sections":sections,"style":"classical"}}
def mcp_seed(S,title,key,mood,instr,bars,seed):
    from mcp import C
    c=C()
    T=lambda r: json.loads(r['result']['content'][0]['text'])
    tempo=max(S['tempos'][0][1], math.ceil(bars*S['ts'][0]*(4/S['ts'][1])*60/170))
    cr=T(c.call('gbk_create_composition',{'title':title,'style':'classical','mood':mood,'key':key,'tempo':tempo,'timeSignature':list(S['ts']),'bars':bars,'instrumentation':instr,'seed':seed}))
    cid,tok=cr['compositionId'],cr['accessToken']; gtr=[t['trackId'] for t in cr['generation']['tracks']]
    g=T(c.call('gbk_get_composition',{'compositionId':cid,'accessToken':tok,'includeNotes':True,'limit':1000}))
    ids=[n['id'] for n in g['notes']['items']]
    add=[{'trackId':gtr[min(i,len(gtr)-1)],'tick':t,'duration':d,'pitch':pt,'velocity':max(1,min(127,v))} for i,T_ in enumerate(S['tracks']) for t,d,pt,v in T_['notes']]
    rev=g['revision']; first=True
    for k in range(0,len(add),1500):
        r=T(c.call('gbk_edit_composition',{'compositionId':cid,'accessToken':tok,'expectedRevision':rev,'operations':[{'type':'note_patch','remove':ids if first else [],'add':add[k:k+1500]}]}))
        first=False; rev=r.get('revision',rev+1)
    return cr['projectId'], cid, rev
def publish(P,title,mp3,mid,tags,prompt):
    TOK=open('/home/box/gbk-artists/clarakeys.token').read().strip()
    H={'Authorization':'Bearer '+TOK}; B='https://compose.grepawk.com'
    r=requests.post(B+'/api/shares',headers=H,json={'title':title,'project':P,'public':True}); r.raise_for_status(); slug=r.json()['slug']
    for kind,ct,f in (('mp3','audio/mpeg',mp3),('midi','audio/midi',mid)):
        requests.put(f'{B}/api/shares/{slug}/media/{kind}',headers=dict(H,**{'content-type':ct}),data=open(f,'rb').read()).raise_for_status()
    requests.patch(f'{B}/api/songs/{slug}/meta',headers=H,json={'labels':['classical'],'tags':tags,'prompt_shared':True,'prompt_text':prompt}).raise_for_status()
    g=requests.get(f'{B}/api/songs/{slug}').json()
    assert g['author']['handle']=='clarakeys'
    return slug, g['url']
