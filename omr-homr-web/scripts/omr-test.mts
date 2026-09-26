#!/usr/bin/env node --import tsx/esm
/*
 * omr-test — the agent/CLI TDD loop entrypoint for the omr-homr-web OMR port.
 *
 *   omr-test fixtures/<id>            run one fixture through its match_tier
 *   omr-test --tier exact_tokens --no-onnx   writer-only, instant, no models
 *   omr-test --tier exact_tokens              full check incl. ONNX inference
 *   omr-test --tier midi_distance --fetch     fetch downloadable fixtures first
 *
 * Exit 0 = every executed fixture passed its tier. Every run prints the token
 * edit distance and the MIDI edit distance for each fixture.
 *
 * Layer A (tokens): decoded symbols vs expected.tokens.json (Python homr
 * oracle), exact or fixture-declared Levenshtein threshold.
 * Layer B (MIDI): note list from the writer vs expected.notes.csv (canonical
 * GT from the notation source, never from homr). Compared as sorted
 * (tick,pitch,duration,staff) tuples, not SMF bytes.
 *
 * Tier rules:
 *   exact_tokens -> fail on any token or MIDI mismatch
 *   exact_midi   -> fail on MIDI mismatch only (tokens report-only)
 *   midi_distance-> fail only above meta.yaml midi_distance_threshold
 *   snapshot     -> never fail
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import * as ort from "onnxruntime-web";
import { wrap } from "../src/models.js";
import {
  DecodedSymbol,
  decodeStaff,
  encodeStaff,
  preprocessStaff,
} from "../src/transformer.js";
import { symbolsToMidi } from "../src/midi.js";

const root = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(root, "..");
const fixturesDir = join(pkgRoot, "fixtures");
const ENCODER = join(pkgRoot, "models", "transformer_encoder_model_fp32.onnx");
const DECODER = join(pkgRoot, "models", "transformer_decoder_model_fp32.onnx");

const FIELDS = ["rhythm", "pitch", "lift", "articulation", "slur", "position"] as const;

interface FixtureMeta {
  id: string;
  match_tier: string;
  midi_distance_threshold?: number;
  input?: string;
  description?: string;
}

function parseMetaYaml(text: string): FixtureMeta {
  const meta: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    id: meta.id ?? "",
    match_tier: meta.match_tier ?? "snapshot",
    midi_distance_threshold: meta.midi_distance_threshold ? Number(meta.midi_distance_threshold) : undefined,
    input: meta.input,
    description: meta.description,
  };
}

function parseNotesCsv(text: string): string[] {
  const lines = text.trim().split("\n");
  const rows = lines[0].startsWith("tick") ? lines.slice(1) : lines;
  return rows.map((r) => r.trim()).filter(Boolean).sort();
}

/** Levenshtein distance over string sequences. */
function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

const symKey = (s: DecodedSymbol | Record<string, string>) =>
  FIELDS.map((f) => String(s[f] ?? "?")).join("|");

function diffDetail(a: string[], b: string[], label: string, max = 6): string {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return "";
  const out = [`  ${label} diff (first ${max}):`];
  const n = Math.min(max, Math.max(a.length, b.length));
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) out.push(`    [${i}] got=${a[i] ?? "∅"} want=${b[i] ?? "∅"}`);
  }
  if (Math.max(a.length, b.length) > n) out.push(`    ... (${a.length} vs ${b.length} items)`);
  return out.join("\n");
}

interface OnnxSessions {
  encoder: ReturnType<typeof wrap>;
  decoder: ReturnType<typeof wrap>;
}

let sessions: OnnxSessions | null = null;
async function getSessions(): Promise<OnnxSessions | null> {
  if (sessions) return sessions;
  if (!existsSync(ENCODER) || !existsSync(DECODER)) return null;
  ort.env.wasm.wasmPaths = join(pkgRoot, "node_modules", "onnxruntime-web", "dist") + "/";
  ort.env.wasm.numThreads = 4;
  const encoder = wrap(await ort.InferenceSession.create(ENCODER, { executionProviders: ["wasm"] }));
  const decoder = wrap(await ort.InferenceSession.create(DECODER, { executionProviders: ["wasm"] }));
  sessions = { encoder, decoder };
  return sessions;
}

function loadStaffPixels(pngPath: string): Uint8Array {
  const png = PNG.sync.read(readFileSync(pngPath));
  if (png.width !== 1280 || png.height !== 256) {
    throw new Error(`expected 1280x256 staff crop, got ${png.width}x${png.height}`);
  }
  const gray = new Uint8Array(1280 * 256);
  for (let i = 0; i < gray.length; i += 1) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2], a = png.data[i * 4 + 3];
    // composite over white (cairosvg-style transparent backgrounds)
    const rr = (r * a + 255 * (255 - a)) / 255;
    const gg = (g * a + 255 * (255 - a)) / 255;
    const bb = (b * a + 255 * (255 - a)) / 255;
    gray[i] = Math.round(0.299 * rr + 0.587 * gg + 0.114 * bb);
  }
  return gray;
}

interface FixtureResult {
  id: string;
  tier: string;
  tokenDistance: number | null;
  midiDistance: number;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string[];
}

async function runFixture(id: string, withOnnx: boolean): Promise<FixtureResult> {
  const dir = join(fixturesDir, id);
  const detail: string[] = [];
  const fail = (msg: string): FixtureResult => ({
    id, tier: "?", tokenDistance: null, midiDistance: -1, status: "FAIL", detail: [msg],
  });
  if (!existsSync(dir)) return fail(`fixture dir missing: ${dir}`);
  const meta = parseMetaYaml(readFileSync(join(dir, "meta.yaml"), "utf8"));
  const tier = meta.match_tier;

  // ---- Layer B: writer-only (always runs) ----
  const tokensPath = join(dir, "expected.tokens.json");
  if (!existsSync(tokensPath)) {
    if (tier === "snapshot" || tier === "exact_midi") {
      return { id, tier, tokenDistance: null, midiDistance: -1, status: "SKIP", detail: ["no expected.tokens.json yet (page-level fixture, needs geometry)"] };
    }
    return fail("expected.tokens.json missing");
  }
  const tokens = JSON.parse(readFileSync(tokensPath, "utf8")) as DecodedSymbol[];
  const { noteEvents, warnings } = symbolsToMidi([tokens], id);
  for (const w of warnings) detail.push(`  writer warning: ${w}`);
  const gotNotes = noteEvents
    .map((e) => `${e.tick},${e.midi},${e.durationTicks},${e.staff}`)
    .sort();
  const wantNotes = parseNotesCsv(readFileSync(join(dir, "expected.notes.csv"), "utf8"));
  const midiDistance = editDistance(gotNotes, wantNotes);
  const md = diffDetail(gotNotes, wantNotes, "MIDI");
  if (md) detail.push(md);

  // ---- Layer A: tokens ----
  let tokenDistance: number | null = null;
  if (withOnnx && !meta.input?.startsWith("full page")) {
    const s = await getSessions();
    if (!s) {
      detail.push("  ONNX models missing (npm run fetch:models); token check skipped");
    } else {
      const t0 = Date.now();
      const pixels = loadStaffPixels(join(dir, "input.png"));
      const ctx = await encodeStaff(s.encoder, preprocessStaff(pixels, 1280, 256));
      const decoded = await decodeStaff(s.decoder, ctx);
      tokenDistance = editDistance(decoded.map(symKey), tokens.map(symKey));
      detail.push(`  inference ${(Date.now() - t0) / 1000}s`);
      const td = diffDetail(decoded.map(symKey), tokens.map(symKey), "tokens");
      if (td) detail.push(td);
    }
  } else if (withOnnx) {
    detail.push("  page-level input: token check needs geometry (Phase 3), skipped");
  }

  // ---- tier verdict ----
  let status: FixtureResult["status"] = "PASS";
  if (tier === "exact_tokens") {
    if (midiDistance !== 0) status = "FAIL";
    if (withOnnx && tokenDistance !== null && tokenDistance !== 0) status = "FAIL";
  } else if (tier === "exact_midi") {
    if (midiDistance !== 0) status = "FAIL";
  } else if (tier === "midi_distance") {
    const thr = meta.midi_distance_threshold ?? 0;
    if (midiDistance > thr) status = "FAIL";
  } // snapshot never fails

  return { id, tier, tokenDistance, midiDistance, status, detail };
}

function listFixtures(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let tierFilter: string | null = null;
  let noOnnx = false;
  let doFetch = false;
  let single: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--tier") tierFilter = args[++i];
    else if (a === "--no-onnx") noOnnx = true;
    else if (a === "--fetch") doFetch = true;
    else if (a.startsWith("fixtures/")) single = a.slice("fixtures/".length);
    else if (!a.startsWith("-")) single = a;
  }

  if (doFetch) {
    console.log("(fetch: no downloadable fixtures are registered yet; nothing to do)");
  }

  let ids = single ? [single] : listFixtures();
  if (tierFilter) {
    ids = ids.filter((id) => {
      const mPath = join(fixturesDir, id, "meta.yaml");
      return existsSync(mPath) && parseMetaYaml(readFileSync(mPath, "utf8")).match_tier === tierFilter;
    });
  }
  if (ids.length === 0) {
    console.log("no fixtures selected");
    return 0;
  }

  const withOnnx = !noOnnx;
  let failed = 0;
  for (const id of ids) {
    let r: FixtureResult;
    try {
      r = await runFixture(id, withOnnx);
    } catch (e) {
      r = { id, tier: "?", tokenDistance: null, midiDistance: -1, status: "FAIL", detail: [String(e)] };
    }
    const tok = r.tokenDistance === null ? "n/a" : String(r.tokenDistance);
    console.log(`${r.status} ${r.id} [${r.tier}] token_distance=${tok} midi_distance=${r.midiDistance}`);
    for (const d of r.detail) console.log(d);
    if (r.status === "FAIL") failed += 1;
  }
  console.log(`\n${ids.length - failed}/${ids.length} passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
