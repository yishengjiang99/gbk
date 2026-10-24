import re,sys
p='server/test/mcp-workflow.test.ts'; L=open(p).read().split('\n'); out=[]; inA=False
for i,l in enumerate(L):
    if l.startswith('test("A:'): inA=True
    elif l.startswith('test('): inA=False
    if inA and 'await' in l and l.startswith('    ') and not l.rstrip().endswith(('(',',','{','[')) and l.count('(')==l.count(')'):
        out.append(f'    console.error("STEP {i+1}", Date.now());')
    out.append(l)
open(p,'w').write('\n'.join(out))
