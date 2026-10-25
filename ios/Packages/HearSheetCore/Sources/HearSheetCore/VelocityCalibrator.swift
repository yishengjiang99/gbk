// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendored unchanged from yishengjiang99/earsheet @ 357cb76 Packages/HearSheet (Copyright (C) 2026 Yisheng Jiang).
import Foundation

/// Velocity calibration: maps per-note RMS energy to MIDI velocity.
///
/// Fit on MAESTRO + SMD piano train data (153k notes): for each MIDI pitch,
/// a linear map `velocity = a * log10(rms) + b`, where rms is computed over
/// the note's audio span at 22050 Hz. Replaces the stock
/// `velocity = 127 * mean note-posterior`, which measures model confidence,
/// not loudness (SMD test: 19.4 MAE, r=0.04 vs calibration 9.2 MAE, r=0.71).
public struct VelocityCalibrator: Sendable {
    private let coefficients: [Int: (a: Float, b: Float)]
    private let global: (a: Float, b: Float)

    public init() {
        var coef: [Int: (a: Float, b: Float)] = [:]
        var glob: (a: Float, b: Float) = (0, 64)
        if let url = Bundle.module.url(forResource: "velocity-calibration", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let g = json["global"] as? [String: Double],
               let a = g["a"], let b = g["b"] {
                glob = (Float(a), Float(b))
            }
            if let pitches = json["pitches"] as? [String: [String: Double]] {
                for (k, v) in pitches {
                    if let p = Int(k), let a = v["a"], let b = v["b"] {
                        coef[p] = (Float(a), Float(b))
                    }
                }
            }
        }
        self.coefficients = coef
        self.global = glob
    }

    /// Calibrated velocity 1...127 for a note.
    /// - Parameters:
    ///   - midi: MIDI pitch 21...108.
    ///   - rms: RMS energy over the note's audio span (linear, not dB).
    public func velocity(for midi: Int, rms: Float) -> Int {
        let (a, b) = coefficients[midi] ?? global
        let v = a * log10(max(rms, 1e-9)) + b
        return min(127, max(1, Int(v.rounded())))
    }

    /// RMS energy of samples in [fromSample, toSample).
    public static func rms(of samples: [Float], from fromSample: Int, to toSample: Int) -> Float {
        let s = max(0, fromSample)
        let e = min(samples.count, toSample)
        guard e > s else { return 0 }
        var sum: Float = 0
        for i in s..<e {
            sum += samples[i] * samples[i]
        }
        return sqrt(sum / Float(e - s))
    }
}
