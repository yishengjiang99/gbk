/*
 * Dedicated worker entry for omr-homr-web. The sheet-cam page talks to this
 * worker only through the JSON protocol below; no homr code or weights cross
 * into the page. Part of omr-homr-web, licensed under AGPL-3.0-only.
 *
 * Phase 2 implements the staff-only path (transcribe one pre-cropped staff).
 * Full-page SegNet + geometry arrive in Phase 3.
 */
import { loadModels, webGpuAvailable, type ModelSet } from "./models.js";
import { staffSymbolsToNoteEvents, symbolsToMidi, type MidiNoteEvent } from "./midi.js";
import { transcribeStaff, ENCODER_WIDTH, ENCODER_HEIGHT } from "./transformer.js";
import {
  detectStaffsInImage,
  extractPagePredictions,
  parseStaffs,
  preprocessPageImage,
  splitVoiceByStaff,
} from "./page.js";

export type WorkerRequest =
  | { type: "load"; encoderUrl: string; decoderUrl: string; segnetUrl?: string; wasmPaths?: string }
  | { type: "transcribe-staff"; pixels: ArrayBuffer; width: number; height: number; title?: string }
  | {
      type: "transcribe-page";
      pixels: ArrayBuffer;
      width: number;
      height: number;
      format?: "rgba" | "rgb" | "gray";
      title?: string;
    };

export interface NoteLayoutEntry {
  /** MIDI note number. */
  pitch: number;
  /** Onset in seconds on the generated MIDI timeline. */
  startSec: number;
  /** End in seconds on the generated MIDI timeline. */
  endSec: number;
  /** Coarse box in staff-crop pixels, from decoder attention. Null on fallback. */
  box: { x: number; y: number; w: number; h: number } | null;
}

export type WorkerResponse =
  | { type: "ready"; webgpu: boolean }
  | { type: "progress"; stage: string }
  | {
      type: "result";
      midi: ArrayBuffer;
      noteLayout: NoteLayoutEntry[];
      layoutSource: "attention" | "midi-fallback";
      staffCount: number;
      warnings: string[];
      /** Raw decoded symbols (demo/diagnostics; sheet-cam consumes midi + noteLayout). One entry per voice for transcribe-page. */
      symbols: Array<Record<string, string>> | Array<Array<Record<string, string>>>;
    }
  | { type: "error"; message: string };

let models: ModelSet | null = null;

// Minimal worker-global binding (avoids pulling in lib.webworker, which
// conflicts with lib.dom in the shared tsconfig). `self` exists at runtime in
// a real Worker; the alias keeps the type narrow without a bare `declare`.
const workerSelf: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
} = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
};

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  workerSelf.postMessage(response, transfer);
}

const SECONDS_PER_TICK = 60 / 72 / 480; // SCAN_TEMPO_BPM / TICKS_PER_QUARTER in midi.ts

/** Size of the square drawn around a decoder attention point, in crop px. */
const ATTENTION_BOX_SIZE = 24;

function layoutEntryForAttention(
  pitch: number,
  startSec: number,
  endSec: number,
  attention: [number, number] | null,
  cropToPage: ((x: number, y: number) => [number, number]) | undefined,
  onAttentionBox: () => void,
): NoteLayoutEntry {
  if (attention && cropToPage) {
    const [ax, ay] = attention;
    const half = ATTENTION_BOX_SIZE / 2;
    const [x0, y0] = cropToPage(ax - half, ay - half);
    const [x1, y1] = cropToPage(ax + half, ay + half);
    onAttentionBox();
    return {
      pitch,
      startSec,
      endSec,
      box: {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
      },
    };
  }
  return { pitch, startSec, endSec, box: null };
}

async function handleTranscribePage(
  pixels: ArrayBuffer,
  width: number,
  height: number,
  format: "rgba" | "rgb" | "gray",
  title?: string,
): Promise<void> {
  if (!models) throw new Error("models not loaded; send 'load' first");
  if (!models.segnet) {
    throw new Error("segnet model not loaded; send 'load' with segnetUrl for transcribe-page");
  }
  post({ type: "progress", stage: "preprocessing page" });
  const page = preprocessPageImage(new Uint8Array(pixels), width, height, format);
  const masks = await extractPagePredictions(models.segnet, page.preprocessed, (stage) =>
    post({ type: "progress", stage }),
  );
  post({ type: "progress", stage: "detecting staffs" });
  const { multiStaffs, staffs } = detectStaffsInImage(masks, page.preprocessed);
  const voices = await parseStaffs(
    multiStaffs,
    page.preprocessed,
    models.encoder,
    models.decoder,
    undefined,
    (stage) => post({ type: "progress", stage }),
  );
  post({ type: "progress", stage: "writing MIDI" });
  const voiceSymbols = voices.map((v) => v.symbols);
  const { midi, warnings } = symbolsToMidi(voiceSymbols, title ?? "homr scan");

  // Per-voice, per-staff layout: re-decode each staff's symbol group with a
  // running tick cursor so event ticks match the flattened MIDI timeline,
  // then map the decoder attention point through the staff's crop->page
  // chain. Boxes are coarse (documented); missing attention or a missing
  // crop mapping falls back to a null box (midi-fallback).
  let attentionBoxes = 0;
  const noteLayout: NoteLayoutEntry[] = [];
  voices.forEach((voice, voiceIdx) => {
    const groups = splitVoiceByStaff(voice.symbols);
    if (groups.length !== voice.cropToPage.length) {
      warnings.push(
        `voice ${voiceIdx}: ${groups.length} staff groups vs ${voice.cropToPage.length} crop mappings; some boxes may be missing`,
      );
    }
    let cursor = 0;
    groups.forEach((group, groupIdx) => {
      const { events, endTick } = staffSymbolsToNoteEvents(group, voiceIdx);
      const toPage = voice.cropToPage[groupIdx];
      for (const ev of events) {
        const tick = ev.tick + cursor;
        noteLayout.push(
          layoutEntryForAttention(
            ev.midi,
            tick * SECONDS_PER_TICK,
            (tick + ev.durationTicks) * SECONDS_PER_TICK,
            ev.attention,
            toPage,
            () => {
              attentionBoxes += 1;
            },
          ),
        );
      }
      cursor += endTick;
    });
  });

  // Sort layout by onset so consumers see chronological order.
  noteLayout.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);

  const out = midi.slice().buffer as ArrayBuffer;
  post(
    {
      type: "result",
      midi: out,
      noteLayout,
      layoutSource: attentionBoxes > 0 ? "attention" : "midi-fallback",
      staffCount: staffs.length,
      warnings,
      symbols: voiceSymbols.map((symbols) =>
        symbols.map((s) => ({
          rhythm: s.rhythm,
          pitch: s.pitch,
          lift: s.lift,
          articulation: s.articulation,
          slur: s.slur,
          position: s.position,
        })),
      ),
    },
    [out],
  );
}

async function handleTranscribeStaff(pixels: ArrayBuffer, width: number, height: number, title?: string): Promise<void> {
  if (!models) throw new Error("models not loaded; send 'load' first");
  if (width !== ENCODER_WIDTH || height !== ENCODER_HEIGHT) {
    throw new Error(`staff crop must be ${ENCODER_WIDTH}x${ENCODER_HEIGHT}, got ${width}x${height}`);
  }
  post({ type: "progress", stage: "encoding staff" });
  const symbols = await transcribeStaff(models.encoder, models.decoder, new Uint8Array(pixels), width, height);
  post({ type: "progress", stage: "writing MIDI" });
  const { midi, noteEvents, staffCount, warnings } = symbolsToMidi([symbols], title ?? "homr scan");

  // Attention boxes are coarse; keep a midi-onset fallback so highlighting
  // still works when attention is missing or degenerate.
  let attentionBoxes = 0;
  const noteLayout: NoteLayoutEntry[] = noteEvents.map((ev: MidiNoteEvent) => {
    const startSec = ev.tick * SECONDS_PER_TICK;
    const endSec = (ev.tick + ev.durationTicks) * SECONDS_PER_TICK;
    if (ev.attention) {
      attentionBoxes += 1;
      const [x, y] = ev.attention;
      const size = 24;
      return {
        pitch: ev.midi,
        startSec,
        endSec,
        box: { x: Math.max(0, x - size / 2), y: Math.max(0, y - size / 2), w: size, h: size },
      };
    }
    return { pitch: ev.midi, startSec, endSec, box: null };
  });

  const out = midi.slice().buffer as ArrayBuffer;
  post(
    {
      type: "result",
      midi: out,
      noteLayout,
      layoutSource: attentionBoxes > 0 ? "attention" : "midi-fallback",
      staffCount,
      warnings,
      symbols: symbols.map((s) => ({
        rhythm: s.rhythm,
        pitch: s.pitch,
        lift: s.lift,
        articulation: s.articulation,
        slur: s.slur,
        position: s.position,
      })),
    },
    [out],
  );
}

workerSelf.onmessage = (event: { data: WorkerRequest }) => {
  const request = event.data;
  (async () => {
    try {
      if (request.type === "load") {
        if (request.wasmPaths) {
          const { setWasmPaths } = await import("./models.js");
          setWasmPaths(request.wasmPaths);
        }
        models = await loadModels(
          {
            encoderUrl: request.encoderUrl,
            decoderUrl: request.decoderUrl,
            segnetUrl: request.segnetUrl,
          },
          (stage) => post({ type: "progress", stage }),
        );
        post({ type: "ready", webgpu: webGpuAvailable() });
      } else if (request.type === "transcribe-staff") {
        await handleTranscribeStaff(request.pixels, request.width, request.height, request.title);
      } else if (request.type === "transcribe-page") {
        await handleTranscribePage(
          request.pixels,
          request.width,
          request.height,
          request.format ?? "rgba",
          request.title,
        );
      } else {
        throw new Error(`unknown request type ${(request as { type: string }).type}`);
      }
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
