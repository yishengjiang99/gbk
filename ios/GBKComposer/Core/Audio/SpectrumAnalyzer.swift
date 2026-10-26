import Accelerate
import AVFoundation

/// Whole-song mono PCM decoded from the mp3 the feed is playing, indexed by the player's clock.
/// Replaces the MTAudioProcessingTap: on device AVPlayer never ran the tap's process callback for the
/// remote progressive mp3 items, so the ring stayed all zeros and bars + waveform were a flat line.
final class DecodedPCM: @unchecked Sendable {
    let samples: [Float]
    let sampleRate: Double

    init(samples: [Float], sampleRate: Double) {
        self.samples = samples
        self.sampleRate = sampleRate > 0 ? sampleRate : 44_100
    }

    /// `count` samples ending at `seconds` (zero-padded outside the song), oldest first.
    func window(endingAt seconds: Double, count: Int) -> [Float] {
        var out = [Float](repeating: 0, count: count)
        guard seconds.isFinite, !samples.isEmpty else { return out }
        let end = Int((seconds * sampleRate).rounded(.down))
        let start = end - count
        let lo = max(start, 0), hi = min(end, samples.count)
        guard lo < hi else { return out }
        for i in lo..<hi { out[i - start] = samples[i] }
        return out
    }

    /// Decode any AVAudioFile-readable file (mp3, m4a, wav) to mono float (channel average).
    static func decode(fileURL: URL) throws -> DecodedPCM {
        let file = try AVAudioFile(forReading: fileURL, commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = file.processingFormat
        let channels = Int(format.channelCount)
        var mono = [Float]()
        mono.reserveCapacity(Int(max(file.length, 0)))
        let chunk: AVAudioFrameCount = 32_768
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { return DecodedPCM(samples: [], sampleRate: format.sampleRate) }
        while file.framePosition < file.length {
            try file.read(into: buf, frameCount: chunk)
            let n = Int(buf.frameLength)
            if n == 0 { break }
            guard let ch = buf.floatChannelData else { break }
            let scale = 1 / Float(max(channels, 1))
            for i in 0..<n {
                var v: Float = 0
                for c in 0..<channels { v += ch[c][i] }
                mono.append(v * scale)
            }
        }
        return DecodedPCM(samples: mono, sampleRate: format.sampleRate)
    }

    /// Download `url` (or read it if it's a file URL) and decode it off the main thread.
    static func load(url: URL) async throws -> DecodedPCM {
        if url.isFileURL { return try await Task.detached(priority: .utility) { try decode(fileURL: url) }.value }
        let (tmp, _) = try await URLSession.shared.download(from: url)
        let ext = url.pathExtension.isEmpty ? "mp3" : url.pathExtension
        let local = FileManager.default.temporaryDirectory.appendingPathComponent("viz-\(UUID().uuidString).\(ext)")
        try FileManager.default.moveItem(at: tmp, to: local)
        defer { try? FileManager.default.removeItem(at: local) }
        return try await Task.detached(priority: .utility) { try decode(fileURL: local) }.value
    }
}

/// Pull-based analyzer: the card's TimelineView calls `bars(now:)` once per frame.
/// Not ObservableObject on purpose: per-frame values never go through SwiftUI state.
final class SpectrumAnalyzer {
    private let log2n: vDSP_Length
    private let n: Int
    private let setup: FFTSetup
    private var window: [Float]
    private var levels = [Float](repeating: 0, count: FeedVisuals.barCount)
    private var bands: [Range<Int>] = []
    private var bandsRate: Double = 0
    private var lastTime: Double?
    /// Decoded audio of the playing item and the player's clock (seconds); both nil → silence.
    var source: DecodedPCM?
    var clock: (() -> Double?)?

    init(fftSize: Int = FeedVisuals.fftSize) {
        n = fftSize
        log2n = vDSP_Length(log2(Double(fftSize)))
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: fftSize)
        vDSP_hann_window(&window, vDSP_Length(fftSize), Int32(vDSP_HANN_NORM))
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func reset() { levels = [Float](repeating: 0, count: FeedVisuals.barCount); lastTime = nil }

    /// Smoothed 0...1 levels for `FeedVisuals.barCount` log-spaced bars.
    func bars(now: Double) -> [Float] {
        let dt = lastTime.map { now - $0 } ?? 0
        lastTime = now
        guard let source, let samples = latestSamples() else {
            levels = SpectrumMath.smooth(previous: levels, target: levels.map { _ in 0 }, dt: dt); return levels
        }
        if source.sampleRate != bandsRate {
            bandsRate = source.sampleRate
            bands = SpectrumMath.logBands(fftSize: n, sampleRate: bandsRate)
        }
        let target = SpectrumMath.levels(powers: powerSpectrum(samples), bands: bands)
        levels = SpectrumMath.smooth(previous: levels, target: target, dt: dt)
        return levels
    }

    /// The `fftSize` samples leading up to the playhead (what web's AnalyserNode sees), or nil before decode.
    func latestSamples() -> [Float]? {
        guard let source, let t = clock?() else { return nil }
        return source.window(endingAt: t, count: n)
    }

    /// 256-point waveform at the playhead (web getFloatTimeDomainData), flat before decode.
    func waveform() -> [Float] {
        latestSamples().map { WaveformMath.points($0) } ?? [Float](repeating: 0, count: FeedVisuals.waveformPoints)
    }

    func powerSpectrum(_ samples: [Float]) -> [Float] {
        guard samples.count == n else { return [Float](repeating: 0, count: n / 2) }
        var windowed = [Float](repeating: 0, count: n)
        vDSP_vmul(samples, 1, window, 1, &windowed, 1, vDSP_Length(n))
        var real = [Float](repeating: 0, count: n / 2)
        var imag = [Float](repeating: 0, count: n / 2)
        var mags = [Float](repeating: 0, count: n / 2)
        real.withUnsafeMutableBufferPointer { rp in
            imag.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                windowed.withUnsafeBufferPointer { wp in
                    wp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvmags(&split, 1, &mags, 1, vDSP_Length(n / 2))
            }
        }
        // zrip output is scaled by 2; normalise so a full-scale sine is ~0 dB.
        var scale = 1 / Float(n * n / 4)
        vDSP_vsmul(mags, 1, &scale, &mags, 1, vDSP_Length(n / 2))
        mags[0] = 0 // DC (real part packs Nyquist into imag[0])
        return mags
    }
}
