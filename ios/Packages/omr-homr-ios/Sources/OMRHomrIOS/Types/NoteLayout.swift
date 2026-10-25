import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
// On Linux, swift-corelibs-foundation provides `CGRect` / `CGFloat` (incl. `.null`, `isNull`,
// `isEmpty`), so `pageRect` keeps the same public type and name on every platform.

/// Stable layout hit for highlight overlays.
///
/// One entry per **sounding** MIDI note (rests produce none; each chord member gets its own
/// entry with the shared onset). When built by `OMRHomrIOS.renderTokens`, `noteLayout[k]`
/// describes the k-th note-on when all staff tracks' note-ons are merged by `(tick, track)`
/// (same shared, sorted note-event list); its note lives in SMF track `staffIndex + 1`.
///
/// `pageRect` is `CGRect.null` when no real box is known (`layoutSource == .midiFallback`);
/// coordinates are never fabricated.
public struct NoteLayout: Equatable, Sendable {
    /// Zero-based index into the decoded symbol stream (the `note_*` symbol that sounded).
    public var symbolIndex: Int
    /// MIDI note number when known; nil for rests / non-pitch symbols.
    public var midiNote: Int?
    /// Onset in ticks (SMF 480 TPQ).
    public var onsetTicks: Int
    /// Duration in ticks.
    public var durationTicks: Int
    /// Page-space rect for highlight; `.null` when no box is available (midi-fallback).
    public var pageRect: CGRect
    /// Staff index within the page (0-based, 0 = top staff). Staff-only gate-1 uses 0.
    public var staffIndex: Int
    /// Zero-based index of this entry in the sorted sounding-note list (== its array index
    /// in `noteLayout`, == ordinal of its note-on in the `(tick, track)`-merged SMF note-ons).
    public var noteIndex: Int

    /// Source-compatible initializer — argument labels identical to the pre-layout API
    /// (`symbolIndex:midiNote:onsetTicks:durationTicks:pageRect:staffIndex:`). `noteIndex`
    /// defaults to 0; use `init(symbolIndex:…:noteIndex:)` to set it.
    public init(
        symbolIndex: Int,
        midiNote: Int? = nil,
        onsetTicks: Int = 0,
        durationTicks: Int = 0,
        pageRect: CGRect = .null,
        staffIndex: Int = 0
    ) {
        self.init(
            symbolIndex: symbolIndex,
            midiNote: midiNote,
            onsetTicks: onsetTicks,
            durationTicks: durationTicks,
            pageRect: pageRect,
            staffIndex: staffIndex,
            noteIndex: 0
        )
    }

    /// Full initializer including `noteIndex` (required here so calls without it resolve to
    /// the source-compatible initializer above, unambiguously).
    public init(
        symbolIndex: Int,
        midiNote: Int? = nil,
        onsetTicks: Int = 0,
        durationTicks: Int = 0,
        pageRect: CGRect = .null,
        staffIndex: Int = 0,
        noteIndex: Int
    ) {
        self.symbolIndex = symbolIndex
        self.midiNote = midiNote
        self.onsetTicks = onsetTicks
        self.durationTicks = durationTicks
        self.pageRect = pageRect
        self.staffIndex = staffIndex
        self.noteIndex = noteIndex
    }

    /// True when `pageRect` carries a real box (not `.null` / empty).
    public var hasBox: Bool {
        !pageRect.isNull && !pageRect.isEmpty
    }

    /// Box-less layout (one entry per sounding note) from the shared ordered note list.
    ///
    /// Pass the output of `SymbolMIDIMapping.orderedNoteEvents(from:)` so entry order matches
    /// the MIDI note order. `noteIndex` is the position in `events`; `pageRect` is `.null`.
    public static func midiFallback(
        from events: [SymbolMIDIMapping.SourcedNoteEvent]
    ) -> [NoteLayout] {
        events.enumerated().map { index, sourced in
            NoteLayout(
                symbolIndex: sourced.symbolIndex,
                midiNote: Int(sourced.event.midiNote),
                onsetTicks: sourced.event.onsetTicks,
                durationTicks: sourced.event.durationTicks,
                pageRect: .null,
                staffIndex: sourced.event.staff,
                noteIndex: index
            )
        }
    }
}

/// Where `noteLayout` coordinates came from.
public enum LayoutSource: String, Equatable, Sendable {
    case attention
    case midiFallback = "midi-fallback"
}

/// Result of `parseSheetMusicWithLayout`.
public struct ParseSheetMusicResult: Equatable, Sendable {
    public var midi: Data
    public var noteLayout: [NoteLayout]
    public var layoutSource: LayoutSource
    public var staffCount: Int
    public var warnings: [String]

    public init(
        midi: Data,
        noteLayout: [NoteLayout],
        layoutSource: LayoutSource,
        staffCount: Int,
        warnings: [String]
    ) {
        self.midi = midi
        self.noteLayout = noteLayout
        self.layoutSource = layoutSource
        self.staffCount = staffCount
        self.warnings = warnings
    }
}

/// Input to the public parse entry point. Gate-1 uses a single staff image.
public struct ParseSheetMusicInput: Sendable {
    /// Staff image bytes (staff-only), or a PNG page when `staffOnly == false` (JPEG/HEIC pages: use
    /// `parseSheetMusicWithLayout(gray8:width:height:)`).
    public var imageData: Data
    /// When true, run the staff-only encoder→decoder path (gate-1); false = full-page SegNet path.
    public var staffOnly: Bool

    public init(imageData: Data, staffOnly: Bool = true) {
        self.imageData = imageData
        self.staffOnly = staffOnly
    }
}
