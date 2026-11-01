// Feed card piano-roll visualization constants (issue #108), shared by LiveRoll and the server og:video renderer.
// Constants are shared with GBK iOS; keep them in sync with issue #108.
export const VIZ = {
  windowSec: 4,          // visible seconds
  playheadFrac: 0.25,    // playhead at 25% from left => 1 s past, 3 s upcoming
  overlayFrac: 0.38,     // bars + waveform overlay height, anchored to the bottom of the full-height roll
  barAlpha: 0.35, waveAlpha: 0.8, idleAlpha: 0.5,
  pitchPad: 2, minPitchSpan: 12, noteGapPx: 1, minNoteH: 2, minNoteW: 2,
  fftSize: 2048, smoothing: 0, bars: 48, fMin: 40, fMax: 16000,
  attack: 1, decayMs: 150, // bar rises instantly, falls with exp time constant 150 ms
  waveSamples: 256,      // waveform points drawn across full width from getFloatTimeDomainData
  activeLighten: 0.45,   // active note = mix(trackColor, white, 0.45) + playhead-colored outline
  pastAlpha: 0.35, upcomingAlpha: 0.8,
} as const;

export const VIZ_PALETTE = {
  light: { bg: "#f8fcff", grid: "#e3edf5", row: "#eef4f9", head: "#e5396b", bar: "#2d6a93", wave: "#16324a", dim: "#9fb6c8" },
  dark: { bg: "#0f1115", grid: "#1c2028", row: "#13161c", head: "#ff5c8a", bar: "#61a6d1", wave: "#e8eaf0", dim: "#3a4352" },
} as const;
