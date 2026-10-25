import Foundation
import HearSheetCore

/// On-device note detection: earsheet's Basic Pitch Core ML pipeline (vendored HearSheetCore).
/// The model (BasicPitchPoly.mlpackage, Apache-2.0 Spotify weights) ships in the app bundle under HumModel/.
enum HumTranscriber {
    enum Failure: Error, CustomStringConvertible {
        case modelMissing
        var description: String { "the note-detection model isn't bundled in this build" }
    }

    nonisolated(unsafe) private static var cached: BasicPitchModel?
    private static let lock = NSLock()

    static var modelsDirectory: URL? { Bundle.main.url(forResource: "HumModel", withExtension: nil) }

    static func model() throws -> BasicPitchModel {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        guard let dir = modelsDirectory else { throw Failure.modelMissing }
        let m = try BasicPitchModel(modelsDirectory: dir)
        cached = m
        return m
    }

    /// 22,050 Hz mono samples → notes in seconds. Runs off the main thread.
    static func transcribe(_ samples: [Float], onProgress: (@Sendable (Double) -> Void)? = nil) async throws -> [HumTimedNote] {
        try await Task.detached(priority: .userInitiated) {
            let events = try Transcriber.transcribe(samples: samples, model: try model(), onProgress: onProgress)
            return events.map(Self.timed)
        }.value
    }

    /// NoteEvent → web TimedNote. Web velocity = round(amplitude·127), so amplitude = velocity/127 keeps it.
    static func timed(_ e: NoteEvent) -> HumTimedNote {
        HumTimedNote(pitchMidi: Double(e.midi), startSec: e.onset, endSec: e.offset, amplitude: Double(e.velocity) / 127)
    }
}
