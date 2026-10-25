import Foundation
import OMRHomrIOS

/// omr-homr-ios (port of liebharc/homr, AGPL-3.0): page -> SMF (one track per staff) -> Score.
/// Pages are appended one after another (page 2 starts at the end of page 1).
struct HomrSheetRecognizer: SheetRecognizer {
    func recognize(pages: [SheetPage]) async throws -> Score {
        try await Task.detached(priority: .userInitiated) { try Self.recognizeSync(pages: pages) }.value
    }

    static func recognizeSync(pages: [SheetPage]) throws -> Score {
        var merged = Score(parts: [])
        var offset = 0.0
        var lastError: Error?
        for page in pages {
            let g = page.gray8()
            let result: ParseSheetMusicResult
            do {
                result = try OMRHomrIOS.parseSheetMusicWithLayout(gray8: g.data, width: g.width, height: g.height)
            } catch let e as OMRError {
                if case .modelsNotBundled(let m) = e { throw ScanError.recognizerUnavailable("recognition models are not installed (\(m))") }
                if case .sessionNotConfigured(let m) = e { throw ScanError.recognizerUnavailable(m) }
                lastError = e; continue
            } catch { lastError = error; continue } // e.g. no staff on this page
            guard result.staffCount > 0, !result.midi.isEmpty else { continue }
            let s = try SMFReader.score(from: result.midi)
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
        if merged.noteCount == 0 {
            if let lastError, pages.count == 1, !(String(describing: lastError).lowercased().contains("staff")) {
                throw ScanError.failed(String(describing: lastError))
            }
            throw ScanError.nothingRecognized
        }
        return merged
    }
}
