import Foundation
import OMRHomrIOS

/// What the scan engine needs from a page session: `PageInferenceSession` in the app, fakes in
/// tests. Mirrors Music Reader's `PageParser` (omr-sheet-cam `PageRecognitionService`): the
/// protocol's own result type is an app value, so tests can fake a parse without constructing
/// package-internal types.
protocol ScanPageParsing: AnyObject, Sendable {
    func parse(gray8: Data, width: Int, height: Int, progress: PageParseProgressHandler?) throws -> ScanPageOutput
    func parse(rgbx: Data, width: Int, height: Int, bytesPerRow: Int, progress: PageParseProgressHandler?) throws -> ScanPageOutput
    /// ORT execution providers in play for this session.
    var scanBackends: ScanBackends { get }
}

/// ORT execution providers in play (the web scan telemetry's `backends` shape):
/// SegNet + encoder are CoreML EP with CPU fallback, the decoder is always CPU.
struct ScanBackends: Equatable, Sendable {
    var segnet = "unknown"
    var encoder = "unknown"
    var decoder = "unknown"
    /// Parallel staff slots in the session pool.
    var slots = 0
}

/// One parsed page: the package result plus the diagnostics Music Reader records per parse
/// (stage timings, per-staff raw vs post-filter symbol counts in layout order).
struct ScanPageOutput: Sendable {
    struct StageMs: Equatable, Sendable {
        var name: String
        var ms: Double
    }

    struct StaffSymbols: Equatable, Sendable {
        var raw: Int
        var filtered: Int
        var isGrandstaff: Bool
        var voice: Int
        var row: Int
    }

    var result: ParseSheetMusicResult
    var stages: [StageMs] = []
    var staffSymbols: [StaffSymbols] = []
    /// Per staff (same order as `staffSymbols`): encoder + decoder ms from the parse timings.
    var perStaffMs: [Double] = []
    var backends = ScanBackends()
    /// Wall time of the whole parse call (set by the engine; 0 for direct construction).
    var pageMs: Double = 0

    init(result: ParseSheetMusicResult) {
        self.result = result
    }

    init(_ r: PageParseResult, backends: ScanBackends) {
        result = r.result
        stages = r.timings.map { .init(name: $0.stage, ms: $0.ms) }
        staffSymbols = Self.staffSymbolCounts(r)
        perStaffMs = Self.perStaffMs(r)
        self.backends = backends
    }

    /// Per-staff encode+decode ms, folded from the `decode_s<i>_enc` / `decode_s<i>_dec`
    /// stage timings the package records per staff.
    static func perStaffMs(_ r: PageParseResult) -> [Double] {
        var out = [Double](repeating: 0, count: r.layout.staffs.count)
        for t in r.timings {
            guard t.stage.hasPrefix("decode_s") else { continue }
            let rest = t.stage.dropFirst("decode_s".count)
            guard let sep = rest.firstIndex(of: "_"), let i = Int(rest[..<sep]), out.indices.contains(i) else { continue }
            out[i] += t.ms
        }
        return out
    }

    /// Per-staff symbol counts from a full `PageParseResult` (Music Reader's
    /// `PageParseOutput.staffSymbolCounts`): a staff with raw 0 decoded nothing; filtered 0
    /// was stripped by the position filter.
    static func staffSymbolCounts(_ r: PageParseResult) -> [StaffSymbols] {
        var out: [StaffSymbols] = []
        for (i, s) in r.layout.staffs.enumerated()
            where i < r.staffSymbols.count && i < r.filteredStaffSymbols.count
        {
            out.append(StaffSymbols(raw: r.staffSymbols[i].count, filtered: r.filteredStaffSymbols[i].count,
                                    isGrandstaff: s.isGrandstaff, voice: s.voice, row: s.row))
        }
        return out
    }
}

extension PageInferenceSession: ScanPageParsing {
    func parse(gray8: Data, width: Int, height: Int, progress: PageParseProgressHandler?) throws -> ScanPageOutput {
        let r = try parsePage(gray8: gray8, width: width, height: height, progress: progress)
        return ScanPageOutput(r, backends: scanBackends)
    }

    func parse(rgbx: Data, width: Int, height: Int, bytesPerRow: Int, progress: PageParseProgressHandler?) throws -> ScanPageOutput {
        let r = try parsePage(rgbx: rgbx, width: width, height: height, bytesPerRow: bytesPerRow, progress: progress)
        return ScanPageOutput(r, backends: scanBackends)
    }

    var scanBackends: ScanBackends {
        func name(_ backend: (any ORTSessionBackend)?) -> String {
            guard let reporting = backend as? ORTProviderReporting else { return "unknown" }
            switch reporting.provider {
            case .coreML: return "coreML"
            case .cpu: return "cpu"
            }
        }
        return ScanBackends(segnet: name(segnet.backend), encoder: name(staff.encoder.backend),
                            decoder: name(staff.decoder.backend), slots: staffPool.count)
    }
}

/// A classified page-parse failure: the user-facing `ScanError` (the sheet's existing copy)
/// plus the stable telemetry reason code.
struct ScanFailure: Error, Equatable, Sendable {
    var scanError: ScanError
    var reasonCode: String
}

/// Outcome classification, mirroring Music Reader's `PageRecognitionService.outcome(for:)`:
/// staffCount 0, empty MIDI and no sounding notes are distinct failures, and package errors
/// map onto the sheet's existing error copy with a reason code for telemetry.
enum ScanOutcomeClassifier {
    static func failure(for result: ParseSheetMusicResult) -> ScanFailure? {
        guard result.staffCount > 0 else {
            return ScanFailure(scanError: .nothingRecognized, reasonCode: "no_staff")
        }
        guard !result.midi.isEmpty else {
            return ScanFailure(scanError: .failed("the recognizer returned an empty MIDI file"), reasonCode: "empty_midi")
        }
        guard !result.noteLayout.isEmpty else {
            return ScanFailure(scanError: .nothingRecognized, reasonCode: "no_notes")
        }
        return nil
    }

    static func failure(for error: Error) -> ScanFailure {
        if let f = error as? ScanFailure { return f }
        if let e = error as? PageStaffDetectionError {
            switch e {
            case .noNoteheads, .noStaffs:
                return ScanFailure(scanError: .nothingRecognized, reasonCode: "no_staff")
            }
        }
        if let e = error as? OMRError {
            switch e {
            case .modelsNotBundled(let m):
                return ScanFailure(scanError: .recognizerUnavailable("recognition models are not installed (\(m))"),
                                   reasonCode: "models_not_bundled")
            case .sessionNotConfigured(let m):
                return ScanFailure(scanError: .recognizerUnavailable(m), reasonCode: "session_not_configured")
            case .invalidPixelBuffer(let m):
                return ScanFailure(scanError: .unreadableInput(m), reasonCode: "invalid_input")
            case .unsupportedImageFormat(let m):
                return ScanFailure(scanError: .unreadableInput(m), reasonCode: "unsupported_format")
            case .tokenizerMissing(let m):
                return ScanFailure(scanError: .recognizerUnavailable("recognition vocabulary is missing (\(m))"),
                                   reasonCode: "tokenizer_missing")
            case .staffOnlyGate1NotReady(let m), .invalidVocabulary(let m):
                return ScanFailure(scanError: .failed(e.description), reasonCode: "parse_error")
            }
        }
        return ScanFailure(scanError: .failed(String(describing: error)), reasonCode: "parse_error")
    }
}

/// Measurements for one whole scan (1...n pages), aggregated from the per-page outputs.
/// The field set mirrors the web scan telemetry's `ScanDiagnostics` (src/telemetry/scan.ts)
/// and Music Reader's `page_parse` diagnostics event.
struct ScanRunSummary: Equatable, Sendable {
    var pages = 0
    var totalMs = 0.0
    var stageMs: [String: Double] = [:]
    var backends: ScanBackends?
    var staffCount = 0
    var systemCount = 0
    var voiceCount = 0
    var rawTokens = 0
    var filteredTokens = 0
    /// Per staff across all pages, in parse order: post-filter token counts, raw token
    /// counts, and encode+decode ms (the web telemetry's compact per-staff joins).
    var perStaffTokens: [Int] = []
    var perStaffRawTokens: [Int] = []
    var perStaffMs: [Double] = []
    var noteCount = 0
    var midiBytes = 0
    var warningCount = 0
    /// The last parsed page's layout source ("attention" / "midi-fallback").
    var layoutSource = ""
    /// Set when the scan (or its last page) failed; one of the classifier's reason codes.
    var failureReason: String? = nil

    mutating func add(_ out: ScanPageOutput) {
        pages += 1
        if backends == nil { backends = out.backends }
        staffCount += out.result.staffCount
        systemCount += Set(out.staffSymbols.map(\.row)).count
        voiceCount += Set(out.staffSymbols.map(\.voice)).count
        rawTokens += out.staffSymbols.reduce(0) { $0 + $1.raw }
        filteredTokens += out.staffSymbols.reduce(0) { $0 + $1.filtered }
        perStaffTokens += out.staffSymbols.map(\.filtered)
        perStaffRawTokens += out.staffSymbols.map(\.raw)
        perStaffMs += out.perStaffMs
        noteCount += out.result.noteLayout.count
        midiBytes += out.result.midi.count
        warningCount += out.result.warnings.count
        layoutSource = out.result.layoutSource.rawValue
        for s in out.stages { stageMs[s.name, default: 0] += s.ms }
    }

    // Stage splits in the web telemetry's shape, folded from the package's stage timings
    // (its "staffs" stage is the web's "detect"; per-staff decode stages split enc/dec).
    var preprocessMs: Double { stageMs["preprocess"] ?? 0 }
    var segnetMs: Double { stageMs["segnet"] ?? 0 }
    var detectMs: Double { stageMs["staffs"] ?? 0 }
    var encodeMs: Double { stageMs.filter { $0.key.hasPrefix("decode_s") && $0.key.hasSuffix("_enc") }.values.reduce(0, +) }
    var decodeMs: Double { stageMs.filter { $0.key.hasPrefix("decode_s") && $0.key.hasSuffix("_dec") }.values.reduce(0, +) }
}

/// Thread-safe cell for the last scan's summary (the recognizer is a struct; its controller
/// and telemetry read the summary after `recognize` returns or throws).
final class ScanSummaryBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ScanRunSummary?
    func set(_ s: ScanRunSummary) { lock.lock(); value = s; lock.unlock() }
    func get() -> ScanRunSummary? { lock.lock(); defer { lock.unlock() }; return value }
}

/// Recognizers that can report the last scan's measurements (telemetry).
protocol ScanSummaryProviding: SheetRecognizer {
    var lastScanSummary: ScanRunSummary? { get }
}

/// Serialized access to the native page pipeline, mirroring Music Reader's
/// `PageRecognitionService.Engine`:
///
/// - The session comes from the package's `PageSessionCache` (`OMRHomrIOS.defaultPageSession()`)
///   — the same cache the launch warmup (`ScanModelWarmup`) fills and the memory-warning
///   release empties, so a scan never builds a second, cold session. (Music Reader warms
///   app-owned backends instead; GBK's accepted divergence, see #166.)
/// - One parse at a time, FIFO: a queued parse whose task was cancelled fails fast instead
///   of burning a full parse when its turn arrives.
/// - Pages are fed like Music Reader feeds them: monochrome pages stay gray8; color pages
///   go in as RGBX so the package preprocesses in color like homr.
/// - The parse itself runs in a detached task, never on the main thread.
actor NativeScanEngine {
    typealias SessionProvider = @Sendable () throws -> any ScanPageParsing

    static let shared = NativeScanEngine()

    private let provider: SessionProvider
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// Parses completed so far (tests: serialization / reuse).
    private(set) var parseCount = 0

    init(provider: @escaping SessionProvider = { try OMRHomrIOS.defaultPageSession() }) {
        self.provider = provider
    }

    private func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }

    /// One page through the native pipeline, classified: `.success` only when the result
    /// has staffs, a non-empty MIDI and at least one sounding note.
    func parse(page: SheetPage, progress: PageParseProgressHandler? = nil) async -> Result<ScanPageOutput, ScanFailure> {
        await acquire()
        defer { release() }
        guard !Task.isCancelled else {
            return .failure(ScanFailure(scanError: .failed("cancelled"), reasonCode: "cancelled"))
        }
        let t0 = DispatchTime.now()
        do {
            let session = try provider()
            var out = try await Task.detached(priority: .userInitiated) { () throws -> ScanPageOutput in
                if let rgbx = page.rgbx() {
                    return try session.parse(rgbx: rgbx.data, width: rgbx.width, height: rgbx.height,
                                             bytesPerRow: rgbx.bytesPerRow, progress: progress)
                }
                let g = page.gray8()
                return try session.parse(gray8: g.data, width: g.width, height: g.height, progress: progress)
            }.value
            out.pageMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
            parseCount += 1
            if let failure = ScanOutcomeClassifier.failure(for: out.result) { return .failure(failure) }
            return .success(out)
        } catch {
            return .failure(ScanOutcomeClassifier.failure(for: error))
        }
    }
}
