# serial render queue: q.sh V1 V2 ... (env NORM passes through)
for v in "$@"; do node render.mjs $v > render_$v.log 2>&1 || echo "FAIL $v"; tail -1 render_$v.log; done
