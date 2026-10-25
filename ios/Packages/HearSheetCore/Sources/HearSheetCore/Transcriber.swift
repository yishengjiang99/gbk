// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendored unchanged from yishengjiang99/earsheet @ 357cb76 Packages/HearSheet (Copyright (C) 2026 Yisheng Jiang).
import Foundation

/// End-to-end transcription: windowed Core ML inference, Spotify's
/// overlap/strip/concatenate postprocess, then the ported note decoder.
///
/// Mirrors `basic_pitch/inference.py` (`get_audio_input` / `window_audio_file` /
/// `unwrap_output`, current `main` trim): 3840-sample zero front-pad, 36164-sample
/// hop, 15 frames stripped per window edge (142 usable), trim to the audio length.
/// (v0.4.0's `floor(L * 86 / 22050)` trim differs only in trailing-frame count;
/// main's `int((L / 36164) * 142)` is used since the decoder port targets main.)
public enum Transcriber {
    public static let maxDurationSeconds = 60.0
    public static let maxSamples = Int(HearSheet.sampleRate * maxDurationSeconds)
    public static let frontPadSamples = 3840       // overlap_len / 2
    public static let hopSamples = 36164           // AUDIO_N_SAMPLES - 30 * FFT_HOP
    public static let stripFrames = 15             // half of the 30 overlapping frames
    public static let usableFramesPerWindow = 142  // 172 - 30

    public enum TranscribeError: Error, CustomStringConvertible {
        case emptyAudio
        case tooQuiet
        case durationLimitExceeded
        public var description: String {
            switch self {
            case .emptyAudio: return "No audio to transcribe."
            case .tooQuiet: return "The take is too quiet to transcribe."
            case .durationLimitExceeded: return "Audio must be 60 seconds or shorter."
            }
        }
    }

    /// - Parameters:
    ///   - samples: 22050 Hz mono float32.
    ///   - model: loaded Basic Pitch Core ML model.
    ///   - onProgress: 0...1 as windows complete. Called off the main thread.
    /// - Returns: detected notes, sorted by onset.
    public static func transcribe(
        samples: [Float],
        model: BasicPitchModel,
        onProgress: ((Double) -> Void)? = nil
    ) throws -> [NoteEvent] {
        guard !samples.isEmpty else { throw TranscribeError.emptyAudio }
        try validateSampleCount(samples.count)

        let windowSamples = HearSheet.windowSamples
        var padded = [Float](repeating: 0, count: frontPadSamples + samples.count)
        padded.replaceSubrange(frontPadSamples..<(frontPadSamples + samples.count), with: samples)

        let totalWindows = max(1, (padded.count + hopSamples - 1) / hopSamples)
        var noteFrames: [[Float]] = []
        var onsetFrames: [[Float]] = []
        var contourFrames: [[Float]] = []
        noteFrames.reserveCapacity(totalWindows * usableFramesPerWindow)
        onsetFrames.reserveCapacity(totalWindows * usableFramesPerWindow)
        contourFrames.reserveCapacity(totalWindows * usableFramesPerWindow)

        var start = 0
        var done = 0
        while start < padded.count {
            try Task.checkCancellation()
            var window = [Float](repeating: 0, count: windowSamples)
            let avail = min(windowSamples, padded.count - start)
            window.replaceSubrange(0..<avail, with: padded[start..<(start + avail)])
            let post = try model.predict(waveform: window)
            noteFrames.append(contentsOf: post.note[stripFrames..<(172 - stripFrames)])
            onsetFrames.append(contentsOf: post.onset[stripFrames..<(172 - stripFrames)])
            contourFrames.append(contentsOf: post.contour[stripFrames..<(172 - stripFrames)])
            start += hopSamples
            done += 1
            onProgress?(Double(done) / Double(totalWindows))
        }

        // Trim to the audio length (Spotify main): int((L / hop) * 142).
        let keep = Int((Double(samples.count) / Double(hopSamples)) * Double(usableFramesPerWindow))
        if keep < noteFrames.count {
            noteFrames.removeLast(noteFrames.count - keep)
            onsetFrames.removeLast(onsetFrames.count - keep)
            contourFrames.removeLast(contourFrames.count - keep)
        }

        let raw = BasicPitchDecoder.decode(frames: noteFrames, onset: onsetFrames, contour: contourFrames,
                                           thresholds: model.thresholds)
        // Velocity from calibrated RMS energy (not model confidence).
        // Falls back to 127*amplitude when the note's audio span is silent.
        let calibrator = VelocityCalibrator()
        let sampleRate = Float(HearSheet.sampleRate)
        return raw.map { r in
            let onsetSec = BasicPitchDecoder.frameToTime(frame: r.startFrame)
            let offsetSec = BasicPitchDecoder.frameToTime(frame: r.endFrame)
            let fromSample = Int((onsetSec * Double(sampleRate)).rounded())
            let toSample = Int((offsetSec * Double(sampleRate)).rounded())
            let rms = VelocityCalibrator.rms(of: samples, from: fromSample, to: toSample)
            let velocity: Int
            if rms > 0 {
                velocity = calibrator.velocity(for: r.midi, rms: rms)
            } else {
                velocity = min(127, max(1, Int((127 * r.amplitude).rounded())))
            }
            return NoteEvent(
                onset: onsetSec,
                offset: offsetSec,
                midi: r.midi,
                velocity: velocity)
        }.sorted { $0.onset < $1.onset }
    }

    static func validateSampleCount(_ count: Int) throws {
        guard count <= maxSamples else { throw TranscribeError.durationLimitExceeded }
    }

    /// Peak absolute amplitude of a take; below ~0.02 the take counts as too quiet.
    public static func peakLevel(of samples: [Float]) -> Float {
        var peak: Float = 0
        for v in samples {
            let a = v >= 0 ? v : -v
            if a > peak { peak = a }
        }
        return peak
    }
}
