// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — homr voice cleanup after per-staff decoding (page pipeline, milestone 3).
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): homr/transformer/vocabulary.py
// (remove_duplicated_symbols, _group_into_chords, _fix_over_eager_tuplets, _only_keep_lower_staff_if_there_is_a_clef,
// _remove_duplicated_piches, _remove_redudant_clefs_keys_and_time_signatures, _flatten_chords,
// EncodedSymbol.remove_tuplet / to_upper_position / get_duration, kern_to_symbol_duration, SymbolDuration)
// and homr/staff_parsing_tromr.py (predict_best position filter).

import Foundation

/// Exact rational (Python `fractions.Fraction`) for homr's duration arithmetic. Values stay tiny.
struct HFraction: Equatable, Comparable {
    let num: Int
    let den: Int

    init(_ n: Int, _ d: Int = 1) {
        var a = n, b = d
        if b < 0 { a = -a; b = -b }
        let g = HFraction.gcd(abs(a), b)
        num = g == 0 ? 0 : a / g
        den = g == 0 ? 1 : b / g
    }

    static func gcd(_ a: Int, _ b: Int) -> Int {
        var x = a, y = b
        while y != 0 { (x, y) = (y, x % y) }
        return x
    }

    static let zero = HFraction(0)

    static func + (l: HFraction, r: HFraction) -> HFraction {
        let n: Int = l.num * r.den + r.num * l.den
        return HFraction(n, l.den * r.den)
    }
    static func * (l: HFraction, r: HFraction) -> HFraction { HFraction(l.num * r.num, l.den * r.den) }
    static func / (l: HFraction, r: Int) -> HFraction { HFraction(l.num, l.den * r) }
    static func < (l: HFraction, r: HFraction) -> Bool { l.num * r.den < r.num * l.den }
}

enum SymbolCleanup {
    // MARK: - Durations (vocabulary.py SymbolDuration / kern_to_symbol_duration)

    static func durationFraction(base: HFraction, dots: Int, actualNotes: Int, normalNotes: Int) -> HFraction {
        let ratio = HFraction(actualNotes, normalNotes)
        var dur = base
        var add = dur / 2
        for _ in 0..<dots {
            dur = dur + add
            add = add / 2
        }
        if ratio.num != ratio.den {
            dur = dur * HFraction(ratio.den, ratio.num)
        }
        return dur
    }

    static func priorPowerOfTwo(_ n: Int) -> Int {
        if n < 1 { return 1 }
        var p = 1
        while p * 2 <= n { p *= 2 }
        return p
    }

    static func kernFraction(_ kern: String) -> HFraction {
        if kern.hasSuffix("m") { return HFraction(1) }
        let digits = kern.prefix(while: { $0.isASCII && $0.isNumber })
        let rest = kern.dropFirst(digits.count)
        let base = digits.isEmpty ? 4 : (Int(digits) ?? 4)
        let dots = rest.filter { $0 == "." }.count
        if kern.contains("G") { return durationFraction(base: .zero, dots: dots, actualNotes: 1, normalNotes: 1) }
        if base == 0 { return durationFraction(base: HFraction(1), dots: dots, actualNotes: 1, normalNotes: 1) }
        if base & (base - 1) == 0 {
            return durationFraction(base: HFraction(1, base), dots: dots, actualNotes: 1, normalNotes: 1)
        }
        let normal = priorPowerOfTwo(base)
        return durationFraction(base: HFraction(1, normal), dots: dots, actualNotes: base, normalNotes: normal)
    }

    /// `EncodedSymbol.get_duration().fraction` (0 for non note/rest symbols).
    static func duration(_ s: EncodedSymbol) -> HFraction {
        guard s.rhythm.hasPrefix("note") || s.rhythm.hasPrefix("rest") else { return .zero }
        let parts = s.rhythm.split(separator: "_", omittingEmptySubsequences: false)
        guard parts.count > 1 else { return .zero }  // homr would raise IndexError here
        return kernFraction(String(parts[1]))
    }

    // MARK: - Symbol transforms

    static func isLower(_ position: String) -> Bool { position.hasPrefix("lower") }

    /// `EncodedSymbol.to_upper_position`.
    static func toUpper(_ s: EncodedSymbol) -> EncodedSymbol {
        guard isLower(s.position) else { return s }
        var r = s
        r.position = s.position.replacingOccurrences(of: "lower", with: "upper")
        return r
    }

    /// `EncodedSymbol.remove_tuplet`: `re.match(r"(note|rest)_(\d+)(.*)")`.
    static func removeTuplet(_ s: EncodedSymbol) -> EncodedSymbol {
        let kind: String
        if s.rhythm.hasPrefix("note_") { kind = "note" } else if s.rhythm.hasPrefix("rest_") { kind = "rest" } else { return s }
        let tail = s.rhythm.dropFirst(kind.count + 1)
        let digits = tail.prefix(while: { $0.isASCII && $0.isNumber })
        guard !digits.isEmpty, var d = Int(digits) else { return s }
        if d % 3 == 0 { d = d / 3 * 2 } else if d % 5 == 0 { d = d / 5 * 4 } else if d % 7 == 0 { d = d / 7 * 4 } else { return s }
        var r = s
        r.rhythm = kind + "_" + String(d) + String(tail.dropFirst(digits.count))
        return r
    }

    // MARK: - remove_duplicated_symbols

    static func groupIntoChords(_ symbols: [EncodedSymbol]) -> [[EncodedSymbol]] {
        var chords: [[EncodedSymbol]] = []
        var inChord = false
        for s in symbols {
            if s.rhythm == "chord" {
                inChord = true
            } else if inChord && !chords.isEmpty {
                chords[chords.count - 1].append(s)
                inChord = false
            } else {
                chords.append([s])
            }
        }
        return chords
    }

    static func flattenChords(_ chords: [[EncodedSymbol]]) -> [EncodedSymbol] {
        var out: [EncodedSymbol] = []
        for chord in chords {
            var inChord = false
            for s in chord {
                if inChord { out.append(EncodedSymbol(rhythm: "chord")) }
                out.append(s)
                inChord = true
            }
        }
        return out
    }

    static func groupIntoMeasures(_ chords: [[EncodedSymbol]]) -> [[[EncodedSymbol]]] {
        var measures: [[[EncodedSymbol]]] = []
        var current: [[EncodedSymbol]] = []
        for chord in chords {
            current.append(chord)
            if let first = chord.first, first.rhythm.contains("barline") || first.rhythm.contains("repeat") {
                measures.append(current)
                current = []
            }
        }
        if !current.isEmpty { measures.append(current) }
        return measures
    }

    static func measureDuration(_ measure: [[EncodedSymbol]]) -> HFraction {
        var total = HFraction.zero
        for chord in measure {
            var d = HFraction.zero
            for s in chord where s.rhythm.hasPrefix("note") || s.rhythm.hasPrefix("rest") {
                let f = duration(s)
                if HFraction.zero < f && (f < d || d == .zero) { d = f }
            }
            total = total + d
        }
        return total
    }

    static func fixOverEagerTuplets(_ chords: [[EncodedSymbol]]) -> [[EncodedSymbol]] {
        let measures = groupIntoMeasures(chords)
        let durations = measures.map(measureDuration)
        let typical = durations.isEmpty ? HFraction.zero : durations.sorted()[durations.count / 2]
        var out: [[EncodedSymbol]] = []
        for (m, d) in zip(measures, durations) {
            if d < typical {
                out.append(contentsOf: m.map { $0.map(removeTuplet) })
            } else {
                out.append(contentsOf: m)
            }
        }
        return out
    }

    /// A lower clef anywhere in the stream marks a grand staff: keep lower positions. (The old
    /// first-5-chords heuristic assumed the interleaved homorhythmic order, where the bass clef
    /// rides with the treble clef in the first chord group; rhythmically independent hands decode
    /// hand-after-hand, with the bass clef mid-stream — the old heuristic silently converted the
    /// whole bass staff to upper, which also broke per-hand track assignment.)
    static func onlyKeepLowerStaffIfThereIsAClef(_ chords: [[EncodedSymbol]]) -> [[EncodedSymbol]] {
        let hasLowerClef = chords.contains { chord in
            chord.contains { $0.rhythm.hasPrefix("clef") && isLower($0.position) }
        }
        guard !hasLowerClef else { return chords }
        return chords.map { $0.map(toUpper) }
    }

    /// `_remove_duplicated_piches`. homr's replacement branch writes `by_pitch[symbol.pitch]`, a key that is
    /// never read back (keys are "pitch position"), so the first symbol per (pitch, position) always wins.
    static func removeDuplicatedPitches(_ chord: [EncodedSymbol]) -> [EncodedSymbol] {
        guard chord.count > 1, chord[0].rhythm.hasPrefix("note") || chord[0].rhythm.hasPrefix("rest") else { return chord }
        var seen = Set<String>()
        var out: [EncodedSymbol] = []
        for s in chord {
            let key = s.pitch + " " + s.position
            if seen.insert(key).inserted { out.append(s) }
        }
        return out
    }

    static func removeRedundantClefsKeysAndTimeSignatures(_ chords: [[EncodedSymbol]]) -> [[EncodedSymbol]] {
        var clefUpper = "", clefLower = "", key = "", time = ""
        var out: [[EncodedSymbol]] = []
        for chord in chords {
            var r: [EncodedSymbol] = []
            for s in chord {
                if s.rhythm.hasPrefix("clef") {
                    if !isLower(s.position) {
                        if s.rhythm != clefUpper { clefUpper = s.rhythm; r.append(s) }
                    } else if s.rhythm != clefLower {
                        clefLower = s.rhythm; r.append(s)
                    }
                } else if s.rhythm.hasPrefix("keySignature") {
                    if s.rhythm != key { key = s.rhythm; r.append(s) }
                } else if s.rhythm.hasPrefix("timeSignature") {
                    if s.rhythm != time { time = s.rhythm; r.append(s) }
                } else {
                    r.append(s)
                }
            }
            out.append(r)
        }
        return out
    }

    /// homr `remove_duplicated_symbols(symbols, cleanup_tuplets=True)`.
    static func removeDuplicatedSymbols(_ symbols: [EncodedSymbol], cleanupTuplets: Bool = true) -> [EncodedSymbol] {
        var chords = groupIntoChords(symbols)
        if cleanupTuplets {
            chords = fixOverEagerTuplets(chords)
            chords = onlyKeepLowerStaffIfThereIsAClef(chords)
        }
        chords = chords.map(removeDuplicatedPitches)
        chords = removeRedundantClefsKeysAndTimeSignatures(chords)
        return flattenChords(chords)
    }

    /// homr `predict_best`: a staff that is not part of a grand staff keeps only upper / position-less symbols.
    static func positionFilter(_ symbols: [EncodedSymbol], isGrandstaff: Bool) -> [EncodedSymbol] {
        isGrandstaff ? symbols : symbols.filter { !isLower($0.position) }
    }
}
