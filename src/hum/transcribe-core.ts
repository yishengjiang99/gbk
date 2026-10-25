// Basic Pitch inference core: fixed-window framing, overlap unwrap and note
// decoding over an abstract window runner, so the same code drives the
// onnxruntime-web worker in the browser and plain-function stubs in tests.
//
// The framing mirrors @spotify/basic-pitch's BasicPitch.evaluateModel
// (Apache-2.0): the 22,050 Hz mono signal is left-padded with half the
// overlap (3,840 samples), framed into 43,844-sample windows every 36,164
// samples, and each window's 172 output frames are unwrapped by dropping
// 15 frames from both ends (142 kept per window), then trimmed to the
// frames covering the original audio.
import { noteFramesToTime, outputToNotesPoly, type NoteEventTime } from "./basic-pitch-decode.ts";

export const BP_SAMPLE_RATE = 22050;
export const BP_WINDOW = 43844;
const OVERLAP_SAMPLES = 7680; // 30 frames * 256
const PAD_LEFT = OVERLAP_SAMPLES / 2; // 3840
const HOP_SAMPLES = BP_WINDOW - OVERLAP_SAMPLES; // 36164
const ROWS_PER_WINDOW = 172;
const MARGIN_FRAMES = 15;
const KEPT_PER_WINDOW = ROWS_PER_WINDOW - 2 * MARGIN_FRAMES; // 142
const N_BINS = 88;
const ANNOTATIONS_FPS = Math.floor(BP_SAMPLE_RATE / 256); // 86

/** Flat row-major model outputs for one window: [172*88] each. */
export interface WindowOutput { note: ArrayLike<number>; onset: ArrayLike<number> }
export type RunWindow = (window: Float32Array, index: number) => Promise<WindowOutput>;

export interface TimedNote { pitchMidi: number; startSec: number; endSec: number; amplitude: number }

/** Frame the signal and run the model window by window, stitching activations. */
export async function runBasicPitch(
  samples: Float32Array,
  runWindow: RunWindow,
  onProgress?: (fraction: number) => void,
): Promise<{ frames: number[][]; onsets: number[][] }> {
  const totalFrames = Math.floor((samples.length * ANNOTATIONS_FPS) / BP_SAMPLE_RATE);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  if (samples.length === 0 || totalFrames === 0) return { frames, onsets };

  const padded = new Float32Array(PAD_LEFT + samples.length);
  padded.set(samples, PAD_LEFT);
  const windowCount = padded.length <= BP_WINDOW ? 1 : Math.floor((padded.length - BP_WINDOW + HOP_SAMPLES - 1) / HOP_SAMPLES) + 1;

  for (let w = 0; w < windowCount; w++) {
    const start = w * HOP_SAMPLES;
    const win = new Float32Array(BP_WINDOW);
    win.set(padded.subarray(start, Math.min(padded.length, start + BP_WINDOW)));
    const out = await runWindow(win, w);
    for (let r = MARGIN_FRAMES; r < ROWS_PER_WINDOW - MARGIN_FRAMES; r++) {
      if (frames.length >= totalFrames) break;
      const base = r * N_BINS;
      const f = new Array<number>(N_BINS);
      const o = new Array<number>(N_BINS);
      for (let i = 0; i < N_BINS; i++) { f[i] = out.note[base + i]; o[i] = out.onset[base + i]; }
      frames.push(f);
      onsets.push(o);
    }
    onProgress?.((w + 1) / windowCount);
    if (frames.length >= totalFrames) break;
  }
  return { frames, onsets };
}

export interface DecodeOptions {
  onsetThreshold?: number; // default 0.7 (EarSheet-tuned for the stock model)
  frameThreshold?: number; // default 0.4
  minNoteFrames?: number;  // default 5 (~58 ms)
}

/** Decode stitched activations into timed notes (seconds, sorted by start then pitch). */
export function decodeNotes(frames: number[][], onsets: number[][], opts: DecodeOptions = {}): TimedNote[] {
  if (frames.length < 3) return [];
  const events = outputToNotesPoly(
    frames.map((r) => r.slice()),
    onsets.map((r) => r.slice()),
    opts.onsetThreshold ?? 0.7,
    opts.frameThreshold ?? 0.4,
    opts.minNoteFrames ?? 5,
    true, null, null, true, 11,
  );
  const timed: NoteEventTime[] = noteFramesToTime(events);
  return timed
    .map((n) => ({
      pitchMidi: n.pitchMidi,
      startSec: Math.max(0, n.startTimeSeconds),
      endSec: Math.max(0, n.startTimeSeconds) + n.durationSeconds,
      amplitude: n.amplitude,
    }))
    .filter((n) => n.endSec > n.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.pitchMidi - b.pitchMidi);
}

/** Full pipeline over an abstract window runner (worker in the app, stub in tests). */
export async function transcribeSamples(
  samples: Float32Array,
  runWindow: RunWindow,
  opts: DecodeOptions & { onProgress?: (fraction: number) => void } = {},
): Promise<TimedNote[]> {
  const { frames, onsets } = await runBasicPitch(samples, runWindow, opts.onProgress);
  return decodeNotes(frames, onsets, opts);
}
