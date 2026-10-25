// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendored from yishengjiang99/earsheet @ 357cb76 Packages/HearSheet (Yisheng Jiang). Only the pieces Hum needs.
import Foundation

/// A detected note: onset/offset in seconds, MIDI pitch, strike velocity.
public struct NoteEvent: Equatable, Sendable, Codable, Hashable {
    public var onset: Double
    public var offset: Double
    public var midi: Int
    public var velocity: Int
    public init(onset: Double, offset: Double, midi: Int, velocity: Int = 80) {
        self.onset = onset
        self.offset = offset
        self.midi = midi
        self.velocity = velocity
    }
    public var duration: Double { max(0, offset - onset) }
}

public enum HearSheet {
    public static let bundleIdentifier = "com.ragnus.pnge"
    public static let modelName = "BasicPitchPoly"
    /// Model contract (BasicPitch_nmp): mono 22050 Hz waveform in, posteriorgrams out.
    public static let sampleRate = 22050.0
    public static let windowSamples = 43844
    public static let outputFrames = 172
    public static let pitchBins = 88
    public static let contourBins = 264
    /// Basic Pitch MIDI range: A0 (21) .. C8 (108).
    public static let minMIDI = 21
    public static let maxMIDI = 108
}
