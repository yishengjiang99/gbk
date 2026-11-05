from h import *
ops=[
 {"type":"transform_notes","track":T["Choir"],"startBar":1,"endBar":48,"transform":"transpose","semitones":12},
 {"type":"transform_notes","track":T["Guitar"],"startBar":1,"endBar":48,"transform":"transpose","semitones":12},
 {"type":"orchestrate","sourceTrack":T["Flute"],"targetTrack":T["Flute"],"startBar":33,"endBar":48,"semitones":12,"velocityScale":0.7},
 {"type":"set_mix","track":T["Bass"],"volume":72},
 {"type":"set_mix","track":T["Drums"],"volume":86},
 {"type":"set_mix","track":T["Flute"],"volume":112,"pan":60},
 {"type":"cc_curve","trackIds":[T["Strings"],T["Choir"],T["Guitar"]],"controller":11,"startBar":1,"endBar":8,"shape":"crescendo","from":80,"to":127},
 {"type":"cc_curve","trackIds":[T["Strings"],T["Choir"],T["Guitar"],T["Piano"],T["Bass"],T["Flute"],T["Drums"]],"controller":11,"startBar":45,"endBar":48,"shape":"decrescendo","from":127,"to":40},
]
r=tool("gbk_edit_composition",{"expectedRevision":13,"operations":ops,"idempotencyKey":"nd1105-edit2"})
s=json.dumps(r); print(s[:300]); print(s[-900:])
