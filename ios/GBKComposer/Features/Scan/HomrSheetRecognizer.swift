import Foundation
import OMRHomrIOS

/// omr-homr-ios (port of liebharc/homr, AGPL-3.0) through `NativeScanEngine`: the package's
/// cached page session (warmed at launch by `ScanModelWarmup`), one parse at a time, pages
/// fed gray8 or RGBX like Music Reader feeds them. Each page's SMF (one track per staff) is
/// read back into a Score; pages are appended one after another (page 2 starts at the end of
/// page 1). A page that fails classification is skipped; the scan fails only when no page
/// produced notes, or immediately when the recognizer itself is unavailable (no models).
struct HomrSheetRecognizer: SheetRecognizer, ScanSummaryProviding {
    var engine: NativeScanEngine
    private let summaryBox = ScanSummaryBox()

    init(engine: NativeScanEngine = .shared) {
        self.engine = engine
    }

    var lastScanSummary: ScanRunSummary? { summaryBox.get() }

    func recognize(pages: [SheetPage]) async throws -> Score {
        let t0 = DispatchTime.now()
        func elapsed() -> Double {
            Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
        }
        var summary = ScanRunSummary()
        var merged = Score(parts: [])
        var offset = 0.0
        var lastFailure: ScanFailure?
        for page in pages {
            let out: ScanPageOutput
            switch await engine.parse(page: page) {
            case .failure(let failure):
                if case .recognizerUnavailable = failure.scanError {
                    // No models / no session: later pages would fail the same way.
                    summary.failureReason = failure.reasonCode
                    summary.totalMs = elapsed()
                    summaryBox.set(summary)
                    throw failure.scanError
                }
                lastFailure = failure
                continue
            case .success(let parsed):
                out = parsed
            }
            summary.add(out)
            let s = try SMFReader.score(from: out.result.midi)
            merged.tempo = merged.tempo ?? s.tempo
            merged.key = merged.key ?? s.key
            merged.timeSig = merged.timeSig ?? s.timeSig
            var end = offset
            for (idx, part) in s.parts.enumerated() {
                let shifted = part.notes.map { n -> ScoreNote in var n = n; n.onset += offset; end = max(end, n.onset + n.duration); return n }
                if idx < merged.parts.count { merged.parts[idx].notes += shifted }
                else { merged.parts.append(ScorePart(name: part.name, program: part.program, notes: shifted)) }
            }
            offset = end
        }
        summary.totalMs = elapsed()
        if merged.noteCount == 0 {
            // A single page surfaces its own classified failure; several pages that all
            // failed read as "nothing recognized", with the last reason kept for telemetry.
            let failure = (pages.count == 1 ? lastFailure : nil)
                ?? ScanFailure(scanError: .nothingRecognized, reasonCode: lastFailure?.reasonCode ?? "no_notes")
            summary.failureReason = failure.reasonCode
            summaryBox.set(summary)
            throw failure.scanError
        }
        summaryBox.set(summary)
        return merged
    }
}
