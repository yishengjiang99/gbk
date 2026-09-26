/*
 * Phase 3 gates: SegNet tiling/stitching, staff geometry, dewarp, and the
 * full page -> tokens -> MIDI -> layout pipeline on the C-scale fixture.
 *
 * Scoring is kept separate per layer:
 *   Layer A (tokens): exact six-head symbol match vs the Python oracle.
 *   Layer B (MIDI):   canonical (tick,pitch,duration,staff) event lists.
 *   Layer C (layout): every sounding MIDI note has a layout entry.
 *
 * Model-backed tests skip when models are absent (npm run fetch:models).
 * The fp16 SegNet cannot run under plain node:test quickly (60 overlapping
 * tiles), so pipeline tests feed the Python-generated argmax label oracle
 * through the same filter + make_lines_stronger path the worker uses; the
 * tiling/overlap/argmax/stitch logic itself is unit-tested with a stub
 * session below, and a real-SegNet end-to-end run was validated separately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import * as ort from "onnxruntime-web";
import { wrap } from "../src/models.js";
import type { SessionLike, TensorLike } from "../src/transformer.js";
import {
  SEGNET_WINDOW,
  extractTiles,
  masksFromLabels,
  mergePatches,
  runSegNet,
  type SegNetMasks,
} from "../src/geometry/segnet.js";
import { GrayImage } from "../src/geometry/image.js";
import { Staff, StaffPoint } from "../src/geometry/staff-model.js";
import {
  IMAGE_NOISE_LIMIT,
  buildPageNoteLayout,
  detectStaffsInImage,
  ensureSameNumberOfStaffs,
  parseStaffs,
  preprocessPageImage,
  type ParsedVoice,
} from "../src/page.js";
import { filterPredictions, makeLinesStronger } from "../src/geometry/staff.js";
import {
  calculateSpanAndOptimalPoints,
  dewarpStaffImage,
  prepareStaffImage,
} from "../src/geometry/dewarp.js";
import { StaffRegions } from "../src/geometry/staff-model.js";
import { symbolsToMidi } from "../src/midi.js";
import type { DecodedSymbol } from "../src/vocab.js";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(root, "fixtures", name);
const modelPath = (name: string) => join(root, "..", "models", name);

const ENCODER = modelPath("transformer_encoder_model_fp32.onnx");
const DECODER = modelPath("transformer_decoder_model_fp32.onnx");
const modelsPresent = existsSync(ENCODER) && existsSync(DECODER);

// ---------------------------------------------------------------------------
// SegNet tiling / argmax / stitching (stub session, no models needed)
// ---------------------------------------------------------------------------

/** Stub SegNet: every pixel of tile n predicts class (n % 6). */
function stubSegNetSession() {
  let counter = 0;
  const batchSizes: number[] = [];
  const session: SessionLike = {
    async run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>> {
      const n = feeds["input"].dims[0] as number;
      batchSizes.push(n);
      const hw = SEGNET_WINDOW * SEGNET_WINDOW;
      const logits = new Float32Array(n * 6 * hw);
      for (let b = 0; b < n; b++) {
        const cls = (counter + b) % 6;
        const base = b * 6 * hw;
        for (let i = 0; i < hw; i++) logits[base + cls * hw + i] = 2;
      }
      counter += n;
      return {
        output: { dims: [n, 6, SEGNET_WINDOW, SEGNET_WINDOW], float32Data: logits },
      };
    },
  };
  return { session, batchSizes };
}

// 640x480, step 160, window 320 -> 12 tiles (y outer, x inner), origins:
const EXPECTED_ORIGINS: Array<[number, number]> = [
  [0, 0], [160, 0], [320, 0], [320, 0],
  [0, 160], [160, 160], [320, 160], [320, 160],
  [0, 160], [160, 160], [320, 160], [320, 160],
];

describe("segnet tiling, argmax and stitching", () => {
  it("extracts overlapping tiles at the expected origins", () => {
    const tiles = extractTiles(GrayImage.zeros(640, 480), 160);
    assert.equal(tiles.length, 12);
    tiles.forEach((t, i) => {
      assert.deepEqual([t.x, t.y], EXPECTED_ORIGINS[i], `tile ${i} origin`);
      assert.equal(t.data.length, 3 * SEGNET_WINDOW * SEGNET_WINDOW);
    });
  });

  it("pads out-of-bounds tile regions white", () => {
    // 200x200 image: single tile at clamped origin (min(0, 200-320) = -120).
    const tiles = extractTiles(GrayImage.zeros(200, 200), 320);
    assert.equal(tiles.length, 1);
    assert.deepEqual([tiles[0].x, tiles[0].y], [-120, -120]);
    // Top-left pixel of the tile is out of bounds -> 255 on all channels.
    assert.equal(tiles[0].data[0], 255);
  });

  it("argmaxes per tile and averages/truncates overlaps like numpy", async () => {
    const { session, batchSizes } = stubSegNetSession();
    const labels = await runSegNet(session, GrayImage.zeros(640, 480), {
      stepSize: 160,
      batchSize: 8,
    });
    assert.deepEqual(batchSizes, [8, 4]);
    const at = (x: number, y: number) => labels[y * 640 + x];
    // tile classes are [0,1,2,3,4,5,0,1,2,3,4,5]
    assert.equal(at(100, 100), 0); // tile 0 only
    assert.equal(at(200, 100), 0); // tiles 0,1 -> floor((0+1)/2)
    assert.equal(at(400, 100), 2); // tiles 2,3 -> floor((2+3)/2)
    assert.equal(at(200, 200), 2); // tiles 0,1,4,5 -> floor(10/4)
    assert.equal(at(400, 200), 2); // tiles 2,3,6,7,10,11 -> floor(15/6)
    assert.equal(at(500, 400), 2); // tiles 6,7,10,11 -> floor((0+1+4+5)/4)
    assert.equal(at(100, 300), 2); // tiles 0,4,8 -> floor((0+4+2)/3)
  });

  it("mergePatches truncates toward zero on overlaps", () => {
    const tiles = extractTiles(GrayImage.zeros(640, 480), 160);
    const patches = EXPECTED_ORIGINS.map((_, i) => {
      const p = new Int32Array(SEGNET_WINDOW * SEGNET_WINDOW);
      p.fill(i % 6);
      return p;
    });
    const labels = mergePatches(patches, tiles, 640, 480);
    // (500,400): tiles 6,7,10,11 -> classes 0,1,4,5 -> floor(10/4) = 2
    assert.equal(labels[400 * 640 + 500], 2);
    // (100,300): tiles 0,4,8 -> classes 0,4,2 -> floor(6/3) = 2
    assert.equal(labels[300 * 640 + 100], 2);
    // uncovered pixels (none here) default to 0; every pixel is covered.
    assert.ok(labels.every((v) => v >= 0 && v < 6));
  });

  it("masksFromLabels splits the six classes into the five masks", () => {
    const labels = new Int32Array([0, 1, 2, 3, 4, 5]);
    const masks = masksFromLabels(labels, 3, 2);
    assert.deepEqual([...masks.staff.data], [0, 0, 0, 0, 1, 0]);
    assert.deepEqual([...masks.symbols.data], [0, 0, 0, 0, 0, 1]);
    assert.deepEqual([...masks.stemsRest.data], [0, 1, 0, 0, 0, 0]);
    assert.deepEqual([...masks.notehead.data], [0, 0, 1, 0, 0, 0]);
    assert.deepEqual([...masks.clefsKeys.data], [0, 0, 0, 1, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Oracle fixtures
// ---------------------------------------------------------------------------

function readLabelFixture(name: string): { labels: Int32Array; width: number; height: number } {
  const lp = PNG.sync.read(readFileSync(fixture(name)));
  const labels = new Int32Array(lp.width * lp.height);
  for (let i = 0; i < labels.length; i++) labels[i] = lp.data[i * 4];
  return { labels, width: lp.width, height: lp.height };
}

/** Oracle argmax labels through the worker's filter + make_lines_stronger path. */
function oracleMasks(name: string): SegNetMasks {
  const { labels, width, height } = readLabelFixture(name);
  const masks = masksFromLabels(labels, width, height);
  filterPredictions(masks, IMAGE_NOISE_LIMIT);
  masks.staff = makeLinesStronger(masks.staff, 1, 2);
  return masks;
}

function cScalePage(): GrayImage {
  // LilyPond-engraved C-scale page from the gbk ground-truth fixtures.
  const p = join(root, "..", "..", "test", "fixtures", "ocr-ground-truth", "c-scale.png");
  const srcPng = PNG.sync.read(readFileSync(p));
  return preprocessPageImage(srcPng.data, srcPng.width, srcPng.height, "rgba").preprocessed;
}

describe("c-scale staff detection (oracle SegNet labels)", () => {
  it("finds exactly one staff with the oracle x-extent", () => {
    const { labels, width, height } = readLabelFixture("c-scale_segnet_labels.png");
    void labels;
    const masks = oracleMasks("c-scale_segnet_labels.png");
    const { multiStaffs, staffs } = detectStaffsInImage(masks, GrayImage.zeros(width, height));
    assert.equal(staffs.length, 1);
    assert.equal(multiStaffs.length, 1);
    assert.deepEqual(multiStaffs.map((m) => m.staffs.length), [1]);
    const s = staffs[0];
    // x-extent matches the Python oracle exactly.
    assert.equal(s.minX, 240);
    assert.equal(s.maxX, 1570);
    // y-extent and unit size are close; known ~5px gap from contour-vs-pixel
    // staff line boundaries (documented fidelity gap).
    const oracle = JSON.parse(readFileSync(fixture("c-scale_staff_oracle.json"), "utf8"));
    assert.ok(Math.abs(s.minY - oracle.staffs[0].min_y) < 8, `minY ${s.minY}`);
    assert.ok(Math.abs(s.maxY - oracle.staffs[0].max_y) < 8, `maxY ${s.maxY}`);
    assert.ok(
      Math.abs(s.averageUnitSize - oracle.staffs[0].average_unit_size) < 1.5,
      `unit ${s.averageUnitSize}`,
    );
  });

  it("orders staffs top-to-bottom", () => {
    const { width, height } = readLabelFixture("c-scale_segnet_labels.png");
    const masks = oracleMasks("c-scale_segnet_labels.png");
    const { staffs } = detectStaffsInImage(masks, GrayImage.zeros(width, height));
    for (let i = 1; i < staffs.length; i++) {
      assert.ok(staffs[i].minY >= staffs[i - 1].minY, "staffs sorted by minY");
    }
  });
});

describe("sweden staff detection and grand-staff grouping", () => {
  it("finds 8 staffs grouped into 4 grand staffs, top-to-bottom", () => {
    const { width, height } = readLabelFixture("sweden_segnet_labels.png");
    const masks = oracleMasks("sweden_segnet_labels.png");
    const { multiStaffs, staffs } = detectStaffsInImage(masks, GrayImage.zeros(width, height));
    const oracle = JSON.parse(readFileSync(fixture("sweden_staff_oracle.json"), "utf8"));
    assert.equal(staffs.length, oracle.staffs.length);
    assert.deepEqual(multiStaffs.map((m) => m.staffs.length), oracle.multi_staff_rows);
    for (let i = 1; i < staffs.length; i++) {
      assert.ok(staffs[i].minY >= staffs[i - 1].minY, "staffs sorted by minY");
    }
  });
});

// ---------------------------------------------------------------------------
// Dewarp
// ---------------------------------------------------------------------------

function straightStaff(): Staff {
  const pts: StaffPoint[] = [];
  for (let x = 0; x <= 1280; x += 10) {
    pts.push(new StaffPoint(x, [100, 124, 148, 172, 196], 0));
  }
  return new Staff(pts);
}

function bentStaff(): Staff {
  const pts: StaffPoint[] = [];
  for (let x = 0; x <= 1280; x += 10) {
    const mid = 148 + Math.trunc(x * 0.05);
    pts.push(new StaffPoint(x, [mid - 48, mid - 24, mid, mid + 24, mid + 48], 0));
  }
  return new Staff(pts);
}

describe("dewarp control points and transform", () => {
  it("a straight staff yields span == optimal (identity warp)", () => {
    const staff = straightStaff();
    const img = GrayImage.zeros(1280, 256);
    const { spanPoints, optimalPoints } = calculateSpanAndOptimalPoints(staff, img);
    assert.ok(spanPoints.length > 0);
    assert.equal(spanPoints.length, optimalPoints.length);
    for (let b = 0; b < spanPoints.length; b++) {
      assert.equal(spanPoints[b].length, optimalPoints[b].length);
      // Optimal points share x and sit at the band's average y.
      const ys = new Set(optimalPoints[b].map((p) => p[1]));
      assert.equal(ys.size, 1, "optimal y constant per band");
      for (let i = 0; i < spanPoints[b].length; i++) {
        assert.ok(Math.abs(spanPoints[b][i][1] - optimalPoints[b][i][1]) < 1e-9);
        assert.equal(spanPoints[b][i][0], optimalPoints[b][i][0]);
      }
    }
    // Identity warp reproduces the image.
    const test = GrayImage.zeros(1280, 256);
    test.data.fill(255);
    for (let x = 0; x < 1280; x++) test.data[148 * 1280 + x] = 0;
    const out = dewarpStaffImage(test, staff).dewarp(test);
    let sum = 0;
    for (let i = 0; i < test.data.length; i++) sum += Math.abs(out.data[i] - test.data[i]);
    assert.ok(sum / test.data.length < 1, `identity warp meanAbs ${sum / test.data.length}`);
  });

  it("a bent staff's span points follow the drift; warp straightens it", () => {
    const staff = bentStaff();
    const img = GrayImage.zeros(1280, 256);
    const { spanPoints, optimalPoints } = calculateSpanAndOptimalPoints(staff, img);
    assert.ok(spanPoints.length > 0);
    const band = spanPoints[0];
    assert.ok(band[band.length - 1][1] > band[0][1], "span y increases with x along the drift");
    assert.equal(new Set(optimalPoints[0].map((p) => p[1])).size, 1);

    // Draw a line following the bend; after dewarping it must be horizontal.
    const bent = GrayImage.zeros(1280, 256);
    bent.data.fill(255);
    for (let x = 0; x < 1280; x++) {
      const y = 148 + Math.trunc(x * 0.05);
      bent.data[y * 1280 + x] = 0;
    }
    const out = dewarpStaffImage(bent, staff).dewarp(bent);
    const rows: number[] = [];
    for (let x = 100; x < 1180; x += 16) {
      let bestY = -1;
      let bestV = 256;
      for (let y = 50; y < 220; y++) {
        const v = out.data[y * 1280 + x];
        if (v < bestV) {
          bestV = v;
          bestY = y;
        }
      }
      if (bestV < 128) rows.push(bestY);
    }
    assert.ok(rows.length > 40, `line found in ${rows.length} columns`);
    const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
    const std = Math.sqrt(rows.reduce((a, b) => a + (b - mean) ** 2, 0) / rows.length);
    assert.ok(std < 2, `dewarped line std ${std}`);
  });
});

describe("c-scale crop vs Python oracle", () => {
  it("matches the oracle crop within tolerance", () => {
    const { width, height } = readLabelFixture("c-scale_segnet_labels.png");
    const masks = oracleMasks("c-scale_segnet_labels.png");
    const page = cScalePage();
    assert.equal(page.width, width);
    assert.equal(page.height, height);
    const { multiStaffs } = detectStaffsInImage(masks, page);
    const systems = ensureSameNumberOfStaffs(multiStaffs);
    const regions = new StaffRegions(systems);
    const prepared = prepareStaffImage(multiStaffs[0].staffs[0], page, regions);
    assert.equal(prepared.image.width, 1280);
    assert.equal(prepared.image.height, 256);

    const op = PNG.sync.read(readFileSync(fixture("c-scale-staff-0_oracle.png")));
    assert.equal(op.width, 1280);
    assert.equal(op.height, 256);
    const a = prepared.image.data;
    let sum = 0;
    let big = 0;
    for (let i = 0; i < a.length; i++) {
      // pngjs always decodes to RGBA; oracle was saved grayscale.
      const d = Math.abs(a[i] - op.data[i * 4]);
      sum += d;
      if (d > 32) big++;
    }
    const meanAbs = sum / a.length;
    const bigFrac = big / a.length;
    // Honest tolerances: residual comes from staff y-extent (~5px), resize
    // interpolation, CLAHE approximation and forward/inverse warp sampling.
    // Measured 2026-09-26: meanAbs 18.9, bigFrac 0.126.
    assert.ok(meanAbs < 25, `crop meanAbs ${meanAbs}`);
    assert.ok(bigFrac < 0.15, `crop bigFrac ${bigFrac}`);
  });
});

// ---------------------------------------------------------------------------
// Layer A/B/C: page -> tokens -> MIDI -> layout (C-scale)
// ---------------------------------------------------------------------------

interface PagePipeline {
  voices: ParsedVoice[];
  oracleTokens: DecodedSymbol[];
}

async function runCScalePipeline(): Promise<PagePipeline> {
  const encSession = await ort.InferenceSession.create(ENCODER, { executionProviders: ["wasm"] });
  const decSession = await ort.InferenceSession.create(DECODER, { executionProviders: ["wasm"] });
  const masks = oracleMasks("c-scale_segnet_labels.png");
  const page = cScalePage();
  const { multiStaffs } = detectStaffsInImage(masks, page);
  const voices = await parseStaffs(
    multiStaffs,
    page,
    wrap(encSession as never),
    wrap(decSession as never),
  );
  const oracleTokens = JSON.parse(
    readFileSync(fixture("c-scale-raw-tokens.json"), "utf8"),
  ) as DecodedSymbol[];
  return { voices, oracleTokens };
}

const canonical = (events: { tick: number; midi: number; durationTicks: number; staff: number }[]) =>
  events.map((e) => `${e.tick},${e.midi},${e.durationTicks},${e.staff}`);

describe("c-scale page pipeline", { skip: !modelsPresent }, () => {
  it("Layer A: page decodes to the exact oracle token sequence", async () => {
    const { voices, oracleTokens } = await runCScalePipeline();
    assert.equal(voices.length, 1);
    const toks = voices[0].symbols.filter((s) => s.rhythm !== "newline");
    assert.equal(toks.length, oracleTokens.length);
    toks.forEach((t, i) => {
      const o = oracleTokens[i];
      assert.deepEqual(
        {
          rhythm: t.rhythm,
          pitch: t.pitch,
          lift: t.lift,
          articulation: t.articulation,
          slur: t.slur,
          position: t.position,
        },
        {
          rhythm: o.rhythm,
          pitch: o.pitch,
          lift: o.lift,
          articulation: o.articulation,
          slur: o.slur,
          position: o.position,
        },
        `token ${i}`,
      );
    });
  });

  it("Layer B: canonical MIDI events match the oracle tokens' MIDI", async () => {
    const { voices, oracleTokens } = await runCScalePipeline();
    const got = symbolsToMidi(voices.map((v) => v.symbols));
    const want = symbolsToMidi([oracleTokens]);
    assert.deepEqual(canonical(got.noteEvents), canonical(want.noteEvents));
    assert.equal(got.noteEvents.length, 15);
    // And the known C-scale shape (E4..E5 up and back, quarter notes).
    assert.deepEqual(
      got.noteEvents.map((e) => e.midi),
      [64, 65, 67, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 65, 64],
    );
  });

  it("Layer C: every sounding MIDI note has a layout entry", async () => {
    const { voices } = await runCScalePipeline();
    const { noteEvents } = symbolsToMidi(voices.map((v) => v.symbols));
    const { layout, attentionBoxes, warnings } = buildPageNoteLayout(voices);
    assert.deepEqual(warnings, []);
    assert.equal(layout.length, noteEvents.length);
    // Every MIDI event is covered by exactly one layout entry.
    const gotCanon = new Set(
      noteEvents.map((e) => `${e.tick},${e.midi},${e.durationTicks}`),
    );
    const TICKS_PER_SEC = 480 / (60 / 72);
    for (const l of layout) {
      const tick = Math.round(l.startSec * TICKS_PER_SEC);
      const dur = Math.round((l.endSec - l.startSec) * TICKS_PER_SEC);
      assert.ok(gotCanon.has(`${tick},${l.pitch},${dur}`), `layout entry ${tick},${l.pitch},${dur}`);
    }
    // All C-scale notes got coarse attention boxes (documented as coarse).
    assert.equal(attentionBoxes, noteEvents.length);
    assert.ok(layout.every((l) => l.box !== null));
  });

  it("Layer C fallback: missing crop mapping yields null boxes (midi-fallback)", () => {
    const symbols: DecodedSymbol[] = [
      {
        rhythm: "note_4",
        pitch: "C4",
        lift: "_",
        articulation: "_",
        slur: "_",
        position: "second_line",
        attention: [640, 128],
      },
    ];
    // No cropToPage mappings: attention cannot be placed on the page.
    const voice = { symbols, cropToPage: [] } as unknown as ParsedVoice;
    const { layout, attentionBoxes } = buildPageNoteLayout([voice]);
    assert.equal(layout.length, 1);
    assert.equal(layout[0].box, null);
    assert.equal(attentionBoxes, 0);
    // The worker maps attentionBoxes === 0 to layoutSource "midi-fallback".
  });
});
