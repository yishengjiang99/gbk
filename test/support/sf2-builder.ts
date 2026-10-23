// Builds tiny SF2 files in memory (mirror of sf2player-swift Tests/SF2EngineTests/SF2Builder.swift).
// Defaults produce a structurally valid SoundFont 2.01 file (passes strict loading).
import { Gen } from "../../src/sf2/geninfo.ts";

export { Gen };
export interface BMod { src: number; dest: number; amount: number; amtSrc?: number; transform?: number }
export interface BZone { gens: [number, number][]; mods?: BMod[] }
export interface BSample { name: string; start: number; end: number; loopStart: number; loopEnd: number; rate?: number; pitch?: number; corr?: number; link?: number; type?: number }

const le16 = (v: number) => [v & 255, (v >> 8) & 255];
const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 255);
const name20 = (s: string) => { const b = ascii(s).slice(0, 20); while (b.length < 20) b.push(0); return b; };
const u16 = (v: number) => v & 0xffff;

export class SF2Builder {
  samples: number[] = [];
  sampleHeaders: BSample[] = [];
  instruments: [string, BZone[]][] = [];
  presets: [string, number, number, BZone[]][] = [];
  ifil: [number, number] | null = [2, 1];
  ifilBytes: number[] | null = null;
  isng: string | null = "EMU8000";
  irom: string | null = null;
  iver: [number, number] | null = null;
  info: [string, string][] = [["INAM", "Test Bank"]];
  rawInfo: [string, number[]][] = [];
  omitTable: string | null = null;
  extraChunks: [string, string, number[]][] = [];
  topOrder = ["INFO", "sdta", "pdta"];
  pdtaOrder = ["phdr", "pbag", "pmod", "pgen", "inst", "ibag", "imod", "igen", "shdr"];
  smplBytes: number[] | null = null;
  omitSmpl = false;
  mutate: ((bytes: number[]) => number[]) | null = null;
  tableEdit: ((id: string, body: number[]) => number[]) | null = null;

  static le16 = le16;
  static le32 = le32;
  static chunk(id: string, body: number[]): number[] {
    return [...ascii(id), ...le32(body.length), ...body, ...(body.length % 2 === 1 ? [0] : [])];
  }
  static list(type: string, chunks: number[]): number[] { return SF2Builder.chunk("LIST", [...ascii(type), ...chunks]); }
  static zstr(s: string): number[] { const b = [...ascii(s), 0]; if (b.length % 2 === 1) b.push(0); return b; }
  private static mod(m: BMod): number[] {
    return [...le16(m.src), ...le16(m.dest), ...le16(u16(m.amount)), ...le16(m.amtSrc ?? 0), ...le16(m.transform ?? 0)];
  }

  clone(): SF2Builder {
    const b = new SF2Builder();
    Object.assign(b, structuredClone({ ...this, mutate: null, tableEdit: null }));
    b.mutate = this.mutate; b.tableEdit = this.tableEdit;
    return b;
  }

  bytes(): number[] {
    const C = SF2Builder.chunk;
    let infoChunks: number[] = [];
    if (this.ifilBytes) infoChunks.push(...C("ifil", this.ifilBytes));
    else if (this.ifil) infoChunks.push(...C("ifil", [...le16(this.ifil[0]), ...le16(this.ifil[1])]));
    if (this.isng !== null) infoChunks.push(...C("isng", SF2Builder.zstr(this.isng)));
    for (const [k, v] of this.info) infoChunks.push(...C(k, SF2Builder.zstr(v)));
    if (this.irom !== null) infoChunks.push(...C("irom", SF2Builder.zstr(this.irom)));
    if (this.iver) infoChunks.push(...C("iver", [...le16(this.iver[0]), ...le16(this.iver[1])]));
    for (const [k, b] of this.rawInfo) infoChunks.push(...C(k, b));
    let smpl: number[] = [];
    for (const s of this.samples) smpl.push(...le16(u16(s)));
    if (this.smplBytes) smpl = this.smplBytes;
    const t: Record<string, number[]> = { phdr: [], pbag: [], pmod: [], pgen: [], inst: [], ibag: [], imod: [], igen: [], shdr: [] };
    let bagCount = 0, genCount = 0, modCount = 0;
    for (const [name, program, bank, zones] of this.presets) {
      t.phdr.push(...name20(name), ...le16(program), ...le16(bank), ...le16(bagCount), ...le32(0), ...le32(0), ...le32(0));
      for (const z of zones) {
        t.pbag.push(...le16(genCount), ...le16(modCount)); bagCount++;
        for (const [op, amt] of z.gens) { t.pgen.push(...le16(op), ...le16(u16(amt))); genCount++; }
        for (const m of z.mods ?? []) { t.pmod.push(...SF2Builder.mod(m)); modCount++; }
      }
    }
    t.phdr.push(...name20("EOP"), ...le16(0), ...le16(0), ...le16(bagCount), ...le32(0), ...le32(0), ...le32(0));
    t.pbag.push(...le16(genCount), ...le16(modCount));
    t.pgen.push(0, 0, 0, 0);
    t.pmod.push(...new Array(10).fill(0));
    bagCount = 0; genCount = 0; modCount = 0;
    for (const [name, zones] of this.instruments) {
      t.inst.push(...name20(name), ...le16(bagCount));
      for (const z of zones) {
        t.ibag.push(...le16(genCount), ...le16(modCount)); bagCount++;
        for (const [op, amt] of z.gens) { t.igen.push(...le16(op), ...le16(u16(amt))); genCount++; }
        for (const m of z.mods ?? []) { t.imod.push(...SF2Builder.mod(m)); modCount++; }
      }
    }
    t.inst.push(...name20("EOI"), ...le16(bagCount));
    t.ibag.push(...le16(genCount), ...le16(modCount));
    t.igen.push(0, 0, 0, 0);
    t.imod.push(...new Array(10).fill(0));
    for (const s of this.sampleHeaders) {
      t.shdr.push(...name20(s.name), ...le32(s.start), ...le32(s.end), ...le32(s.loopStart), ...le32(s.loopEnd), ...le32(s.rate ?? 44100));
      t.shdr.push((s.pitch ?? 60) & 255, (s.corr ?? 0) & 255, ...le16(s.link ?? 0), ...le16(s.type ?? 1));
    }
    t.shdr.push(...name20("EOS"), ...new Array(26).fill(0));
    if (this.tableEdit) for (const k of Object.keys(t)) t[k] = this.tableEdit(k, t[k]);
    const pdta: number[] = [];
    for (const id of this.pdtaOrder) if (id !== this.omitTable) pdta.push(...C(id, t[id] ?? []));
    const extras = (c: string) => this.extraChunks.filter((e) => e[0] === c).flatMap((e) => C(e[1], e[2]));
    const sdta = [...(this.omitSmpl ? [] : C("smpl", smpl)), ...extras("sdta")];
    const lists: Record<string, number[]> = {
      INFO: SF2Builder.list("INFO", [...infoChunks, ...extras("INFO")]),
      sdta: SF2Builder.list("sdta", sdta),
      pdta: SF2Builder.list("pdta", [...pdta, ...extras("pdta")]),
    };
    const body = ascii("sfbk");
    for (const l of this.topOrder) body.push(...(lists[l] ?? []));
    body.push(...extras("RIFF"));
    let out = [...ascii("RIFF"), ...le32(body.length), ...body];
    if (this.mutate) out = this.mutate(out);
    return out;
  }

  build(): Uint8Array { return new Uint8Array(this.bytes()); }

  // ── synthetic waveforms ──
  static dc(n: number, level = 16384): number[] { return new Array(n).fill(level); }
  static sine(cycles: number, n: number, amp = 16384): number[] {
    return Array.from({ length: n }, (_, i) => roundHalfAway(amp * Math.sin((2 * Math.PI * cycles * i) / n)));
  }
  /** White noise from a fixed-seed LCG (same sequence as the Swift builder). */
  static noise(n: number, seed = 0x5eedn, amp = 16384): number[] {
    let s = seed;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      out.push(Math.trunc(amp * (Number(s >> 11n) / 2 ** 53 * 2 - 1)));
    }
    return out;
  }
  static ramp(n: number): number[] { return Array.from({ length: n }, (_, i) => ((i << 16) >> 16)); }

  /** One-sample, one-instrument, one-preset valid bank around `wave` (46 guard zeros appended). */
  static single(wave: number[], o: { loop?: [number, number]; rate?: number; pitch?: number; instGens?: [number, number][];
    presetGens?: [number, number][]; instMods?: BMod[]; presetMods?: BMod[] } = {}): SF2Builder {
    const b = new SF2Builder();
    b.samples = [...wave, ...new Array(46).fill(0)];
    const l = o.loop ?? [0, 0];
    b.sampleHeaders = [{ name: "s", start: 0, end: wave.length, loopStart: l[0], loopEnd: l[1], rate: o.rate ?? 44100, pitch: o.pitch ?? 60 }];
    b.instruments = [["i", [{ gens: [...(o.instGens ?? []), [Gen.sampleID, 0]], mods: o.instMods ?? [] }]]];
    b.presets = [["p", 0, 0, [{ gens: [...(o.presetGens ?? []), [Gen.instrument, 0]], mods: o.presetMods ?? [] }]]];
    return b;
  }
}

function roundHalfAway(x: number): number { return x < 0 ? -Math.round(-x) : Math.round(x); }
