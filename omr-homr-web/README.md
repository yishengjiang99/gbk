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

## Phase 3 (full page)

`transcribe-page` runs the whole homr page pipeline in the worker:

1. **Preprocess** (`src/page.ts`): autocrop, resize to width 1920, CLAHE,
   grayscale — mirrors `homr/preprocessing.py`.
2. **SegNet** (`src/geometry/segnet.ts`): 320×320 tiles at step 160
   (overlapping, like homr's `inference`), six-class argmax per tile,
   stitched by averaging overlaps and truncating to int
   (`merge_patches` parity).
3. **Staff detection** (`src/geometry/staff.ts`, `staff-model.ts`):
   connected components, staff-line reconstruction, grand-staff grouping
   via braces/brackets, top-to-bottom ordering.
4. **Dewarp** (`src/geometry/dewarp.ts`): each staff is straightened with a
   piecewise-affine warp driven by the staff's vertical drift, then rendered
   to a 1280×256 grayscale encoder crop.
5. **Decode** (`src/transformer.ts`): the Phase 2 encoder/decoder per staff.
6. **MIDI + layout** (`src/midi.ts`, `buildPageNoteLayout` in `src/page.ts`):
   SMF format 1 plus one layout entry per sounding note.

```
npm run fetch:models   # downloads 3 weights from homr's release -> omr-homr-web/models (gitignored)
npm test               # node:test + tsx; skips ONNX tests if models are absent
npm run typecheck
```

### Protocol

```ts
// request
{ type: "load", encoderUrl, decoderUrl, segnetUrl?, wasmPaths?, strictWebGpu?, wasmOnly? }
// request
{ type: "transcribe-page", pixels: ArrayBuffer, width, height,
  format?: "rgba" | "rgb" | "gray", title?: string }
// response
{ type: "result", midi: ArrayBuffer, noteLayout, layoutSource: "attention" | "midi-fallback",
  staffCount, warnings, symbols }
```

`transcribe-staff` is unchanged (Phase 2 API preserved).

`load` options: `strictWebGpu` pins every model to the WebGPU EP (fails
loudly instead of falling back); `wasmOnly` skips WebGPU entirely. The
latter exists for GPU-less CI/VMs: SwiftShader has no `shader-f16` (fp16
WGSL fails to compile) and the fp32 transformer encoder stalls on its
WebGPU EP there, so a full browser proof on such a machine runs WASM-only.

### Scoring (kept separate)

- **Layer A (tokens)**: decoded symbols must match the Python oracle
  six-head sequence exactly (C-scale: 21/21).
- **Layer B (MIDI)**: canonical `(tick, pitch, durationTicks, staff)` event
  lists must match the oracle tokens' MIDI exactly (C-scale: 15 events).
- **Layer C (layout)**: every sounding MIDI note must have a layout entry.
  `layoutSource` is `"attention"` only when **every** entry carries a box;
  partial or missing attention coverage is reported as `"midi-fallback"`.
  Attention boxes are **coarse**
  (a 24×24 square around the decoder's attention point, mapped through the
  crop→page chain) — documented, not shipped-gated on IoU.

### Fidelity gaps (honest)

- Staff y-extent/unit size differ ~5px from the Python oracle
  (component-pixel vs OpenCV contour boundaries); x-extent matches exactly.
- Crop vs oracle: meanAbs 18.9 (tolerance < 25), driven by the y-extent gap,
  resize interpolation, the CLAHE approximation, and forward/inverse warp
  sampling. Token accuracy is unaffected (21/21).
- Barline/clef connection branches return empty: concrete barline/clef
  `SymbolOnStaff` entries are not retained.
- TypeScript morphology in autocrop runs at 0.25 scale for speed; homr runs
  it at full resolution.
- `estimateNoise` uses zero-padding at tile borders; OpenCV uses border
  reflection.

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

### Page demo (Phase 3, `transcribe-page`)

`demo/page.html` + `demo/page-demo.ts` run the full-page pipeline in the
browser on the C-scale page fixture and score Layers A/B/C (tokens exact
21/21, canonical MIDI events 15/15, layout 15/15 boxed with
`layoutSource === "attention"`), plus staff count, MIDI header check, and
warnings. `npm run demo:run:page` drives it via Playwright
(`DEMO_PAGE=/demo/page.html`); exit 0 only if all layers pass.

On a GPU-less VM (SwiftShader: no `shader-f16`, fp16 WGSL fails to compile,
fp32 encoder stalls on WebGPU) the demo must bypass WebGPU:
`DEMO_PAGE='/demo/page.html?wasm=1'` forces the WASM EP for every model.
Real-GPU browsers use the default auto path unchanged.

## Layout

- `src/vocab.ts` — token maps + constants exported from the Python oracle
- `src/transformer.ts` — EP-agnostic encoder + decode loop (no ORT import)
- `src/models.ts` — browser session creation (onnxruntime-web, WebGPU/WASM)
- `src/midi.ts` — decoded symbols → SMF format 1, 480 TPQ
- `src/worker.ts` — dedicated worker, JSON protocol
- `src/page.ts` — page pipeline: preprocess, staff detection, parse, layout
- `src/geometry/segnet.ts` — tiled SegNet inference + six-class stitching
- `src/geometry/staff.ts` — connected components, staff reconstruction, noise filter
- `src/geometry/staff-model.ts` — Staff/StaffPoint/MultiStaff models
- `src/geometry/dewarp.ts` — piecewise-affine staff dewarping to 1280×256
- `src/geometry/image.ts` — browser-safe image ops (no numpy/scipy/cv2/PIL)
- `src/geometry/boxes.ts` — rotated boxes and ellipses
- `test/geometry.test.ts` — Phase 3 gates (tiling, staff, dewarp, page pipeline)
- `test/worker.test.ts` — worker protocol (load, transcribe-staff, transcribe-page)
- `test/fixtures/` — oracle staff crop + raw token sequence from Python homr
- `fixtures/` — TDD fixture pack (schema + tiers in `fixtures/README.md`)
- `scripts/omr-test.mts` — the `omr-test` CLI entrypoint
- `scripts/gen-synth-fixtures.py` — regenerates the synthetic fixtures from
  authored MEI (Verovio) + Python homr oracle tokens
- `demo/` — isolated browser demo (esbuild bundles, static server, Playwright
  driver); not part of the sheet-cam UI
