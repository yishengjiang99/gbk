# Prompt — Lantern Adagio

Original short string quartet movement (~1.5 min) for gbk composer (MCP `gbk_create_composition`):
title "Lantern Adagio", style classical, mood "melancholic, cinematic, hopeful", key D minor, 60 BPM, 4/4, 24 bars,
instrumentation violin, violin, viola, cello; sections A (1–8), B (9–16), A2 (17–24).
The generated draft was then fully replaced (`note_patch`) with a hand-specified four-part realization:
a Viterbi voice-leading search over a chosen chord plan with hard rules (no parallel 5ths/8ves, no hidden
outer-voice perfects by soprano leap, leading tone resolves up in outer voices, chord 7ths resolve down, no
overlaps/crossings, idiomatic ranges vn1 G4–D6, vn2 A3–E5, va D3–A4, vc C2–C4), then vn1 passing tones,
pulsing inner voices in B, expression swell (B) and fade (A2). Rendered with FluidR3 GM.
