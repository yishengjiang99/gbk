// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendored unchanged from yishengjiang99/earsheet @ 357cb76 Packages/HearSheet (Copyright (C) 2026 Yisheng Jiang).
import Foundation

/// Swift port of Spotify basic-pitch `note_creation.py` (`output_to_notes_polyphonic`,
/// `get_infered_onsets`, `get_pitch_bends`, `drop_overlapping_pitch_bends`).
/// Copyright 2022 Spotify AB — Apache-2.0 (see NOTICE).
///
/// The model graph is unchanged: note [time, 88], onset [time, 88],
/// contour [time, 264] heads over MIDI 21–108 (A0–C8).
/// Thresholds are per model: `BasicPitchModel` reads them from the model's sidecar
/// (`<models>/BasicPitchPoly.thresholds.json`, pinned in models.lock) at load time, and
/// `Transcriber` / `StreamingTranscriber` decode with `model.thresholds`. A model without a
/// sidecar falls back to Spotify's documented defaults (`Thresholds.basicPitchDefaults`).
public enum BasicPitchDecoder {
    public struct Thresholds: Equatable, Sendable {
        public var onset: Float
        public var frame: Float
        /// Notes this many frames or shorter are dropped (86.13 frames/s).
        public var minNoteLenFrames: Int

        public init(onset: Float, frame: Float, minNoteLenFrames: Int) {
            self.onset = onset
            self.frame = frame
            self.minNoteLenFrames = minNoteLenFrames
        }

        /// Spotify basic-pitch defaults (`DEFAULT_ONSET_THRESHOLD` 0.5, `DEFAULT_FRAME_THRESHOLD` 0.3,
        /// `DEFAULT_MIN_NOTE_LEN` 11). Used only for a model that ships no thresholds sidecar.
        public static let basicPitchDefaults = Thresholds(onset: 0.5, frame: 0.3, minNoteLenFrames: 11)

        /// Sidecar file name for a model package: `BasicPitchPoly.mlpackage` -> `BasicPitchPoly.thresholds.json`.
        public static func sidecarURL(forPackageAt packageURL: URL) -> URL {
            packageURL.deletingLastPathComponent()
                .appendingPathComponent(packageURL.deletingPathExtension().lastPathComponent + ".thresholds.json")
        }

        /// Parses a sidecar (the `decoder-thresholds.json` format attached to model releases:
        /// `onset_threshold`, `frame_threshold`, optional `min_note_len_frames`).
        /// Returns nil if the JSON is malformed or a value is out of range.
        public static func parse(_ data: Data) -> Thresholds? {
            struct Sidecar: Decodable {
                var onset_threshold: Double
                var frame_threshold: Double
                var min_note_len_frames: Int?
            }
            guard let s = try? JSONDecoder().decode(Sidecar.self, from: data) else { return nil }
            let minLen = s.min_note_len_frames ?? basicPitchDefaults.minNoteLenFrames
            guard s.onset_threshold > 0, s.onset_threshold < 1, s.frame_threshold > 0, s.frame_threshold < 1,
                  (1...1000).contains(minLen) else { return nil }
            return Thresholds(onset: Float(s.onset_threshold), frame: Float(s.frame_threshold), minNoteLenFrames: minLen)
        }

        /// Thresholds for the package at `packageURL`: its sidecar, or `basicPitchDefaults`
        /// when the sidecar is missing or invalid.
        public static func load(forPackageAt packageURL: URL) -> (thresholds: Thresholds, fromSidecar: Bool) {
            if let data = try? Data(contentsOf: sidecarURL(forPackageAt: packageURL)), let t = parse(data) {
                return (t, true)
            }
            return (basicPitchDefaults, false)
        }
    }

    public struct RawNote: Equatable, Sendable {
        public var startFrame: Int
        public var endFrame: Int
        public var midi: Int
        public var amplitude: Float
        /// Pitch bend in units of 1/3 semitone per frame, or nil when dropped
        /// (overlapping notes, `multiple_pitch_bends=False`). Informational:
        /// the SF2 sequence player does not honor pitch bend, so bends are
        /// never written to MIDI.
        public var pitchBend: [Int]?
    }

    static let energyTolerance = 11   // Spotify ENERGY_TOLERANCE (trailing frames)
    static let maxFreqIdx = 87
    static let midiOffset = 21

    /// - Parameters:
    ///   - frames: note-head posterior, [time][88].
    ///   - onset: onset-head posterior, [time][88].
    ///   - contour: contour-head posterior, [time][264].
    /// - Returns: decoded notes, sorted by (start, end, pitch) like Spotify.
    public static func decode(frames: [[Float]], onset: [[Float]], contour: [[Float]],
                              thresholds: Thresholds) -> [RawNote] {
        let nFrames = frames.count
        guard nFrames > 0, frames[0].count == 88, onset.count == nFrames else { return [] }

        // infer_onsets=True
        let ons = inferOnsets(onsets: onset, frames: frames)

        // Peak picking: scipy.signal.argrelmax(onsets, axis=0), order=1, mode='clip'
        // = strictly greater than both temporal neighbors (never at the edges).
        var peakMat = [[Float]](repeating: [Float](repeating: 0, count: 88), count: nFrames)
        if nFrames >= 3 {
            for t in 1..<(nFrames - 1) {
                for f in 0..<88 {
                    let v = ons[t][f]
                    if v > ons[t - 1][f], v > ons[t + 1][f] {
                        peakMat[t][f] = v
                    }
                }
            }
        }
        // Candidates at/above threshold, iterated BACKWARD in time (freq descending).
        var candidates: [(t: Int, f: Int)] = []
        for t in stride(from: nFrames - 1, through: 0, by: -1) {
            for f in stride(from: 87, through: 0, by: -1) {
                if peakMat[t][f] >= thresholds.onset { candidates.append((t, f)) }
            }
        }

        var remaining = frames
        var events: [(s: Int, e: Int, midi: Int, amp: Float)] = []

        for (t0, f) in candidates {
            if t0 >= nFrames - 1 { continue } // too close to the end
            var i = t0 + 1
            var k = 0
            while i < nFrames - 1, k < energyTolerance {
                if remaining[i][f] < thresholds.frame { k += 1 } else { k = 0 }
                i += 1
            }
            i -= k // back to the last frame above threshold
            if i - t0 <= thresholds.minNoteLenFrames { continue } // too short
            for t in t0..<i {
                remaining[t][f] = 0
                if f < maxFreqIdx { remaining[t][f + 1] = 0 }
                if f > 0 { remaining[t][f - 1] = 0 }
            }
            var amp: Float = 0
            for t in t0..<i { amp += frames[t][f] }
            events.append((t0, i, f + midiOffset, amp / Float(i - t0)))
        }

        // melodia_trick: repeatedly claim the loudest remaining frame blob.
        while true {
            var best: Float = -1
            var bi = 0, bf = 0
            for t in 0..<nFrames {
                for f in 0..<88 {
                    let v = remaining[t][f]
                    if v > best { best = v; bi = t; bf = f }
                }
            }
            guard best > thresholds.frame else { break }
            let iMid = bi, f = bf
            remaining[iMid][f] = 0
            // Forward pass.
            var i = iMid + 1
            var k = 0
            while i < nFrames - 1, k < energyTolerance {
                if remaining[i][f] < thresholds.frame { k += 1 } else { k = 0 }
                remaining[i][f] = 0
                if f < maxFreqIdx { remaining[i][f + 1] = 0 }
                if f > 0 { remaining[i][f - 1] = 0 }
                i += 1
            }
            let iEnd = i - 1 - k
            // Backward pass.
            i = iMid - 1
            k = 0
            while i > 0, k < energyTolerance {
                if remaining[i][f] < thresholds.frame { k += 1 } else { k = 0 }
                remaining[i][f] = 0
                if f < maxFreqIdx { remaining[i][f + 1] = 0 }
                if f > 0 { remaining[i][f - 1] = 0 }
                i -= 1
            }
            let iStart = i + 1 + k
            if iEnd - iStart <= thresholds.minNoteLenFrames { continue }
            var amp: Float = 0
            for t in iStart..<iEnd { amp += frames[t][f] }
            events.append((iStart, iEnd, f + midiOffset, amp / Float(iEnd - iStart)))
        }

        let withBends = pitchBends(contour: contour, events: events)
        return dropOverlappingBends(withBends)
    }

    // MARK: - Inferred onsets

    /// `get_infered_onsets(onsets, frames, n_diff=2)`.
    static func inferOnsets(onsets: [[Float]], frames: [[Float]]) -> [[Float]] {
        let nFrames = onsets.count
        var frameDiff = [[Float]](repeating: [Float](repeating: 0, count: 88), count: nFrames)
        for t in 0..<nFrames {
            for f in 0..<88 {
                var m = Float.greatestFiniteMagnitude
                for n in 1...2 {
                    let prev: Float = t - n >= 0 ? frames[t - n][f] : 0
                    let d = frames[t][f] - prev
                    if d < m { m = d }
                }
                frameDiff[t][f] = m
            }
        }
        for t in 0..<nFrames {
            for f in 0..<88 where frameDiff[t][f] < 0 { frameDiff[t][f] = 0 }
        }
        for t in 0..<min(2, nFrames) {
            for f in 0..<88 { frameDiff[t][f] = 0 }
        }
        var maxFD: Float = 0
        var maxOn: Float = 0
        for t in 0..<nFrames {
            for f in 0..<88 {
                if frameDiff[t][f] > maxFD { maxFD = frameDiff[t][f] }
                if onsets[t][f] > maxOn { maxOn = onsets[t][f] }
            }
        }
        var out = onsets
        if maxFD <= 0 {
            // numpy: max(onsets) * 0 / 0 -> NaN; max(onsets, NaN) -> NaN.
            // NaN onsets yield no peaks (comparisons false); the melodia
            // trick still runs on the frame activations.
            for t in 0..<nFrames {
                for f in 0..<88 { out[t][f] = Float.nan }
            }
            return out
        }
        let scale = maxOn / maxFD
        for t in 0..<nFrames {
            for f in 0..<88 {
                let v = frameDiff[t][f] * scale
                if v > out[t][f] { out[t][f] = v }
            }
        }
        return out
    }

    // MARK: - Pitch bends (contour head)

    /// `get_pitch_bends(contours, note_events, n_bins_tolerance=25)`.
    static func pitchBends(contour: [[Float]],
                           events: [(s: Int, e: Int, midi: Int, amp: Float)]) -> [RawNote] {
        let nContours = 264
        let tol = 25
        let windowLength = tol * 2 + 1 // 51
        // scipy.signal.windows.gaussian(51, std=5)
        let gauss: [Float] = (0..<windowLength).map { n in
            let x = Double(n - tol) / 5.0
            return Float(exp(-0.5 * x * x))
        }
        return events.map { ev in
            let freqIdx = Int((36.0 * log2(midiToHz(ev.midi) / 27.5)).rounded())
            let fStart = max(freqIdx - tol, 0)
            let fEnd = min(nContours, freqIdx + tol + 1)
            let gLo = max(0, tol - freqIdx)
            let pbShift = tol - max(0, tol - freqIdx)
            var bends: [Int] = []
            bends.reserveCapacity(max(0, ev.e - ev.s))
            for t in ev.s..<ev.e {
                guard t < contour.count else { break }
                var bestVal: Float = -1
                var bestJ = 0
                var j = 0
                for c in fStart..<fEnd {
                    let v = contour[t][c] * gauss[gLo + j]
                    if v > bestVal { bestVal = v; bestJ = j }
                    j += 1
                }
                bends.append(bestJ - pbShift) // units of 1/3 semitone
            }
            return RawNote(startFrame: ev.s, endFrame: ev.e, midi: ev.midi,
                           amplitude: ev.amp, pitchBend: bends)
        }
    }

    /// `drop_overlapping_pitch_bends` (`multiple_pitch_bends=False`).
    static func dropOverlappingBends(_ notes: [RawNote]) -> [RawNote] {
        var sorted = notes.sorted {
            if $0.startFrame != $1.startFrame { return $0.startFrame < $1.startFrame }
            if $0.endFrame != $1.endFrame { return $0.endFrame < $1.endFrame }
            if $0.midi != $1.midi { return $0.midi < $1.midi }
            return $0.amplitude < $1.amplitude
        }
        for i in 0..<sorted.count {
            for j in (i + 1)..<sorted.count {
                if sorted[j].startFrame >= sorted[i].endFrame { break }
                sorted[i].pitchBend = nil
                sorted[j].pitchBend = nil
            }
        }
        return sorted
    }

    // MARK: - Helpers

    static func midiToHz(_ midi: Int) -> Double {
        440.0 * pow(2.0, Double(midi - 69) / 12.0)
    }

    /// `model_frames_to_time`: frame index -> seconds, with Spotify's
    /// per-window magic alignment offset.
    public static func frameToTime(frame: Int) -> Double {
        let t = Double(frame) * 256.0 / 22050.0
        let windowNumber = frame / 172 // ANNOT_N_FRAMES, as in Spotify's code
        let windowOffset = (256.0 / 22050.0) * (172.0 - 43844.0 / 256.0) + 0.0018
        return t - Double(windowNumber) * windowOffset
    }
}
