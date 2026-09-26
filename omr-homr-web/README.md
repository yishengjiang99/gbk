# omr-homr-web

AGPL-3.0-only. See `LICENSE` and `NOTICE`.

In-browser OMR worker for the gbk sheet-cam flow, running homr's published
ONNX weights with onnxruntime-web. Python homr is the exporter and correctness
oracle only — no Python runs in the browser.

## Architecture (locked)

- **SegNet fp16** → WebGPU (page segmentation, Phase 3)
- **Encoder fp16** → WebGPU, input `[1,1,256,1280]` grayscale normalized with
  mean `0.7931` / std `0.1738`
- **fp16 → fp32 cast** of the encoder context `[1,1280,512]` (byte-identical to
  homr's CoreML path, validated in Phase 0)
- **Decoder fp32** → WASM only (KV-cache `MultiHeadAttention` is not supported
  by the WebGPU EP); host-driven greedy loop, max 608 steps, stop at rhythm EOS
- **midi.ts** → SMF format 1, 480 TPQ, conductor track + one track per staff;
  exactly what gbk's `midi-timer.worker.ts` parses

The sheet-cam page talks to `src/worker.ts` through a JSON protocol only.
The audio engine stays on its own license and consumes just MIDI + noteLayout.

## Phase 2 demo (this milestone)

One pre-cropped `[1,1,256,1280]` staff → decode loop → format-1 MIDI that the
existing timer worker can play. Gate: the JS decode loop must reproduce the
Python oracle token sequence on the C-scale staff byte-for-byte.

```
npm run fetch:models   # downloads 3 weights from homr's release -> omr-homr-web/models (gitignored)
npm test               # node:test + tsx; skips ONNX tests if models are absent
npm run typecheck
```

## Test fixtures + omr-test CLI

`fixtures/<id>/` holds the TDD pack: `input.png`, `expected.tokens.json`
(Python oracle), `expected.notes.csv` (canonical GT from the notation source),
`meta.yaml` (incl. `match_tier`). See `fixtures/README.md` for the schema and
the three scoring layers (tokens / MIDI / layout).

```
npm run omr-test -- fixtures/mono.c_major_scale --no-onnx  # writer-only, instant
npm run omr-test -- --tier exact_tokens --no-onnx          # all writer-only checks
npm run omr-test -- --tier exact_tokens                   # full, incl. ONNX inference
npm run omr-test -- fixtures/mono.c_major_scale           # single fixture, ONNX
```

Exit 0 = the fixture's tier passed; token and MIDI edit distances print every
run. Writer-only tests are instant; ONNX tests load the pinned weights from
`models/` and take ~8s per staff.

## Browser demo (isolated)

`demo/` exercises the real Worker end-to-end in Chromium: fp16 encoder on
WebGPU when available (else fp32 on WASM), C-scale staff fixture in, tokens +
MIDI out, compared against the oracle. Not wired into the sheet-cam UI.

```
npm run demo:build   # esbuild bundles -> demo/dist/
npm run demo:serve    # static server on :8901 (background it)
npm run demo:run      # Playwright driver; exit 0 only if the demo passes
```

## Layout

- `src/vocab.ts` — token maps + constants exported from the Python oracle
- `src/transformer.ts` — EP-agnostic encoder + decode loop (no ORT import)
- `src/models.ts` — browser session creation (onnxruntime-web, WebGPU/WASM)
- `src/midi.ts` — decoded symbols → SMF format 1, 480 TPQ
- `src/worker.ts` — dedicated worker, JSON protocol
- `test/fixtures/` — oracle staff crop + raw token sequence from Python homr
- `fixtures/` — TDD fixture pack (schema + tiers in `fixtures/README.md`)
- `scripts/omr-test.mts` — the `omr-test` CLI entrypoint
- `scripts/gen-synth-fixtures.py` — regenerates the synthetic fixtures from
  authored MEI (Verovio) + Python homr oracle tokens
- `demo/` — isolated browser demo (esbuild bundles, static server, Playwright
  driver); not part of the sheet-cam UI
