import Foundation

/// Token-string → SMF helpers for staff C-scale / metrical writeout.
///
/// Only interprets symbols already present in the upstream tokenizer /
/// `Vocabulary()` (e.g. rhythm `note_4`, pitch `C4`, lift `#`). Does **not**
/// invent token names or IDs.
public enum SymbolMIDIMapping: Sendable {

    /// Scientific pitch token (`C4`, `A#` is NOT used — accidentals live in `lift`) → MIDI note.
    /// Pitch tokens in vocab are natural letter+octave only (`C4`, `D4`, …).
    public static func midiNote(pitchToken: String, liftToken: String = EncodedSymbol.empty) -> UInt8? {
        guard pitchToken != EncodedSymbol.nonote, pitchToken != EncodedSymbol.empty else {
            return nil
        }
        // Expect Letter + optional digit octave, e.g. C4, B9
        guard let first = pitchToken.first else { return nil }
        let letter = String(first).uppercased()
        let octavePart = pitchToken.dropFirst()
        guard let octave = Int(octavePart) else { return nil }

        let base: Int
        switch letter {
        case "C": base = 0
        case "D": base = 2
        case "E": base = 4
        case "F": base = 5
        case "G": base = 7
        case "A": base = 9
        case "B": base = 11
        default: return nil
        }

        var semitone = (octave + 1) * 12 + base
        switch liftToken {
        case "#": semitone += 1
        case "##": semitone += 2
        case "b": semitone -= 1
        case "bb": semitone -= 2
        case "N", EncodedSymbol.empty, EncodedSymbol.nonote:
            break
        default:
            break
        }
        guard semitone >= 0, semitone <= 127 else { return nil }
        return UInt8(semitone)
    }

    /// Humdrum **kern duration from a `note_*` / `rest_*` rhythm token → ticks at `tpq`.
    ///
    /// Mirrors `kern_to_symbol_duration` + `SymbolDuration.fraction` (relative to whole note),
    /// then `ticks = fraction * 4 * tpq` (whole note = 4 quarters).
    public static func durationTicks(
        rhythmToken: String,
        tpq: Int = Int(SMFWriter.ticksPerQuarter)
    ) -> Int? {
        guard let kern = kernSuffix(fromRhythm: rhythmToken) else { return nil }
        guard let whole = wholeNoteFraction(kern: kern) else { return nil }
        // whole-note fraction * 4 quarters * tpq
        let ticks = whole * 4.0 * Double(tpq)
        return max(0, Int(ticks.rounded()))
    }

    /// Extract kern suffix after `note_` / `rest_`.
    public static func kernSuffix(fromRhythm rhythm: String) -> String? {
        if rhythm.hasPrefix("note_") {
            return String(rhythm.dropFirst(5))
        }
        if rhythm.hasPrefix("rest_") {
            return String(rhythm.dropFirst(5))
        }
        return nil
    }

    public static func isNoteRhythm(_ rhythm: String) -> Bool {
        rhythm.hasPrefix("note_")
    }

    public static func isRestRhythm(_ rhythm: String) -> Bool {
        rhythm.hasPrefix("rest_")
    }

    /// Map position token → staff index for canonical `(tick, pitch, duration, staff)` compares.
    /// `upper` / `upper2` → 0; `lower` / `lower2` → 1; unknown → 0.
    public static func staffIndex(positionToken: String) -> Int {
        switch positionToken {
        case "lower", "lower2":
            return 1
        default:
            return 0
        }
    }

    /// Build sequential note events from decoded symbols (skips non-notes; advances time on rests).
    ///
    /// Chord handling mirrors upstream `_group_into_chords`: a `chord` rhythm marker means the
    /// **next** note *or rest* shares onset with the previous event (no invented pitches). A
    /// chord-tied rest must not stack its duration after a note — that created artificial
    /// measure-length gaps on pickups / incomplete bars when the other hand rests.
    /// Barlines, clefs, key/time signatures are no-ops for the cursor (no pad-to-bar).
    ///
    /// Returned in token (emission) order. For the canonical sorted list shared with
    /// `noteLayout`, use `orderedNoteEvents(from:tpq:staffIndexOffset:)`.
    public static func noteEvents(
        from symbols: [EncodedSymbol],
        tpq: Int = Int(SMFWriter.ticksPerQuarter)
    ) -> [SMFWriter.NoteEvent] {
        sourcedNoteEvents(from: symbols, tpq: tpq).map(\.event)
    }

    /// One sounding note plus the index of the decoded symbol that produced it.
    ///
    /// This is the single shared note-event record behind both the SMF note track and
    /// `noteLayout` (see `OMRHomrIOS.renderTokens`). `symbolIndex` is the index into the
    /// input `[EncodedSymbol]` array — the seam used to attach attention boxes later.
    public struct SourcedNoteEvent: Equatable, Sendable {
        /// Zero-based index into the input symbol array (the `note_*` symbol).
        public var symbolIndex: Int
        /// The MIDI note event (pitch, onset, duration, staff) written to the SMF.
        public var event: SMFWriter.NoteEvent

        public init(symbolIndex: Int, event: SMFWriter.NoteEvent) {
            self.symbolIndex = symbolIndex
            self.event = event
        }
    }

    /// Canonical, **stably ordered** sounding-note list shared by MIDI + `noteLayout`.
    ///
    /// Ordering (total, deterministic): ascending `onsetTicks`, then `staff` (0 = top staff,
    /// increasing downward), then `midiNote` (low → high), then `durationTicks`, then
    /// `symbolIndex`. Rests, clefs, barlines, key/time signatures and grace notes produce no
    /// entries; each chord member is its own entry sharing the chord's onset.
    ///
    /// - Parameter staffIndexOffset: added to every position-derived staff index
    ///   (`upper`→0, `lower`→1) so a staff decoded on its own can be placed on a page.
    public static func orderedNoteEvents(
        from symbols: [EncodedSymbol],
        tpq: Int = Int(SMFWriter.ticksPerQuarter),
        staffIndexOffset: Int = 0
    ) -> [SourcedNoteEvent] {
        var events = sourcedNoteEvents(from: symbols, tpq: tpq)
        if staffIndexOffset != 0 {
            for i in events.indices {
                events[i].event.staff += staffIndexOffset
            }
        }
        events.sort(by: canonicalOrder)
        return events
    }

    /// `(tick, staff, pitch, duration, symbolIndex)` ascending — see `orderedNoteEvents`.
    static func canonicalOrder(_ lhs: SourcedNoteEvent, _ rhs: SourcedNoteEvent) -> Bool {
        let a = lhs.event
        let b = rhs.event
        if a.onsetTicks != b.onsetTicks { return a.onsetTicks < b.onsetTicks }
        if a.staff != b.staff { return a.staff < b.staff }
        if a.midiNote != b.midiNote { return a.midiNote < b.midiNote }
        if a.durationTicks != b.durationTicks { return a.durationTicks < b.durationTicks }
        return lhs.symbolIndex < rhs.symbolIndex
    }

    /// Token-order note events tagged with their source symbol index.
    /// `resetCursorOnClef`: a lower-staff clef after the first note restarts time at 0 (staff-only
    /// grand-staff dumps, whose second staff follows the first in the token stream). A mid-piece clef
    /// change on the same staff must not rewind time.
    static func sourcedNoteEvents(
        from symbols: [EncodedSymbol],
        tpq: Int = Int(SMFWriter.ticksPerQuarter),
        resetCursorOnClef: Bool = true
    ) -> [SourcedNoteEvent] {
        walkEvents(from: symbols, tpq: tpq, startTick: 0, resetCursorOnClef: resetCursorOnClef).events
    }

    /// Walk symbols with a time cursor starting at `startTick`. Returns the events plus the tick
    /// just past the last one, so callers can chain segments (rows, hands) back to back.
    static func walkEvents(
        from symbols: [EncodedSymbol],
        tpq: Int = Int(SMFWriter.ticksPerQuarter),
        startTick: Int = 0,
        resetCursorOnClef: Bool = true
    ) -> (events: [SourcedNoteEvent], endTick: Int) {
        var onset = startTick
        var chordAnchor = startTick
        var shareNextOnset = false
        var events: [SourcedNoteEvent] = []
        for (symbolIndex, sym) in symbols.enumerated() {
            if sym.rhythm == "chord" {
                shareNextOnset = true
                continue
            }
            if isRestRhythm(sym.rhythm) {
                let dur = durationTicks(rhythmToken: sym.rhythm, tpq: tpq) ?? tpq
                // Chord-tied rest (other hand/voice): share the anchor onset — do not stack
                // duration after the note. That stacking turned pickup + bass rest into a
                // full-measure silence gap (Die Letzte Kompanie anacrusis).
                if shareNextOnset {
                    let restEnd = chordAnchor + dur
                    if restEnd > onset { onset = restEnd }
                    shareNextOnset = false
                } else {
                    chordAnchor = onset
                    onset += dur
                }
                continue
            }
            if sym.rhythm.hasPrefix("clef_") {
                // A lower-staff clef starts the second staff's stream: reset the cursor so the two
                // staves of a grand-staff dump sound simultaneously. A same-staff clef change
                // (upper position) mid-piece must not rewind time.
                if resetCursorOnClef && !events.isEmpty && SymbolCleanup.isLower(sym.position) {
                    onset = startTick
                    chordAnchor = startTick
                }
                shareNextOnset = false
                continue
            }
            guard isNoteRhythm(sym.rhythm) else {
                // barline / keySignature / timeSignature / etc. — cursor no-op
                shareNextOnset = false
                continue
            }
            guard let midi = midiNote(pitchToken: sym.pitch, liftToken: sym.lift) else {
                shareNextOnset = false
                continue
            }
            let dur = durationTicks(rhythmToken: sym.rhythm, tpq: tpq) ?? tpq
            // Grace (kern contains G) → zero-duration in upstream; skip sounding note.
            if let kern = kernSuffix(fromRhythm: sym.rhythm), kern.contains("G") {
                shareNextOnset = false
                continue
            }
            let tick: Int
            if shareNextOnset {
                tick = chordAnchor
                shareNextOnset = false
                // Longer chord member (or note after a shorter rest) must extend the cursor.
                let memberEnd = chordAnchor + dur
                if memberEnd > onset { onset = memberEnd }
            } else {
                tick = onset
                chordAnchor = onset
                onset += dur
            }
            events.append(
                SourcedNoteEvent(
                    symbolIndex: symbolIndex,
                    event: SMFWriter.NoteEvent(
                        midiNote: midi,
                        onsetTicks: tick,
                        durationTicks: max(1, dur),
                        staff: staffIndex(positionToken: sym.position)
                    )
                )
            )
        }
        return (events, onset)
    }

    /// Page-path voice stream → note events. Rows (split on `newline`) run sequentially; within a
    /// grand-staff row, the lower staff restarts at the row's start tick so the two hands sound
    /// simultaneously instead of one after the other. The next row starts after the longer hand,
    /// so a short-decoded hand can't drag later systems out of alignment.
    ///
    /// The hand split is by position tag (first upper → lower transition), not by clef token: the
    /// page cleanup drops repeated clefs, and a mid-piece clef change inside one hand must not
    /// move time.
    static func pageVoiceEvents(
        from symbols: [EncodedSymbol],
        tpq: Int = Int(SMFWriter.ticksPerQuarter),
        grandstaff: Bool
    ) -> [SourcedNoteEvent] {
        var events: [SourcedNoteEvent] = []
        var rowTick = 0
        var row: [EncodedSymbol] = []

        /// - Parameter base: voice-stream index of `row[0]` (newlines included, matching the
        ///   pre-split stream that `render` and the box provider index into).
        func flushRow(base: Int) {
            let count = row.count
            guard count > 0 else { return }
            let before = events.count
            if grandstaff, let split = row.firstIndex(where: { SymbolCleanup.isLower($0.position) }) {
                let upper = walkEvents(from: Array(row[..<split]), tpq: tpq, startTick: rowTick,
                                       resetCursorOnClef: false)
                var lower = walkEvents(from: Array(row[split...]), tpq: tpq, startTick: rowTick,
                                       resetCursorOnClef: false)
                for i in lower.events.indices { lower.events[i].symbolIndex += split }
                events.append(contentsOf: upper.events)
                events.append(contentsOf: lower.events)
                rowTick = max(upper.endTick, lower.endTick)
            } else {
                let walked = walkEvents(from: row, tpq: tpq, startTick: rowTick, resetCursorOnClef: false)
                events.append(contentsOf: walked.events)
                rowTick = walked.endTick
            }
            for i in before..<events.count { events[i].symbolIndex += base }
        }

        var base = 0
        for sym in symbols {
            if sym.rhythm == "newline" {
                flushRow(base: base)
                base += row.count + 1
                row.removeAll(keepingCapacity: true)
                continue
            }
            row.append(sym)
        }
        flushRow(base: base)
        return events
    }

    // MARK: - Kern (upstream-faithful)

    /// Returns duration as a fraction of a whole note (`1.0` = whole).
    static func wholeNoteFraction(kern: String) -> Double? {
        if kern.hasSuffix("m") {
            // Multirest — upstream returns Fraction(1) (one whole)
            return 1.0
        }
        if kern.contains("G") {
            return 0.0
        }

        var i = kern.startIndex
        while i < kern.endIndex, kern[i].isNumber {
            i = kern.index(after: i)
        }
        let baseStr = String(kern[..<i])
        let rest = String(kern[i...])
        let base = Int(baseStr) ?? 4
        let dots = rest.filter { $0 == "." }.count

        if base == 0 {
            // Whole-measure rest convention in upstream
            return dotted(1.0, dots: dots)
        }

        let baseDuration: Double
        let actualNotes: Double
        let normalNotes: Double
        if base > 0, (base & (base - 1)) == 0 {
            // Power of two
            baseDuration = 1.0 / Double(base)
            actualNotes = 1
            normalNotes = 1
        } else {
            // Tuplet: next lower power of two
            let normal = priorPowerOfTwo(base)
            baseDuration = 1.0 / Double(normal)
            actualNotes = Double(base)
            normalNotes = Double(normal)
        }

        var dur = dotted(baseDuration, dots: dots)
        if actualNotes != normalNotes {
            dur *= normalNotes / actualNotes
        }
        return dur
    }

    private static func dotted(_ base: Double, dots: Int) -> Double {
        var dur = base
        var add = base / 2.0
        for _ in 0..<dots {
            dur += add
            add /= 2.0
        }
        return dur
    }

    private static func priorPowerOfTwo(_ n: Int) -> Int {
        // Mirror upstream vocabulary.prior_power_of_two: largest power of two <= n.
        if n < 1 { return 1 }
        return 1 << (Int.bitWidth - 1 - n.leadingZeroBitCount)
    }
}
