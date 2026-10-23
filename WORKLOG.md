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
- Cross-engine sweep 1 (129 scenarios: GeneralUser GS programs 0-127 via programChange + CCs 0/1/7/10/11/64/91/93,
  pitch bend, channel pressure, effects on for even programs; drum kit): 41/129 exact. Bug found: modulation
  envelope convex attack used (1-x)^2 instead of the 8.2.4 convex curve; fixed by reusing modCurve(2, x).
  After fix: 119/129 bit-exact, rest differ by <= 1e-9 (libm ulp differences: V8 fdlibm vs glibc).

## Master bus (user request, added 2026-10-22)
- src/sf2/master-bus.ts provides masterGain (-3 dB), then a stereo-linked compressor (-6 dBFS, 4:1, 6 dB knee, 5/100 ms), then a lookahead brickwall limiter (-0.3 dBFS ceiling, 50 ms release, 1.5 ms lookahead = 66 frames at 44.1 kHz), then a safety soft clip (<= ceiling < 1).
- The engine exposes `masterGainDb`, `masterDynamicsEnabled` (default true) and `master.setParams()`. It is applied in renderRange and renderScheduled. renderRangeWithSends (the G-11 measurement API) is pre-master.
- The compliance tests' SpecRender sets dynamics off and gain 0 dB. test/master-bus.test.ts covers the bound, quiet passthrough, attack/release within 2%, recovery, and NaN/Inf/denormals.
- Note: the gbk app still runs its own src/master-dynamics.ts after the engine, so app playback now goes through two dynamics stages. This is not changed here; the user decides.
- The int16 writers in midireader.tsx already clamp to +/-1.

## Compliance tests, matrix and parity (2026-10-22)
- Test files:
  - test/sf2-compliance-{p,z,g,m,midi}.test.ts: every Swift row test is ported with the same name.
  - test/sf2-fuzz.test.ts: P-99, 10k iterations, SplitMix64 with the same seed as Swift.
  - test/sf2-compliance-matrix.test.ts: asserts 80 pass and 3 n/a, and that every named test exists.
- docs/SF2_COMPLIANCE.md uses the same IDs as Swift and carries a non-normative master-bus note.
- Red evidence: the new test files were run against bda70eb in a worktree. 7 of 8 files fail at import (the 2.01 modules don't exist there). The matrix test passes there because it reads only docs and test names.
  - This is a weak red: the implementation was ported before the tests, as noted above. The tests were not written one by one against a failing implementation.
- Cross-engine parity: test/sf2-cross-engine-parity.test.ts runs 20 GU scenarios plus 4 builder banks x fx on/off, and needs SF2_PARITY_SWIFT_BIN.
  - Tolerance is 1e-6. The worst value observed in the test set is 1.4e-14. The scratch sweep of 135 scenarios gave worst 2.3e-10, with 121 bit-exact.
- `npm test` (with the Swift bin): 253/253. `npm run build`: OK.
- Not done: FluidSynth diff script (fluidsynth isn't installable on the box without sudo); macOS libm parity.
