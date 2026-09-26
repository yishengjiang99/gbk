/**
 * Full-page OMR pipeline: TypeScript port of homr's main.py page flow
 * (load_and_preprocess_predictions, predict_symbols, detect_staffs_in_image)
 * and staff_parsing.py (parse_staffs, _ensure_same_number_of_staffs).
 *
 * Stage order mirrors the Python exactly:
 *   1. autocrop -> resize to 1920 wide (nearest) -> grayscale -> CLAHE
 *   2. SegNet tiled inference -> six-class label map -> binary masks
 *   3. noise filtering (image_noise_limit=50) -> make_lines_stronger on staff
 *   4. symbol boxes (noteheads, staff fragments, clefs/keys, stems/rests,
 *      bar lines) -> break_wide_fragments
 *   5. notehead+stem pairing -> bar-line filtering -> detect_staff
 *   6. brace/bracket image -> find_braces_brackets_and_grand_staff_lines
 *   7. add_notes_to_staffs
 *   8. _ensure_same_number_of_staffs -> voices -> per staff:
 *      prepare_staff_image -> transformer decode ->
 *      is_upper_or_has_no_position filter (non-grand staffs) -> newline ->
 *      remove_duplicated_symbols
 *
 * The transformer itself is injected (encoder/decoder SessionLike) so this
 * module stays headless and testable with stub sessions.
 */
import {
  GrayImage,
  clahe,
  crop,
  resize,
} from "./geometry/image.ts";
import {
  BoundingEllipse,
  RotatedBoundingBox,
  createBoundingEllipses,
  createRotatedBoundingBoxes,
} from "./geometry/boxes.ts";
import { SegNetMasks, masksFromLabels, runSegNet } from "./geometry/segnet.ts";
import {
  NoteheadWithStem,
  addNotesToStaffs,
  autocrop,
  breakWideFragments,
  combineNoteheadsWithStems,
  detectBarLines,
  detectStaff,
  filterPredictions,
  findBracesBracketsAndGrandStaffLines,
  makeLinesStronger,
  prepareBarLineImage,
  prepareBraceDotImage,
} from "./geometry/staff.ts";
import { MultiStaff, Staff, StaffRegions } from "./geometry/staff-model.ts";
import { PreparedStaffImage, prepareStaffImage } from "./geometry/dewarp.ts";
import { SessionLike, decodeStaff, encodeStaff, preprocessStaff } from "./transformer.ts";
import type { DecodedSymbol } from "./vocab.ts";
import { isUpperOrHasNoPosition, removeDuplicatedSymbols } from "./symbols.ts";

/** homr/constants.py: image_noise_limit. */
export const IMAGE_NOISE_LIMIT = 50;

export interface PageImage {
  /** Grayscale page after autocrop + 1920-wide resize. */
  image: GrayImage;
  /** CLAHE-enhanced grayscale page (SegNet + staff-crop input). */
  preprocessed: GrayImage;
}

export interface PredictedSymbols {
  noteheads: BoundingEllipse[];
  staffFragments: RotatedBoundingBox[];
  clefsKeys: RotatedBoundingBox[];
  stemsRest: RotatedBoundingBox[];
  barLines: RotatedBoundingBox[];
}

/** Decodes one 1280x256 staff crop into symbols. */
export type StaffTranscriber = (
  encoder: SessionLike,
  decoder: SessionLike,
  crop: GrayImage,
) => Promise<DecodedSymbol[]>;

export const defaultStaffTranscriber: StaffTranscriber = async (encoder, decoder, crop) => {
  const input = preprocessStaff(crop.data, crop.width, crop.height);
  const context = await encodeStaff(encoder, input);
  return decodeStaff(decoder, context);
};

function toGrayscale(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  format: "rgba" | "rgb" | "gray",
): GrayImage {
  const img = new GrayImage(width, height);
  if (format === "gray") {
    img.data.set(pixels.subarray(0, width * height));
    return img;
  }
  const step = format === "rgba" ? 4 : 3;
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * step];
    const g = pixels[i * step + 1];
    const b = pixels[i * step + 2];
    img.data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return img;
}

/**
 * Autocrop -> resize to 1920 wide (nearest, like homr's PIL resize) ->
 * grayscale -> CLAHE. Direct port of load_and_preprocess_predictions'
 * image preparation.
 */
export function preprocessPageImage(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  format: "rgba" | "rgb" | "gray" = "rgba",
): PageImage {
  let image = toGrayscale(pixels, width, height, format);
  const box = autocrop(pixels, width, height, format);
  if (box.x !== 0 || box.y !== 0 || box.width !== width || box.height !== height) {
    image = crop(image, box.x, box.y, box.width, box.height);
  }
  if (image.width !== 1920) {
    const targetH = Math.round((image.height * 1920) / image.width);
    image = resize(image, 1920, targetH, { interpolation: "nearest" });
  }
  const preprocessed = clahe(image, 1.0, 8, 8);
  return { image, preprocessed };
}

/**
 * SegNet inference + noise filtering + make_lines_stronger.
 * Mirrors load_and_preprocess_predictions minus the debug/cache handling.
 */
export async function extractPagePredictions(
  segnet: SessionLike,
  preprocessed: GrayImage,
  onProgress?: (stage: string) => void,
): Promise<SegNetMasks> {
  onProgress?.("segnet inference");
  const labels = await runSegNet(segnet, preprocessed, {
    stepSize: 320,
    onProgress: onProgress ? (done, total) => onProgress(`segnet tile ${done}/${total}`) : undefined,
  });
  const masks = masksFromLabels(labels, preprocessed.width, preprocessed.height);
  onProgress?.("filtering prediction noise");
  filterPredictions(masks, IMAGE_NOISE_LIMIT);
  masks.staff = makeLinesStronger(masks.staff, 1, 2);
  return masks;
}

/** Symbol boxes from the five masks. Direct port of predict_symbols. */
export function predictSymbols(masks: SegNetMasks): PredictedSymbols {
  const noteheads = createBoundingEllipses(masks.notehead, { minSize: [4, 4] });
  let staffFragments = createRotatedBoundingBoxes(masks.staff, {
    skipMerging: true,
    minSize: [5, 1],
    maxSize: [10000, 100],
  });
  staffFragments = breakWideFragments(staffFragments);
  const clefsKeys = createRotatedBoundingBoxes(masks.clefsKeys, {
    minSize: [20, 40],
    maxSize: [1000, 1000],
  });
  const stemsRest = createRotatedBoundingBoxes(masks.stemsRest);
  const barLineImg = prepareBarLineImage(masks.stemsRest);
  const barLines = createRotatedBoundingBoxes(barLineImg, {
    skipMerging: true,
    minSize: [1, 5],
  });
  return { noteheads, staffFragments, clefsKeys, stemsRest, barLines };
}

export interface DetectedStaffs {
  multiStaffs: MultiStaff[];
  /** Flat staff list in top-to-bottom order. */
  staffs: Staff[];
  /** Preprocessed page image the staffs were detected on. */
  image: GrayImage;
}

/**
 * Full staff detection on a page. Direct port of detect_staffs_in_image.
 * Throws when no noteheads or no staffs are found, like the Python.
 */
export function detectStaffsInImage(masks: SegNetMasks, image: GrayImage): DetectedStaffs {
  const symbols = predictSymbols(masks);
  const noteheadsWithStems = combineNoteheadsWithStems(symbols.noteheads, symbols.stemsRest);
  if (noteheadsWithStems.length === 0) throw new Error("No noteheads found");
  const allNoteheads = noteheadsWithStems.map((n) => n.notehead);
  const allStems = noteheadsWithStems.flatMap((n) => (n.stem ? [n.stem] : []));
  const heights = allNoteheads.map((n) => n.rect.h).sort((a, b) => a - b);
  const averageNoteheadHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const barLinesOrRests = symbols.barLines.filter(
    (line) => !line.isOverlappingWithAny(allNoteheads) && !line.isOverlappingWithAny(allStems),
  );
  const barLineBoxes = detectBarLines(barLinesOrRests, averageNoteheadHeight);
  const staffs = detectStaff(
    masks.staff,
    symbols.staffFragments,
    symbols.clefsKeys,
    barLineBoxes,
  );
  if (staffs.length === 0) throw new Error("No staffs found");
  const braceDotImg = prepareBraceDotImage(masks.symbols, masks.staff);
  const braceDot = createRotatedBoundingBoxes(braceDotImg, {
    skipMerging: true,
    maxSize: [100, -1],
  });
  addNotesToStaffs(staffs, noteheadsWithStems, masks.notehead);
  const multiStaffs = findBracesBracketsAndGrandStaffLines(staffs, braceDot);
  return { multiStaffs, staffs, image };
}

// ---------------------------------------------------------------------------
// System/voice normalization (homr/staff_parsing.py)
// ---------------------------------------------------------------------------

function flattenStaffs(staffs: MultiStaff[]): Staff[] {
  return staffs.flatMap((ms) => ms.staffs);
}

function regroupByPeriod(
  flatStaffs: Staff[],
  period: number,
  frontTrim: number,
  backTrim: number,
): MultiStaff[] {
  const core = flatStaffs.slice(frontTrim, flatStaffs.length - backTrim);
  const result: MultiStaff[] = [];
  for (let i = 0; i < core.length; i += period) {
    result.push(new MultiStaff(core.slice(i, i + period), []));
  }
  return result;
}

function findPeriodicCore(flatStaffs: Staff[]): [number, number, number] | null {
  const layout = flatStaffs.map((s) => s.isGrandstaff);
  const n = layout.length;
  let best: [number, number, number, number] | null = null;
  for (let period = 1; period <= Math.floor(n / 2); period++) {
    for (let frontTrim = 0; frontTrim <= period; frontTrim++) {
      for (let backTrim = 0; backTrim <= period; backTrim++) {
        const core = layout.slice(frontTrim, n - backTrim);
        if (core.length < 2 * period || core.length % period !== 0) continue;
        const rows: string[] = [];
        for (let i = 0; i < core.length; i += period) {
          rows.push(core.slice(i, i + period).join(","));
        }
        if (!rows.every((r) => r === rows[0])) continue;
        const candidate: [number, number, number, number] = [
          frontTrim + backTrim,
          period,
          frontTrim,
          backTrim,
        ];
        if (
          best === null ||
          candidate[0] < best[0] ||
          (candidate[0] === best[0] && candidate[1] < best[1])
        ) {
          best = candidate;
        }
      }
    }
  }
  if (best === null) return null;
  return [best[1], best[2], best[3]];
}

/**
 * Normalizes per-system staff counts. Direct port of
 * _ensure_same_number_of_staffs.
 */
export function ensureSameNumberOfStaffs(staffs: MultiStaff[]): MultiStaff[] {
  const rowLengths = new Set(staffs.map((ms) => ms.staffs.length));
  if (rowLengths.size === 1 && [...rowLengths][0] > 1) return staffs;
  const flatStaffs = flattenStaffs(staffs);
  const core = findPeriodicCore(flatStaffs);
  if (core !== null) {
    const [period, frontTrim, backTrim] = core;
    return regroupByPeriod(flatStaffs, period, frontTrim, backTrim);
  }
  const result: MultiStaff[] = [];
  for (const staff of staffs) result.push(...staff.breakApart());
  return result.sort((a, b) => a.staffs[0].minY - b.staffs[0].minY);
}

// ---------------------------------------------------------------------------
// Staff parsing (homr/staff_parsing.py: parse_staffs)
// ---------------------------------------------------------------------------

export interface ParsedVoice {
  /** Decoded symbols for one voice across all systems (newline-terminated per staff). */
  symbols: DecodedSymbol[];
  /** Per-staff crop->page mappings, aligned with the non-empty staffs. */
  cropToPage: Array<(x: number, y: number) => [number, number]>;
}

function newlineSymbol(): DecodedSymbol {
  return {
    rhythm: "newline",
    pitch: "nonote",
    lift: "nonote",
    articulation: "nonote",
    slur: "nonote",
    position: "nonote",
    attention: [0, 0],
  };
}

/**
 * Dewarps each staff, decodes it with the transformer, filters lower-staff
 * symbols for non-grand staffs, appends newlines and de-duplicates per
 * voice. Direct port of parse_staffs.
 */
export async function parseStaffs(
  multiStaffs: MultiStaff[],
  image: GrayImage,
  encoder: SessionLike,
  decoder: SessionLike,
  transcriber: StaffTranscriber = defaultStaffTranscriber,
  onProgress?: (stage: string) => void,
): Promise<ParsedVoice[]> {
  const systems = ensureSameNumberOfStaffs(multiStaffs);
  if (systems.length === 0) return [];
  const numberOfVoices = systems[0].staffs.length;
  const regions = new StaffRegions(systems);
  const voices: ParsedVoice[] = [];
  for (let voice = 0; voice < numberOfVoices; voice++) {
    const staffsForVoice = systems.map((ms) => ms.staffs[voice]);
    const resultForVoice: DecodedSymbol[] = [];
    const cropToPage: Array<(x: number, y: number) => [number, number]> = [];
    for (let staffIndex = 0; staffIndex < staffsForVoice.length; staffIndex++) {
      const staff = staffsForVoice[staffIndex];
      onProgress?.(`dewarping staff ${staffIndex + 1}/${staffsForVoice.length} (voice ${voice + 1})`);
      const prepared: PreparedStaffImage = prepareStaffImage(staff, image, regions);
      onProgress?.(`decoding staff ${staffIndex + 1}/${staffsForVoice.length} (voice ${voice + 1})`);
      let resultStaff = await transcriber(encoder, decoder, prepared.image);
      if (!staff.isGrandstaff) {
        resultStaff = resultStaff.filter((s) => isUpperOrHasNoPosition(s.position));
      }
      if (resultStaff.length === 0) continue;
      resultStaff.push(newlineSymbol());
      resultForVoice.push(...resultStaff);
      cropToPage.push(prepared.cropToPage);
    }
    voices.push({ symbols: removeDuplicatedSymbols(resultForVoice), cropToPage });
  }
  return voices;
}

/**
 * Splits one voice's symbols back into per-staff groups at "newline"
 * boundaries (newlines appended by parseStaffs survive
 * removeDuplicatedSymbols). The i-th group aligns with the i-th
 * cropToPage entry of the same voice.
 */
export function splitVoiceByStaff(symbols: DecodedSymbol[]): DecodedSymbol[][] {
  const groups: DecodedSymbol[][] = [];
  let current: DecodedSymbol[] = [];
  for (const s of symbols) {
    if (s.rhythm === "newline") {
      groups.push(current);
      current = [];
    } else {
      current.push(s);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * End-to-end page transcription: masks -> staffs -> voices.
 * The caller supplies SegNet masks (or use extractPagePredictions) and the
 * transformer sessions.
 */
export async function transcribePage(
  masks: SegNetMasks,
  image: GrayImage,
  encoder: SessionLike,
  decoder: SessionLike,
  transcriber: StaffTranscriber = defaultStaffTranscriber,
  onProgress?: (stage: string) => void,
): Promise<{ voices: ParsedVoice[]; staffCount: number; multiStaffs: MultiStaff[] }> {
  onProgress?.("detecting staffs");
  const { multiStaffs, staffs } = detectStaffsInImage(masks, image);
  onProgress?.(`parsing ${staffs.length} staffs`);
  const voices = await parseStaffs(multiStaffs, image, encoder, decoder, transcriber, onProgress);
  return { voices, staffCount: staffs.length, multiStaffs };
}
