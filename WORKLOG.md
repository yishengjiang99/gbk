# WORKLOG — branch sf2-201-compliance

Goal: make this engine SoundFont 2.01 compliant with the same behaviour as sf2player-swift
`SF2Fidelity.spec` (PR yishengjiang99/sf2player-swift#1, branch sf2-201-compliance @ 7de926b).
No legacy mode is kept. Matrix: docs/SF2_COMPLIANCE.md (same IDs as the Swift matrix).

## Baseline — 2026-10-22, Linux, Node 20.19.2
`npm test` on bda70eb: 157 pass, 0 fail.

## Log
- Port: src/sf2/{geninfo,modulator,soundfont,effects,parity}.ts + src/sf2-renderer.ts rewritten from the
  Swift `.spec` path line by line (Double math, Float32 samples/effects via Math.fround). sf2-parser.ts is
  now a compatibility wrapper (parseSF2 keeps its shape; regions are 2.01 regions with raw levels).
  Real-time path preallocated: voice pool + order/free Int32Arrays, Uint8Array CCs, Float64Array NRPN
  offsets and one modulator scratch buffer; no allocation in dispatchEvent / renderRange / renderScheduled.
- Implementation was ported before the per-row JS tests (the Swift tests were the red→green record for the
  behaviour). Red for each JS test group is shown by running it against the pre-port engine (bda70eb);
  see "Red runs" below.
- First cross-engine check (GeneralUser GS piano C4 v100, 1 s + 1 s release): JS == Swift bit for bit.
