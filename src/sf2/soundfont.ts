// SoundFont 2.01 parser, validator and region builder. Mirrors sf2player-swift
// Sources/SF2Engine/SF2SoundFont.swift + SF2Validation.swift (the `.spec` path; there is no
// legacy mode). Strict loads throw the first section 10.1 violation; lenient loads keep it in
// `warnings` (and still throw for files that cannot be played at all).
import { Gen, genInfo, genDefaultValue, clampGen } from "./geninfo.ts";
import {
  type SF2Modulator, type SF2SpecVersion, sameIdentity, mergeModulators,
} from "./modulator.ts";

export type SF2Info = Record<string, string>;

export interface SF2SampleHeader {
  sampleName: string; start: number; end: number; startLoop: number; endLoop: number;
  sampleRate: number; originalPitch: number; pitchCorrection: number; sampleLink: number; sampleType: number;
}
export interface SF2PresetHeader {
  presetName: string; preset: number; bank: number; presetBagNdx: number; library: number; genre: number; morphology: number;
}
export interface SF2InstrumentHeader { instName: string; instBagNdx: number }
export interface SF2Bag { genNdx: number; modNdx: number }
export interface SF2GenRecord { oper: number; amount: number }
export interface SF2ModRecord { srcOper: number; destOper: number; amount: number; amtSrcOper: number; transOper: number }

export interface SF2VolEnv { delayTc: number; attackTc: number; holdTc: number; decayTc: number; sustainCb: number; releaseTc: number }
export interface SF2ModEnv { delayTc: number; attackTc: number; holdTc: number; decayTc: number; sustain: number; releaseTc: number }

export interface SF2SampleData {
  dataL: Float32Array;
  dataR: Float32Array | null;
  sampleRate: number;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
}

export interface SF2Region {
  keyRange: [number, number];
  velRange: [number, number];
  sample: SF2SampleData;
  sampleModes: number;
  originalKey: number;
  overridingRootKey: number | null;
  coarseTune: number;
  fineTune: number;
  scaleTuning: number;
  initialAttenuationCb: number;
  pan: number;
  volEnv: SF2VolEnv;
  modEnv: SF2ModEnv;
  initialFilterFcCents: number;
  initialFilterQCb: number;
  modEnvToFilterFcCents: number;
  modLfoToFilterFcCents: number;
  modLfoDelayTc: number;
  modLfoFreqCents: number;
  modLfoToPitchCents: number;
  vibLfoDelayTc: number;
  vibLfoFreqCents: number;
  vibLfoToPitchCents: number;
  exclusiveClass: number;
  modEnvToPitchCents?: number;
  modLfoToVolumeCb?: number;
  keynumToVolEnvHold?: number;
  keynumToVolEnvDecay?: number;
  keynumToModEnvHold?: number;
  keynumToModEnvDecay?: number;
  /** G-02 substitution generators keynum (#46) / velocity (#47); null = use the MIDI value. */
  keynumOverride?: number | null;
  velocityOverride?: number | null;
  /** G-11: chorusEffectsSend (#15) / reverbEffectsSend (#16) in 0.1 % units. */
  chorusSend?: number;
  reverbSend?: number;
  /** Final modulator list (defaults + instrument + preset, 9.5); absent = engine defaults (2.04 set). */
  modulators?: SF2Modulator[] | null;
}

export type SF2StructuralError =
  | { rule: "riffSize"; declared: number; actual: number }
  | { rule: "truncatedChunk"; chunk: string }
  | { rule: "chunkOrder"; chunk: string }
  | { rule: "unknownChunk"; chunk: string; in: string }
  | { rule: "missingChunk"; chunk: string }
  | { rule: "chunkSize"; chunk: string; size: number }
  | { rule: "unsupportedVersion"; major: number; minor: number }
  | { rule: "oddSampleByteCount"; size: number }
  | { rule: "recordSize"; chunk: string; size: number }
  | { rule: "tooFewRecords"; chunk: string; count: number }
  | { rule: "bagIndexNotMonotonic"; chunk: string; index: number }
  | { rule: "indexCountMismatch"; chunk: string; expected: number; actual: number }
  | { rule: "instrumentOutOfRange"; genIndex: number; value: number }
  | { rule: "sampleOutOfRange"; genIndex: number; value: number }
  | { rule: "samplePointsOutOfRange"; sample: number }
  | { rule: "romSampleWithoutIROM"; sample: number };

export function describeStructural(e: SF2StructuralError): string {
  const { rule, ...rest } = e as { rule: string } & Record<string, unknown>;
  return `${rule}(${Object.entries(rest).map(([k, v]) => `${k}: ${v}`).join(", ")})`;
}

export type SF2ErrorKind =
  | "notRIFF" | "notSoundFont" | "truncated" | "missingTable" | "missingSampleData"
  | "presetIndexOutOfRange" | "instrumentIndexOutOfRange" | "structural";

export class SF2Error extends Error {
  kind: SF2ErrorKind;
  detail?: string | number;
  structural?: SF2StructuralError;
  constructor(kind: SF2ErrorKind, detail?: string | number, structural?: SF2StructuralError) {
    super(structural ? `SF2 structural error: ${describeStructural(structural)}` : `SF2 error: ${kind}${detail !== undefined ? ` (${detail})` : ""}`);
    this.kind = kind; this.detail = detail; this.structural = structural;
  }
}

export interface SF2LoadOptions { mode: "strict" | "lenient" }
export const STRICT: SF2LoadOptions = { mode: "strict" };
export const LENIENT: SF2LoadOptions = { mode: "lenient" };

export function specVersionString(v: SF2SpecVersion): string {
  return `${v.major}.${String(v.minor).padStart(2, "0")}`;
}

// ── byte reader ──────────────────────────────────────────────────────────────

class ByteReader {
  pos = 0;
  constructor(readonly raw: Uint8Array) {}
  get eof(): boolean { return this.pos >= this.raw.length; }
  need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.raw.length) throw new SF2Error("truncated", what);
  }
  u8(): number { this.need(1, "u8"); return this.raw[this.pos++]; }
  u16(): number { this.need(2, "u16"); const v = this.raw[this.pos] | (this.raw[this.pos + 1] << 8); this.pos += 2; return v; }
  u32(): number {
    this.need(4, "u32");
    const r = this.raw, p = this.pos;
    this.pos += 4;
    return (r[p] | (r[p + 1] << 8) | (r[p + 2] << 16)) + r[p + 3] * 0x1000000;
  }
  fourCC(): string { this.need(4, "fourCC"); const s = latin1(this.raw.subarray(this.pos, this.pos + 4)); this.pos += 4; return s; }
  bytes(n: number): Uint8Array {
    const e = Math.min(this.raw.length, this.pos + Math.max(0, n));
    const b = this.raw.subarray(this.pos, e);
    this.pos = e;
    return b;
  }
  zstr(maxBytes: number): string {
    this.need(maxBytes, "zstr");
    let e = this.pos;
    while (e < this.pos + maxBytes && this.raw[e] !== 0) e++;
    const s = latin1(this.raw.subarray(this.pos, e));
    this.pos += maxBytes;
    return s;
  }
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
function align2(p: number): number { return (p + 1) & ~1; }
const i16 = (u: number) => (u << 16) >> 16;
const i8 = (u: number) => (u << 24) >> 24;

// ── INFO rules (section 5) ───────────────────────────────────────────────────

const STRING_IDS = new Set(["INAM", "isng", "irom", "ICRD", "IENG", "IPRD", "ICOP", "ICMT", "ISFT"]);

/** Latin-1 decode up to the first NUL; null if unterminated, odd-length or too long (5.2 to 5.11). */
export function infoZString(b: Uint8Array, maxBytes: number): string | null {
  if (b.length % 2 !== 0 || b.length > maxBytes) return null;
  const z = b.indexOf(0);
  if (z < 0) return null;
  return latin1(b.subarray(0, z));
}

function parseInfo(chunks: [string, Uint8Array][]): { info: SF2Info; version: SF2SpecVersion | null; issues: SF2StructuralError[] } {
  const info: SF2Info = {};
  let version: SF2SpecVersion | null = null;
  const issues: SF2StructuralError[] = [];
  let sawIfil = false;
  for (const [id, b] of chunks) {
    if (id === "ifil") {
      sawIfil = true;
      if (b.length !== 4) { issues.push({ rule: "chunkSize", chunk: "ifil", size: b.length }); continue; }
      const v = { major: b[0] | (b[1] << 8), minor: b[2] | (b[3] << 8) };
      if (v.major !== 2) issues.push({ rule: "unsupportedVersion", major: v.major, minor: v.minor });
      version = v;
      info.ifil = `${v.major}.${v.minor}`;
    } else if (id === "iver") {
      if (b.length === 4) info.iver = `${b[0] | (b[1] << 8)}.${b[2] | (b[3] << 8)}`;
    } else if (STRING_IDS.has(id)) {
      const s = infoZString(b, id === "ICMT" ? 65536 : 256);
      if (s !== null) info[id] = s;
    }
  }
  if (!sawIfil) issues.unshift({ rule: "missingChunk", chunk: "ifil" });
  if (info.isng !== "EMU8000") info.isng = "EMU8000";
  return { info, version, issues };
}

const PDTA_ORDER = ["phdr", "pbag", "pmod", "pgen", "inst", "ibag", "imod", "igen", "shdr"];
const RECORD_SIZES: Record<string, number> = { phdr: 38, pbag: 4, pmod: 10, pgen: 4, inst: 22, ibag: 4, imod: 10, igen: 4, shdr: 46 };

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function validate(topOrder: string[], order: string[], t: Tables, sampleCount: number, hasIROM: boolean): SF2StructuralError[] {
  const e: SF2StructuralError[] = [];
  const known: string[] = topOrder.filter((x) => x === "INFO" || x === "sdta" || x === "pdta");
  for (const need of ["INFO", "sdta", "pdta"] as string[]) if (!known.includes(need)) e.push({ rule: "missingChunk", chunk: need });
  if (!sameArray(known, ["INFO", "sdta", "pdta"]) && new Set(known).size === 3) e.push({ rule: "chunkOrder", chunk: "RIFF" });
  for (const need of PDTA_ORDER) if (!order.includes(need)) e.push({ rule: "missingChunk", chunk: need });
  const pk = order.filter((x) => PDTA_ORDER.includes(x));
  if (!sameArray(pk, PDTA_ORDER) && new Set(pk).size === PDTA_ORDER.length) e.push({ rule: "chunkOrder", chunk: "pdta" });
  if (t.phdr.length < 2) e.push({ rule: "tooFewRecords", chunk: "phdr", count: t.phdr.length });
  if (t.inst.length < 2) e.push({ rule: "tooFewRecords", chunk: "inst", count: t.inst.length });
  if (t.shdr.length < 1) e.push({ rule: "tooFewRecords", chunk: "shdr", count: t.shdr.length });
  const checkLevel = (hdrName: string, bagNdx: number[], bagName: string, bags: SF2Bag[], genName: string, gens: number, modName: string, mods: number) => {
    for (let i = 1; i < bagNdx.length; i++) if (bagNdx[i] < bagNdx[i - 1]) e.push({ rule: "bagIndexNotMonotonic", chunk: hdrName, index: i });
    if (bagNdx.length > 0 && bags.length !== bagNdx[bagNdx.length - 1] + 1) {
      e.push({ rule: "indexCountMismatch", chunk: bagName, expected: bagNdx[bagNdx.length - 1] + 1, actual: bags.length });
    }
    for (let i = 1; i < bags.length; i++) {
      if (bags[i].genNdx < bags[i - 1].genNdx) e.push({ rule: "bagIndexNotMonotonic", chunk: genName, index: i });
      if (bags[i].modNdx < bags[i - 1].modNdx) e.push({ rule: "bagIndexNotMonotonic", chunk: modName, index: i });
    }
    if (bags.length > 0) {
      const last = bags[bags.length - 1];
      if (gens !== last.genNdx + 1) e.push({ rule: "indexCountMismatch", chunk: genName, expected: last.genNdx + 1, actual: gens });
      if (mods !== last.modNdx + 1) e.push({ rule: "indexCountMismatch", chunk: modName, expected: last.modNdx + 1, actual: mods });
    }
  };
  if (order.includes("phdr") && order.includes("pbag")) {
    checkLevel("phdr", t.phdr.map((h) => h.presetBagNdx), "pbag", t.pbag, "pgen", t.pgen.length, "pmod", t.pmod.length);
  }
  if (order.includes("inst") && order.includes("ibag")) {
    checkLevel("inst", t.inst.map((h) => h.instBagNdx), "ibag", t.ibag, "igen", t.igen.length, "imod", t.imod.length);
  }
  t.pgen.forEach((g, i) => {
    if (g.oper !== Gen.instrument) return;
    const v = g.amount & 0xffff;
    if (v >= t.inst.length - 1) e.push({ rule: "instrumentOutOfRange", genIndex: i, value: v });
  });
  t.igen.forEach((g, i) => {
    if (g.oper !== Gen.sampleID) return;
    const v = g.amount & 0xffff;
    if (v >= t.shdr.length - 1) e.push({ rule: "sampleOutOfRange", genIndex: i, value: v });
  });
  t.shdr.slice(0, -1).forEach((s, i) => {
    if (s.sampleType & 0x8000) {
      if (!hasIROM) e.push({ rule: "romSampleWithoutIROM", sample: i });
      return;
    }
    const pts = [s.start, s.end, s.startLoop, s.endLoop];
    if (s.end <= s.start || pts.some((p) => p > sampleCount)) e.push({ rule: "samplePointsOutOfRange", sample: i });
  });
  return e;
}

interface Tables {
  phdr: SF2PresetHeader[]; pbag: SF2Bag[]; pmod: SF2ModRecord[]; pgen: SF2GenRecord[];
  inst: SF2InstrumentHeader[]; ibag: SF2Bag[]; imod: SF2ModRecord[]; igen: SF2GenRecord[]; shdr: SF2SampleHeader[];
}

type GenMap = Map<number, number>;
interface SpecZone { gens: GenMap; mods: SF2Modulator[] }
interface SpecObject { global: SpecZone | null; locals: SpecZone[] }

function modFromRecord(r: SF2ModRecord): SF2Modulator {
  return { src: r.srcOper & 0xffff, dest: r.destOper & 0xffff, amount: i16(r.amount & 0xffff), amtSrc: r.amtSrcOper & 0xffff, transform: r.transOper & 0xffff };
}

/** Section 9.4 range intersection on packed lo | hi << 8 words; null when empty. */
export function intersectRange(a: number | undefined, b: number | undefined): number | undefined | null {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const lo = Math.max(a & 0xff, b & 0xff), hi = Math.min((a >> 8) & 0xff, (b >> 8) & 0xff);
  return lo > hi ? null : (lo | (hi << 8));
}

/** A parsed SoundFont 2 bank. */
export class SF2SoundFont {
  info: SF2Info;
  /** smpl: all 16-bit PCM samples. */
  samples: Int16Array;
  sm24: Uint8Array | null;
  riffSize: number;
  /** ifil (null when absent or malformed; lenient loads only). */
  version: SF2SpecVersion | null;
  /** Version used for version-aware rules (`version`, else 2.01). */
  specVersion: SF2SpecVersion;
  warnings: SF2StructuralError[];
  loadOptions: SF2LoadOptions;
  phdr: SF2PresetHeader[]; pbag: SF2Bag[]; pmod: SF2ModRecord[]; pgen: SF2GenRecord[];
  inst: SF2InstrumentHeader[]; ibag: SF2Bag[]; imod: SF2ModRecord[]; igen: SF2GenRecord[]; shdr: SF2SampleHeader[];
  private sampleCache = new Map<string, Float32Array>();
  private regionCache = new Map<number, SF2Region[]>();

  constructor(data: Uint8Array, options: SF2LoadOptions = LENIENT) {
    const strict = options.mode === "strict";
    const info: SF2Info = {};
    const rawInfo: [string, Uint8Array][] = [];
    let smpl: Int16Array | null = null;
    let sm24: Uint8Array | null = null;
    const t: Tables = { phdr: [], pbag: [], pmod: [], pgen: [], inst: [], ibag: [], imod: [], igen: [], shdr: [] };
    let riffSize = 0;
    const issues: SF2StructuralError[] = [];
    const topOrder: string[] = [], pdtaOrder: string[] = [];
    const n8 = data.length;
    try {
      const r = new ByteReader(data);
      if (r.fourCC() !== "RIFF") throw new SF2Error("notRIFF");
      riffSize = r.u32();
      if (r.fourCC() !== "sfbk") throw new SF2Error("notSoundFont");
      if (!(riffSize + 8 === n8 || (riffSize % 2 === 1 && riffSize + 9 === n8))) {
        issues.push({ rule: "riffSize", declared: riffSize, actual: n8 - 8 });
      }
      while (!r.eof) {
        const id = r.fourCC();
        const size = r.u32();
        const chunkStart = r.pos;
        if (chunkStart + size > n8) issues.push({ rule: "truncatedChunk", chunk: id });
        if (id === "LIST") {
          const listType = r.fourCC();
          topOrder.push(listType);
          const listEnd = Math.min(chunkStart + size, n8);
          if (listType === "INFO") {
            while (r.pos < listEnd) {
              const sid = r.fourCC();
              const ssize = r.u32();
              const start = r.pos;
              if (start + ssize > listEnd) issues.push({ rule: "truncatedChunk", chunk: sid });
              const bytes = r.bytes(ssize);
              rawInfo.push([sid, bytes]);
              let s = new TextDecoder("utf-8").decode(bytes);
              if (s.includes("\uFFFD")) s = latin1(bytes);
              s = s.replace(/\0+$/, "");
              info[sid] = s;
              r.pos = align2(start + ssize);
            }
          } else if (listType === "sdta") {
            while (r.pos < listEnd) {
              const sid = r.fourCC();
              const ssize = r.u32();
              const start = r.pos;
              if (start + ssize > listEnd) issues.push({ rule: "truncatedChunk", chunk: sid });
              if (sid === "smpl") {
                if (ssize % 2 !== 0) issues.push({ rule: "oddSampleByteCount", size: ssize });
                const n = Math.floor(ssize / 2);
                r.need(n * 2, "smpl");
                const out = new Int16Array(n);
                const dv = new DataView(data.buffer, data.byteOffset + start, n * 2);
                for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
                smpl = out;
              } else if (sid === "sm24") {
                sm24 = r.bytes(ssize).slice();
              } else {
                issues.push({ rule: "unknownChunk", chunk: sid, in: "sdta" });
              }
              r.pos = align2(start + ssize);
            }
          } else if (listType === "pdta") {
            while (r.pos < listEnd) {
              const sid = r.fourCC();
              const ssize = r.u32();
              const start = r.pos;
              pdtaOrder.push(sid);
              if (start + ssize > listEnd) issues.push({ rule: "truncatedChunk", chunk: sid });
              r.need(ssize, sid);
              const rec = RECORD_SIZES[sid];
              if (rec !== undefined && ssize % rec !== 0) issues.push({ rule: "recordSize", chunk: sid, size: ssize });
              const count = (k: number) => Math.floor(ssize / k);
              switch (sid) {
                case "phdr":
                  t.phdr = Array.from({ length: count(38) }, () => ({
                    presetName: r.zstr(20), preset: r.u16(), bank: r.u16(), presetBagNdx: r.u16(),
                    library: r.u32(), genre: r.u32(), morphology: r.u32(),
                  }));
                  break;
                case "pbag": t.pbag = readBags(r, ssize); break;
                case "ibag": t.ibag = readBags(r, ssize); break;
                case "pmod": t.pmod = readMods(r, ssize); break;
                case "imod": t.imod = readMods(r, ssize); break;
                case "pgen": t.pgen = readGens(r, ssize); break;
                case "igen": t.igen = readGens(r, ssize); break;
                case "inst":
                  t.inst = Array.from({ length: count(22) }, () => ({ instName: r.zstr(20), instBagNdx: r.u16() }));
                  break;
                case "shdr":
                  t.shdr = Array.from({ length: count(46) }, () => ({
                    sampleName: r.zstr(20), start: r.u32(), end: r.u32(), startLoop: r.u32(), endLoop: r.u32(),
                    sampleRate: r.u32(), originalPitch: r.u8(), pitchCorrection: i8(r.u8()), sampleLink: r.u16(), sampleType: r.u16(),
                  }));
                  break;
                default: issues.push({ rule: "unknownChunk", chunk: sid, in: "pdta" });
              }
              r.pos = align2(start + ssize);
            }
          } else {
            issues.push({ rule: "unknownChunk", chunk: listType, in: "RIFF" });
            r.pos = listEnd;
          }
          r.pos = align2(r.pos);
        } else {
          topOrder.push(id);
          issues.push({ rule: "unknownChunk", chunk: id, in: "RIFF" });
          r.pos = align2(chunkStart + size);
        }
      }
    } catch (err) {
      if (strict && err instanceof SF2Error && err.kind === "truncated") {
        throw new SF2Error("structural", undefined, { rule: "truncatedChunk", chunk: String(err.detail) });
      }
      throw err;
    }
    const infoResult = parseInfo(rawInfo);
    issues.push(...infoResult.issues);
    issues.push(...validate(topOrder, pdtaOrder, t, (smpl as Int16Array | null)?.length ?? 0, infoResult.info.irom !== undefined));
    if (strict && issues.length > 0) throw new SF2Error("structural", undefined, issues[0]);
    if (!strict) {
      const tables: [string, number][] = [["phdr", t.phdr.length], ["pbag", t.pbag.length], ["pgen", t.pgen.length],
        ["inst", t.inst.length], ["ibag", t.ibag.length], ["igen", t.igen.length], ["shdr", t.shdr.length]];
      for (const [name, c] of tables) if (c === 0) throw new SF2Error("missingTable", name);
    }
    this.info = strict ? infoResult.info : info;
    this.version = infoResult.version;
    this.specVersion = infoResult.version ?? { major: 2, minor: 1 };
    this.warnings = issues;
    this.loadOptions = options;
    this.samples = smpl ?? new Int16Array(0);
    this.sm24 = sm24;
    this.riffSize = riffSize;
    this.phdr = t.phdr; this.pbag = t.pbag; this.pmod = t.pmod; this.pgen = t.pgen;
    this.inst = t.inst; this.ibag = t.ibag; this.imod = t.imod; this.igen = t.igen; this.shdr = t.shdr;
    if (smpl === null && !strict) throw new SF2Error("missingSampleData");
  }

  /** Presets without the terminal EOP record. Index == preset index. */
  get presets(): SF2PresetHeader[] { return this.phdr.slice(0, -1); }

  /** Exact (program, bank), then bank 0, then any bank (fallbacks are engine policy). Z-12. */
  resolvePresetIndex(program: number, bank: number): number | null {
    const p = this.presets;
    const ok = (h: SF2PresetHeader) => h.preset <= 127 && h.bank <= 128;
    let i = p.findIndex((h) => ok(h) && h.preset === program && h.bank === bank);
    if (i >= 0) return i;
    i = p.findIndex((h) => ok(h) && h.preset === program && h.bank === 0);
    if (i >= 0) return i;
    i = p.findIndex((h) => ok(h) && h.preset === program);
    return i >= 0 ? i : null;
  }

  isPlayable(index: number): boolean {
    if (!(index >= 0 && index < this.phdr.length - 1)) return false;
    return this.phdr[index].preset <= 127 && this.phdr[index].bank <= 128;
  }

  /** Cached SoundFont 2.01 regions of a preset. */
  regionList(index: number): SF2Region[] {
    const hit = this.regionCache.get(index);
    if (hit) return hit;
    const list = this.buildRegionsForPreset(index);
    this.regionCache.set(index, list);
    return list;
  }

  /** Section 7.3/7.5/7.7/7.9 zone rules (Z-01 ... Z-08). */
  specObject(bags: SF2Bag[], gens: SF2GenRecord[], mods: SF2ModRecord[], from: number, to: number, preset: boolean): SpecObject {
    const terminal = preset ? Gen.instrument : Gen.sampleID;
    const illegal = preset ? Gen.sampleID : Gen.instrument;
    const raw: [SpecZone, boolean][] = [];
    for (let bi = Math.max(0, from); bi < Math.min(to, bags.length); bi++) {
      const gs = Math.min(bags[bi].genNdx, gens.length);
      const ge = Math.max(gs, Math.min(bi + 1 < bags.length ? bags[bi + 1].genNdx : gens.length, gens.length));
      const z: GenMap = new Map();
      let terminated = false;
      for (let gi = gs; gi < ge; gi++) {
        const rec = gens[gi], op = rec.oper, idx = gi - gs;
        const info = genInfo(op);
        if (!info || op === illegal) continue;
        if (preset && info.instrumentOnly) continue;
        if (op === Gen.keyRange && idx !== 0) continue;
        if (op === Gen.velRange && !(idx === 0 || (idx === 1 && gens[gs].oper === Gen.keyRange))) continue;
        const unsigned = info.kind === "index" || info.kind === "range";
        z.set(op, unsigned ? rec.amount & 0xffff : rec.amount);
        if (op === terminal) { terminated = true; break; }
      }
      const ms = Math.min(bags[bi].modNdx, mods.length);
      const me = Math.max(ms, Math.min(bi + 1 < bags.length ? bags[bi + 1].modNdx : mods.length, mods.length));
      const zm: SF2Modulator[] = [];
      for (let mi = ms; mi < me; mi++) {
        const m = modFromRecord(mods[mi]);
        const i = zm.findIndex((o) => sameIdentity(o, m));
        if (i >= 0) zm[i] = m; else zm.push(m);
      }
      raw.push([{ gens: z, mods: zm }, terminated]);
    }
    const obj: SpecObject = { global: null, locals: [] };
    raw.forEach(([z, terminated], i) => {
      if (terminated) obj.locals.push(z);
      else if (i === 0 && raw.length > 1 && !(z.gens.size === 0 && z.mods.length === 0)) obj.global = z;
    });
    return obj;
  }

  /** Fully merged zones of a preset: generators (9.4, clamped per 10.5) and modulators (9.5). */
  specMergedZones(presetIndex: number): SpecZone[] {
    const last = this.phdr.length - 1;
    if (!(presetIndex >= 0 && presetIndex < last)) throw new SF2Error("presetIndexOutOfRange", presetIndex);
    const p = this.specObject(this.pbag, this.pgen, this.pmod, this.phdr[presetIndex].presetBagNdx,
      this.phdr[presetIndex + 1].presetBagNdx, true);
    const out: SpecZone[] = [];
    for (const pz of p.locals) {
      const instIndex = pz.gens.get(Gen.instrument);
      if (instIndex === undefined) continue;
      if (!(instIndex >= 0 && instIndex < this.inst.length - 1)) throw new SF2Error("instrumentIndexOutOfRange", instIndex);
      const pg: GenMap = new Map(p.global?.gens ?? []);
      for (const [k, v] of pz.gens) pg.set(k, v);
      pg.delete(Gen.instrument);
      const io = this.specObject(this.ibag, this.igen, this.imod, this.inst[instIndex].instBagNdx,
        this.inst[instIndex + 1].instBagNdx, false);
      const batch: SpecZone[] = [];
      for (const iz of io.locals) {
        const g: GenMap = new Map(io.global?.gens ?? []);
        for (const [k, v] of iz.gens) g.set(k, v);
        let empty = false;
        for (const [k, v] of pg) {
          if (k === Gen.keyRange || k === Gen.velRange) {
            const r = intersectRange(g.get(k), v);
            if (r === null || r === undefined) empty = true; else g.set(k, r);
          } else {
            g.set(k, (g.has(k) ? g.get(k)! : genDefaultValue(k)) + v);
          }
        }
        if (empty) continue;
        for (const [k, v] of g) g.set(k, clampGen(k, v));
        const mods = mergeModulators(io.global?.mods ?? [], iz.mods, p.global?.mods ?? [], pz.mods, this.specVersion);
        batch.push({ gens: g, mods });
      }
      out.push(...this.linkStereoPitch(batch));
    }
    return out;
  }

  /** S-10 (7.10): valid stereo pairs play as two voices with the right zone's pitch. */
  linkStereoPitch(zones: SpecZone[]): SpecZone[] {
    const out = zones.map((z) => ({ gens: new Map(z.gens), mods: z.mods }));
    const n = this.shdr.length - 1;
    for (let i = 0; i < out.length; i++) {
      const sid = out[i].gens.get(Gen.sampleID);
      if (sid === undefined || !(sid >= 0 && sid < n)) continue;
      const l = this.shdr[sid];
      if (!((l.sampleType & 0x7fff) === 4 && l.sampleLink >= 0 && l.sampleLink < n)) continue;
      const r = this.shdr[l.sampleLink];
      if (!((r.sampleType & 0x7fff) === 2 && r.sampleLink === sid && r.sampleRate === l.sampleRate)) continue;
      const j = zones.findIndex((z) => z.gens.get(Gen.sampleID) === l.sampleLink
        && intersectRange(z.gens.get(Gen.keyRange) ?? 0x7f00, out[i].gens.get(Gen.keyRange) ?? 0x7f00) !== null
        && intersectRange(z.gens.get(Gen.velRange) ?? 0x7f00, out[i].gens.get(Gen.velRange) ?? 0x7f00) !== null);
      if (j < 0) continue;
      const rz = zones[j].gens;
      for (const k of [Gen.coarseTune, Gen.scaleTuning]) {
        if (rz.has(k)) out[i].gens.set(k, rz.get(k)!); else out[i].gens.delete(k);
      }
      const ork = rz.get(Gen.overridingRootKey);
      const rRoot = ork !== undefined && ork >= 0 && ork <= 127 ? ork : (r.originalPitch > 127 ? 60 : r.originalPitch);
      out[i].gens.set(Gen.overridingRootKey, rRoot);
      out[i].gens.set(Gen.fineTune, (rz.get(Gen.fineTune) ?? 0) + r.pitchCorrection - l.pitchCorrection);
    }
    return out;
  }

  /** Merged generator maps of a preset (one per sounding zone), for inspection and tests. */
  specMergedGenerators(presetIndex: number): Map<number, number>[] {
    return this.specMergedZones(presetIndex).map((z) => z.gens);
  }

  /** SoundFont 2.01 regions of a preset (9.4 / 9.5). */
  buildRegionsForPreset(presetIndex: number): SF2Region[] {
    const regions: SF2Region[] = [];
    for (const z of this.specMergedZones(presetIndex)) {
      const region = this.makeRegion(z.gens);
      if (!region) continue;
      region.modulators = z.mods;
      regions.push(region);
    }
    return regions;
  }

  private makeRegion(g: GenMap): SF2Region | null {
    const sampleID = g.get(Gen.sampleID);
    if (sampleID === undefined || !(sampleID >= 0 && sampleID < this.shdr.length)) return null;
    // P-12/P-13: the terminal EOS never plays. P-06: ROM samples never sound.
    if (sampleID >= this.shdr.length - 1 || (this.shdr[sampleID].sampleType & 0x8000) !== 0) return null;
    const sh = this.shdr[sampleID];
    const n = this.samples.length;
    const off = (fine: number, coarse: number) => (g.get(fine) ?? 0) + (g.get(coarse) ?? 0) * 32768;
    // S-02: header points must lie in smpl with end > start.
    if (!(sh.start >= 0 && sh.end <= n && sh.end > sh.start)) return null;
    // S-03: signed offsets clamped into this sample's own range keeping start < end.
    const lo = sh.start, hi = sh.end;
    const start = Math.max(lo, Math.min(hi - 1, sh.start + off(Gen.startAddrsOffset, Gen.startAddrsCoarseOffset)));
    const end = Math.max(start + 1, Math.min(hi, sh.end + off(Gen.endAddrsOffset, Gen.endAddrsCoarseOffset)));
    const loopStart = Math.max(lo, Math.min(hi, sh.startLoop + off(Gen.startloopAddrsOffset, Gen.startloopAddrsCoarseOffset)));
    const loopEnd = Math.max(lo, Math.min(hi, sh.endLoop + off(Gen.endloopAddrsOffset, Gen.endloopAddrsCoarseOffset)));
    if (end <= start) return null;
    const dataL = this.sampleBuffer(start, end);
    const range = (raw: number | undefined): [number, number] => {
      if (raw === undefined) return [0, 127];
      const u = raw & 0xffff;
      return [u & 0xff, (u >> 8) & 0xff];
    };
    const len = dataL.length;
    const ork = g.get(Gen.overridingRootKey);
    const kn = g.get(Gen.keynum), vel = g.get(Gen.velocity);
    const region: SF2Region = {
      keyRange: range(g.get(Gen.keyRange)),
      velRange: range(g.get(Gen.velRange)),
      // S-01: raw levels (value / 32768). S-04: zero rate -> 400 Hz.
      sample: {
        dataL, dataR: null, sampleRate: sh.sampleRate <= 0 ? 400 : sh.sampleRate, start: 0, end: len,
        loopStart: Math.max(0, Math.min(loopStart - start, len)), loopEnd: Math.max(0, Math.min(loopEnd - start, len)),
      },
      // S-08: low two bits only.
      sampleModes: (g.get(Gen.sampleModes) ?? 0) & 3,
      // S-05 / S-06.
      originalKey: sh.originalPitch > 127 ? 60 : sh.originalPitch,
      overridingRootKey: ork !== undefined && ork >= 0 && ork <= 127 ? ork : null,
      coarseTune: g.get(Gen.coarseTune) ?? 0,
      fineTune: (g.get(Gen.fineTune) ?? 0) + sh.pitchCorrection,
      scaleTuning: g.get(Gen.scaleTuning) ?? 100,
      initialAttenuationCb: g.get(Gen.initialAttenuation) ?? 0,
      pan: g.get(Gen.pan) ?? 0,
      volEnv: {
        delayTc: g.get(Gen.delayVolEnv) ?? -12000, attackTc: g.get(Gen.attackVolEnv) ?? -12000,
        holdTc: g.get(Gen.holdVolEnv) ?? -12000, decayTc: g.get(Gen.decayVolEnv) ?? -12000,
        sustainCb: g.get(Gen.sustainVolEnv) ?? 0, releaseTc: g.get(Gen.releaseVolEnv) ?? -12000,
      },
      modEnv: {
        delayTc: g.get(Gen.delayModEnv) ?? -12000, attackTc: g.get(Gen.attackModEnv) ?? -12000,
        holdTc: g.get(Gen.holdModEnv) ?? -12000, decayTc: g.get(Gen.decayModEnv) ?? -12000,
        sustain: Math.min(1, Math.max(0, 1 - (g.get(Gen.sustainModEnv) ?? 0) / 1000)),
        releaseTc: g.get(Gen.releaseModEnv) ?? -12000,
      },
      initialFilterFcCents: Math.max(1500, Math.min(13500, g.get(Gen.initialFilterFc) ?? 13500)),
      initialFilterQCb: Math.max(0, Math.min(960, g.get(Gen.initialFilterQ) ?? 0)),
      modEnvToFilterFcCents: g.get(Gen.modEnvToFilterFc) ?? 0,
      modLfoToFilterFcCents: g.get(Gen.modLfoToFilterFc) ?? 0,
      modLfoDelayTc: g.get(Gen.delayModLFO) ?? -12000,
      modLfoFreqCents: g.get(Gen.freqModLFO) ?? 0,
      modLfoToPitchCents: g.get(Gen.modLfoToPitch) ?? 0,
      vibLfoDelayTc: g.get(Gen.delayVibLFO) ?? -12000,
      vibLfoFreqCents: g.get(Gen.freqVibLFO) ?? 0,
      vibLfoToPitchCents: g.get(Gen.vibLfoToPitch) ?? 0,
      exclusiveClass: g.get(Gen.exclusiveClass) ?? 0,
      modEnvToPitchCents: g.get(Gen.modEnvToPitch) ?? 0,
      modLfoToVolumeCb: g.get(Gen.modLfoToVolume) ?? 0,
      keynumToVolEnvHold: g.get(Gen.keynumToVolEnvHold) ?? 0,
      keynumToVolEnvDecay: g.get(Gen.keynumToVolEnvDecay) ?? 0,
      keynumToModEnvHold: g.get(Gen.keynumToModEnvHold) ?? 0,
      keynumToModEnvDecay: g.get(Gen.keynumToModEnvDecay) ?? 0,
      chorusSend: Math.max(0, Math.min(1000, g.get(Gen.chorusEffectsSend) ?? 0)),
      reverbSend: Math.max(0, Math.min(1000, g.get(Gen.reverbEffectsSend) ?? 0)),
      keynumOverride: kn !== undefined && kn >= 0 && kn <= 127 ? kn : null,
      velocityOverride: vel !== undefined && vel >= 0 && vel <= 127 ? vel : null,
    };
    // S-09: a loop needs loopEnd - loopStart >= 2 inside the sample, else the zone plays unlooped.
    if (!(region.sample.loopEnd > region.sample.loopStart + 1)) {
      region.sampleModes = 0;
      region.sample.loopStart = 0;
      region.sample.loopEnd = region.sample.end;
    }
    return region;
  }

  /** Raw int16 / 32768 (S-01), cached per range. */
  private sampleBuffer(start: number, end: number): Float32Array {
    const key = `${start}:${end}`;
    const hit = this.sampleCache.get(key);
    if (hit) return hit;
    const n = end - start;
    const buf = new Float32Array(Math.max(0, n));
    for (let i = 0; i < n; i++) buf[i] = this.samples[start + i] / 32768;
    this.sampleCache.set(key, buf);
    return buf;
  }
}

function readBags(r: ByteReader, size: number): SF2Bag[] {
  return Array.from({ length: Math.floor(size / 4) }, () => ({ genNdx: r.u16(), modNdx: r.u16() }));
}
function readGens(r: ByteReader, size: number): SF2GenRecord[] {
  return Array.from({ length: Math.floor(size / 4) }, () => ({ oper: r.u16(), amount: i16(r.u16()) }));
}
function readMods(r: ByteReader, size: number): SF2ModRecord[] {
  return Array.from({ length: Math.floor(size / 10) }, () => ({
    srcOper: r.u16(), destOper: r.u16(), amount: i16(r.u16()), amtSrcOper: r.u16(), transOper: r.u16(),
  }));
}
