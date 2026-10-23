/**
 * SoundFont 2.01 (.sf2) loader: thin compatibility wrapper around src/sf2/soundfont.ts.
 *
 * `parseSF2(u8)` keeps the historical shape (info / sdta / pdta tables, getPreset,
 * buildRegionsForPreset). Regions follow SoundFont 2.01 (zone override rules, 10.5 clamping,
 * the 2.01 default modulators plus file modulators, raw sample levels): see
 * docs/SF2_COMPLIANCE.md. Pass `{ mode: "strict" }` to reject structurally unsound files
 * (section 10.1); the default lenient mode records problems in `warnings`.
 */
import {
  SF2SoundFont, type SF2LoadOptions, type SF2Region, type SF2Info, type SF2SampleHeader,
  type SF2PresetHeader, type SF2InstrumentHeader, type SF2Bag, type SF2GenRecord, type SF2ModRecord,
  type SF2StructuralError,
} from "./src/sf2/soundfont.ts";

export {
  SF2SoundFont, SF2Error, STRICT, LENIENT, describeStructural, specVersionString,
} from "./src/sf2/soundfont.ts";
export type {
  SF2Region, SF2Info, SF2SampleHeader, SF2SampleData, SF2VolEnv, SF2ModEnv, SF2LoadOptions, SF2StructuralError,
  SF2PresetHeader, SF2InstrumentHeader,
} from "./src/sf2/soundfont.ts";
export type { SF2Modulator, SF2SpecVersion } from "./src/sf2/modulator.ts";

/** Accepted for compatibility; SoundFont 2.01 regions always use raw sample levels (S-01). */
export interface BuildRegionsOptions {
  decodeToFloat32?: boolean;
  normalize?: boolean;
  includeStereoLinks?: boolean;
}

interface SF2PresetResult extends SF2PresetHeader { _bagStart: number; _bagEnd: number }

export interface SF2Data {
  info: SF2Info;
  sdta: { smpl: Int16Array | null; sm24: Uint8Array | null };
  pdta: {
    phdr: SF2PresetHeader[]; pbag: SF2Bag[]; pmod: SF2ModRecord[]; pgen: SF2GenRecord[];
    inst: SF2InstrumentHeader[]; ibag: SF2Bag[]; imod: SF2ModRecord[]; igen: SF2GenRecord[]; shdr: SF2SampleHeader[];
  };
  raw: { riffSize: number };
  warnings: SF2StructuralError[];
  soundFont: SF2SoundFont;
  getPreset: (presetIndex: number) => SF2PresetResult;
  buildRegionsForPreset: (presetIndex: number, options?: BuildRegionsOptions) => SF2Region[];
  resolvePresetIndex: (program: number, bank: number) => number | null;
}

export function parseSF2(u8: Uint8Array, options?: SF2LoadOptions): SF2Data {
  const sf = new SF2SoundFont(u8, options);
  return {
    info: sf.info,
    sdta: { smpl: sf.samples, sm24: sf.sm24 },
    pdta: { phdr: sf.phdr, pbag: sf.pbag, pmod: sf.pmod, pgen: sf.pgen, inst: sf.inst, ibag: sf.ibag, imod: sf.imod, igen: sf.igen, shdr: sf.shdr },
    raw: { riffSize: sf.riffSize },
    warnings: sf.warnings,
    soundFont: sf,
    getPreset: (i: number) => {
      if (!(i >= 0 && i < sf.phdr.length - 1)) throw new Error(`Preset index out of range: ${i}`);
      return { ...sf.phdr[i], _bagStart: sf.phdr[i].presetBagNdx, _bagEnd: sf.phdr[i + 1].presetBagNdx };
    },
    buildRegionsForPreset: (i: number) => sf.regionList(i),
    resolvePresetIndex: (p: number, b: number) => sf.resolvePresetIndex(p, b),
  };
}
