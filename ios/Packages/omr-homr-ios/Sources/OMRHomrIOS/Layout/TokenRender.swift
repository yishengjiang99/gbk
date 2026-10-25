import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Seam for real per-note boxes (attention-derived) — **not wired yet**.
///
/// When a provider returns a non-null rect for every sounding note, `renderTokens` reports
/// `layoutSource == .attention`. Otherwise the result stays `.midiFallback` (any real rects
/// that were returned are kept; missing ones stay `.null`). Implementations must return nil
/// rather than guess — coordinates are never fabricated.
public protocol NoteBoxProvider {
    /// Page-space rect for the `note_*` symbol at `symbolIndex` of the input stream, or nil.
    func pageRect(forSymbolAt symbolIndex: Int, symbol: EncodedSymbol) -> CGRect?
}

public extension OMRHomrIOS {
    /// Decoded tokens → SMF **and** `noteLayout`, both built from ONE shared note-event list
    /// (`SymbolMIDIMapping.orderedNoteEvents`).
    ///
    /// Guarantees:
    /// - `noteLayout.count` == number of sounding notes written to the SMF (rests, clefs,
    ///   barlines, signatures and grace notes produce no entry; each chord member gets its own
    ///   entry with the shared onset).
    /// - Order is total and stable: ascending `(onsetTicks, staffIndex, midiNote)`, tie-broken
    ///   by `(durationTicks, symbolIndex)`. Staff 0 is the top staff (`upper`), 1 below it
    ///   (`lower`), plus `staffIndexOffset`.
    /// - `symbolIndex` is the real index of the source `note_*` symbol in `symbols`.
    /// - SMF has one track per staff (track 0 = conductor, track `1 + staffIndex` = staff).
    ///   Merging all staff tracks' note-ons by `(tick, track)` yields exactly `noteLayout`
    ///   order, so `noteLayout[k]` is the k-th merged note-on (`noteLayout[k].noteIndex == k`)
    ///   and each entry's note lives in track `noteLayout[k].staffIndex + 1`.
    /// - Without a `boxProvider` every `pageRect` is `.null` and `layoutSource == .midiFallback`.
    ///
    /// - Parameters:
    ///   - symbols: decoded (or fixture) symbol stream; multi-staff (grand staff) streams OK.
    ///   - staffIndexOffset: added to every position-derived staff index (place a separately
    ///     decoded staff on its page row).
    ///   - boxProvider: optional real-box seam (attention); nil today.
    ///   - writer: SMF writer config (format 1 @ 480 TPQ).
    /// - Returns: `ParseSheetMusicResult`; `staffCount` = number of staff tracks in `midi`
    ///   (highest staff index + 1, minimum 1).
    static func renderTokens(
        _ symbols: [EncodedSymbol],
        staffIndexOffset: Int = 0,
        boxProvider: (any NoteBoxProvider)? = nil,
        writer: SMFWriter = SMFWriter()
    ) -> ParseSheetMusicResult {
        let ordered = SymbolMIDIMapping.orderedNoteEvents(
            from: symbols,
            tpq: Int(SMFWriter.ticksPerQuarter),
            staffIndexOffset: staffIndexOffset
        )
        let midi = writer.write(notes: ordered.map(\.event))
        var layout = NoteLayout.midiFallback(from: ordered)
        var source: LayoutSource = .midiFallback
        var warnings: [String] = []

        if let provider = boxProvider, !layout.isEmpty {
            var boxed = 0
            for i in layout.indices {
                let symbolIndex = layout[i].symbolIndex
                if let rect = provider.pageRect(
                    forSymbolAt: symbolIndex,
                    symbol: symbols[symbolIndex]
                ), !rect.isNull {
                    layout[i].pageRect = rect
                    boxed += 1
                }
            }
            if boxed == layout.count {
                source = .attention
            } else {
                warnings.append(
                    "layout: midi-fallback (boxes for \(boxed)/\(layout.count) notes)"
                )
            }
        } else {
            warnings.append("layout: midi-fallback (no attention boxes; pageRect is .null)")
        }

        return ParseSheetMusicResult(
            midi: midi,
            noteLayout: layout,
            layoutSource: source,
            staffCount: max(1, (ordered.map { $0.event.staff }.max() ?? 0) + 1),
            warnings: warnings
        )
    }
}
