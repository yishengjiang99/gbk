# Bundled assets

## Vocab/vocabulary.json

Exported from `liebharc/homr` `homr/transformer/vocabulary.py` `Vocabulary()`.
This is the **authoritative decode-time** token map used by `ScoreDecoder` /
`decoder_inference.py` (via `Config`). Do not invent or hand-edit tokens.

## Tokenizers/tokenizer_*.json

Copied verbatim from `homr/transformer/`. HuggingFace WordLevel JSON assets.
`staff2score.py` only checks that `tokenizer_rhythm.json` exists; current
decode uses `Vocabulary()`, not these maps. Kept for upstream parity and
presence checks.

## Models (not in git)

Place ONNX checkpoints from
https://github.com/liebharc/homr/releases/tag/onnx_checkpoints next to the app
bundle / documented Models path (use Git LFS if committing):

- Encoder fp16 — CoreML EP + CPU fallback; staff input NCHW `[1,1,256,1280]`
- Decoder fp32 — ORT CPU **only** (never requantize; never GPU/Metal/CoreML)
- SegNet fp16 — later gate (not gate-1)
