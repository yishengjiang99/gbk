import json,urllib.request
TOK=open('/home/box/gbk-artists/juniperblue.token').read().strip()
B='https://compose.grepawk.com'
def req(m,p,data=None,ct='application/json'):
  h={'Authorization':'Bearer '+TOK}
  if data is not None: h['content-type']=ct
  r=urllib.request.Request(B+p,data=data,method=m,headers=h)
  return json.loads(urllib.request.urlopen(r).read() or b'{}')
proj=json.load(open('project_d1v3.json'))
r=req('POST','/api/shares',json.dumps(dict(title='Lantern Orchard',project=proj,public=True)).encode())
slug=r['slug'];print(r['url']);open('share-url.txt','w').write(r['url']+'\n')
req('PUT',f'/api/shares/{slug}/media/mp3',open('lantern_orchard.mp3','rb').read(),'audio/mpeg')
m=req('PATCH',f'/api/songs/{slug}/meta',json.dumps(dict(labels=['jazz'],tags=['jazz-waltz','waltz','flute','piano-trio','brushes','a-major','three-four'],prompt_shared=True,prompt_text=open('prompt.md').read().strip())).encode())
print({k:m.get(k) for k in ('labels','tags','prompt_shared')})
g=req('GET',f'/api/songs/{slug}');print(json.dumps(g)[:600])
