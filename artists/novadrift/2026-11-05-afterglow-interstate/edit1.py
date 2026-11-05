from h import *
ops=[
 {"type":"set_instrument","track":T["Strings"],"program":90},  # polysynth pad
 {"type":"set_instrument","track":T["Choir"],"program":91},    # space voice
 {"type":"set_instrument","track":T["Piano"],"program":81},    # saw arp
 {"type":"set_instrument","track":T["Bass"],"program":38},     # synth bass 1
 {"type":"set_instrument","track":T["Flute"],"program":87},    # bass+lead / lead
 {"type":"set_instrument","track":T["Guitar"],"program":95},   # sweep pad
 {"type":"generate_part","track":T["Piano"],"startBar":9,"endBar":48,"kind":"arpeggio","seed":51},
 {"type":"set_mix","track":T["Piano"],"volume":78,"pan":42},
 {"type":"set_mix","track":T["Guitar"],"volume":70,"pan":88},
 {"type":"set_mix","track":T["Choir"],"volume":80,"pan":96},
 {"type":"set_mix","track":T["Strings"],"pan":30},
]
r=tool("gbk_edit_composition",{"expectedRevision":2,"operations":ops,"idempotencyKey":"nd1105-edit1"})
s=json.dumps(r); print(s[:300]); print(s[-500:])
