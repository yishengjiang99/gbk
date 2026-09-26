/**
 * Symbol post-processing: TypeScript port of the pure functions in
 * homr's transformer/vocabulary.py used after decoding:
 * is_lower_position, is_upper_or_has_no_position, EncodedSymbol.remove_tuplet,
 * EncodedSymbol.to_upper_position and remove_duplicated_symbols.
 *
 * Durations are exact rational fractions (numerator/denominator pairs),
 * matching Python's Fraction arithmetic.
 */
import type { DecodedSymbol } from "./vocab.js";

export interface Fraction {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1;
}

function frac(n: number, d: number): Fraction {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function fracAdd(a: Fraction, b: Fraction): Fraction {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

function fracMul(a: Fraction, b: Fraction): Fraction {
  return frac(a.n * b.n, a.d * b.d);
}

function fracCmp(a: Fraction, b: Fraction): number {
  return a.n * b.d - b.n * a.d;
}

export function isLowerPosition(position: string): boolean {
  return position.startsWith("lower");
}

export function isUpperOrHasNoPosition(position: string): boolean {
  return !isLowerPosition(position);
}

function priorPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p / 2;
}

/**
 * Parses a **kern duration token (note_4, rest_8., note_12, ...) into a
 * Fraction of a whole note. Direct port of kern_to_symbol_duration plus
 * SymbolDuration._to_fraction.
 */
export function kernDurationFraction(rhythm: string): Fraction {
  const parts = rhythm.split("_");
  const kern = parts.length > 1 ? parts[1] : "";
  if (kern.endsWith("m")) return frac(1, 1);
  let i = 0;
  while (i < kern.length && kern[i] >= "0" && kern[i] <= "9") i++;
  const baseStr = kern.slice(0, i);
  const rest = kern.slice(i);
  const base = baseStr === "" ? 4 : parseInt(baseStr, 10);
  const dots = (rest.match(/\./g) ?? []).length;
  if (kern.includes("G")) return frac(0, 1);
  if (base === 0) {
    let dur = frac(1, 1);
    let add = frac(1, 2);
    for (let k = 0; k < dots; k++) {
      dur = fracAdd(dur, add);
      add = frac(add.n, add.d * 2);
    }
    return dur;
  }
  let baseDuration: Fraction;
  let actualNotes = 1;
  let normalNotes = 1;
  if (base > 0 && (base & (base - 1)) === 0) {
    baseDuration = frac(1, base);
  } else {
    normalNotes = priorPowerOfTwo(base);
    baseDuration = frac(1, normalNotes);
    actualNotes = base;
  }
  let dur = baseDuration;
  let add = fracMul(dur, frac(1, 2));
  for (let k = 0; k < dots; k++) {
    dur = fracAdd(dur, add);
    add = frac(add.n, add.d * 2);
  }
  if (actualNotes !== normalNotes) {
    dur = fracMul(dur, frac(normalNotes, actualNotes));
  }
  return dur;
}

/** Removes tuplet scaling from a rhythm token. Port of remove_tuplet. */
export function removeTuplet(rhythm: string): string {
  const m = /^(note|rest)_(\d+)(.*)$/.exec(rhythm);
  if (!m) return rhythm;
  let duration = parseInt(m[2], 10);
  if (duration % 3 === 0) duration = (duration / 3) * 2;
  else if (duration % 5 === 0) duration = (duration / 5) * 4;
  else if (duration % 7 === 0) duration = (duration / 7) * 4;
  else return rhythm;
  return `${m[1]}_${duration}${m[3]}`;
}

/** Rewrites a lower-staff position to the upper staff. Port of to_upper_position. */
export function toUpperPosition(symbol: DecodedSymbol): DecodedSymbol {
  if (isUpperOrHasNoPosition(symbol.position)) return symbol;
  return { ...symbol, position: symbol.position.replace("lower", "upper") };
}

type Chord = DecodedSymbol[];

function groupIntoChords(symbols: DecodedSymbol[]): Chord[] {
  const chords: Chord[] = [];
  let isInChord = false;
  for (const symbol of symbols) {
    if (symbol.rhythm === "chord") {
      isInChord = true;
    } else if (isInChord && chords.length > 0) {
      chords[chords.length - 1].push(symbol);
      isInChord = false;
    } else {
      chords.push([symbol]);
    }
  }
  return chords;
}

function flattenChords(chords: Chord[]): DecodedSymbol[] {
  const result: DecodedSymbol[] = [];
  for (const chord of chords) {
    if (chords.length === 0) continue;
    let isInChord = false;
    for (const symbol of chord) {
      if (isInChord) {
        result.push({
          rhythm: "chord",
          pitch: "nonote",
          lift: "nonote",
          articulation: "nonote",
          slur: "nonote",
          position: "nonote",
          attention: symbol.attention,
        });
      }
      result.push(symbol);
      isInChord = true;
    }
  }
  return result;
}

function groupIntoMeasures(chords: Chord[]): Chord[][] {
  const measures: Chord[][] = [];
  let current: Chord[] = [];
  for (const chord of chords) {
    current.push(chord);
    if (chord.length > 0 && (chord[0].rhythm.includes("barline") || chord[0].rhythm.includes("repeat"))) {
      measures.push(current);
      current = [];
    }
  }
  if (current.length > 0) measures.push(current);
  return measures;
}

function durationOfMeasure(measure: Chord[]): Fraction {
  let total = frac(0, 1);
  for (const chord of measure) {
    let duration = frac(0, 1);
    for (const symbol of chord) {
      if (symbol.rhythm.startsWith("note") || symbol.rhythm.startsWith("rest")) {
        const f = kernDurationFraction(symbol.rhythm);
        if (fracCmp(f, frac(0, 1)) > 0 && (fracCmp(f, duration) < 0 || fracCmp(duration, frac(0, 1)) === 0)) {
          duration = f;
        }
      }
    }
    total = fracAdd(total, duration);
  }
  return total;
}

function typicalDurationOfMeasures(measures: Chord[][]): Fraction {
  const durations = measures.map(durationOfMeasure);
  if (durations.length === 0) return frac(0, 1);
  const sorted = [...durations].sort(fracCmp);
  return sorted[Math.floor(sorted.length / 2)];
}

function removeTupletsFromMeasure(measure: Chord[]): Chord[] {
  return measure.map((chord) => chord.map((s) => ({ ...s, rhythm: removeTuplet(s.rhythm) })));
}

function fixOverEagerTuplets(chords: Chord[]): Chord[] {
  const measures = groupIntoMeasures(chords);
  const mean = typicalDurationOfMeasures(measures);
  const result: Chord[][] = [];
  for (const measure of measures) {
    if (fracCmp(durationOfMeasure(measure), mean) < 0) {
      result.push(removeTupletsFromMeasure(measure));
    } else {
      result.push(measure);
    }
  }
  return result.flat();
}

function onlyKeepLowerStaffIfThereIsAClef(chords: Chord[]): Chord[] {
  let hasLowerClef = false;
  return chords.map((chord, i) =>
    chord.map((symbol) => {
      if (hasLowerClef) return symbol;
      if (i < 5 && symbol.rhythm.startsWith("clef") && isLowerPosition(symbol.position)) {
        hasLowerClef = true;
        return symbol;
      }
      return toUpperPosition(symbol);
    }),
  );
}

function removeDuplicatedPitches(chord: Chord): Chord {
  if (chord.length <= 1 || !(chord[0].rhythm.startsWith("note") || chord[0].rhythm.startsWith("rest"))) {
    return chord;
  }
  const byPitch = new Map<string, DecodedSymbol>();
  const order: string[] = [];
  for (const symbol of chord) {
    const key = `${symbol.pitch} ${symbol.position}`;
    const existing = byPitch.get(key);
    if (existing) {
      if (fracCmp(kernDurationFraction(symbol.rhythm), kernDurationFraction(existing.rhythm)) > 0) {
        byPitch.set(key, symbol);
      }
    } else {
      byPitch.set(key, symbol);
      order.push(key);
    }
  }
  return order.map((k) => byPitch.get(k) as DecodedSymbol);
}

function removeRedundantClefsKeysAndTimeSignatures(chords: Chord[]): Chord[] {
  let clefUpper = "";
  let clefLower = "";
  let key = "";
  let time = "";
  return chords.map((chord) => {
    const result: DecodedSymbol[] = [];
    for (const symbol of chord) {
      if (symbol.rhythm.startsWith("clef")) {
        if (isUpperOrHasNoPosition(symbol.position)) {
          if (symbol.rhythm !== clefUpper) {
            clefUpper = symbol.rhythm;
            result.push(symbol);
          }
        } else if (symbol.rhythm !== clefLower) {
          clefLower = symbol.rhythm;
          result.push(symbol);
        }
      } else if (symbol.rhythm.startsWith("keySignature")) {
        if (symbol.rhythm !== key) {
          key = symbol.rhythm;
          result.push(symbol);
        }
      } else if (symbol.rhythm.startsWith("timeSignature")) {
        if (symbol.rhythm !== time) {
          time = symbol.rhythm;
          result.push(symbol);
        }
      } else {
        result.push(symbol);
      }
    }
    return result;
  });
}

/**
 * Post-processes one voice's decoded symbols. Direct port of
 * remove_duplicated_symbols (cleanup_tuplets=True).
 */
export function removeDuplicatedSymbols(symbols: DecodedSymbol[]): DecodedSymbol[] {
  let chords = groupIntoChords(symbols);
  chords = fixOverEagerTuplets(chords);
  chords = onlyKeepLowerStaffIfThereIsAClef(chords);
  chords = chords.map(removeDuplicatedPitches);
  chords = removeRedundantClefsKeysAndTimeSignatures(chords);
  return flattenChords(chords);
}
