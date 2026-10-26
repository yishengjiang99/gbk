import Accelerate
import AVFoundation

/// One song as PCM in memory: `buffer` is what AVAudioPlayerNode plays, `samples` is its mono mixdown that the
/// spectrum + waveform read at the node's clock. Same audio, same timeline, no tap needed.
final class DecodedPCM: @unchecked Sendable {
    let samples: [Float]
    let sampleRate: Double
    let buffer: AVAudioPCMBuffer?

    init(samples: [Float], sampleRate: Double, buffer: AVAudioPCMBuffer? = nil) {
        self.samples = samples
        self.sampleRate = sampleRate > 0 ? sampleRate : 44_100
        self.buffer = buffer
    }

    var duration: Double { Double(samples.count) / sampleRate }

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

    /// Read a WAV (or, as fallback, MP3/M4A) file into one float PCM buffer plus its mono mixdown.
    static func decode(fileURL: URL) throws -> DecodedPCM {
        let file = try AVAudioFile(forReading: fileURL, commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = file.processingFormat
        let frames = AVAudioFrameCount(max(file.length, 0))
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
            return DecodedPCM(samples: [], sampleRate: format.sampleRate)
        }
        try file.read(into: buf)
        let n = Int(buf.frameLength), channels = Int(format.channelCount)
        var mono = [Float](repeating: 0, count: n)
        if let ch = buf.floatChannelData, channels > 0 {
            let scale = 1 / Float(channels)
            mono.withUnsafeMutableBufferPointer { m in
                guard let mp = m.baseAddress else { return }
                for c in 0..<channels { vDSP_vadd(mp, 1, ch[c], 1, mp, 1, vDSP_Length(n)) }
                var k = scale
                vDSP_vsmul(mp, 1, &k, mp, 1, vDSP_Length(n))
            }
        }
        return DecodedPCM(samples: mono, sampleRate: format.sampleRate, buffer: buf)
    }

    /// Download `url` (or read it if it's a file URL) and decode it off the main thread.
    static func load(url: URL) async throws -> DecodedPCM {
        if url.isFileURL { return try await Task.detached(priority: .userInitiated) { try decode(fileURL: url) }.value }
        let (tmp, _) = try await URLSession.shared.download(from: url)
        let ext = url.lastPathComponent == "wav" || url.pathExtension == "wav" ? "wav"
            : (url.lastPathComponent == "mp3" ? "mp3" : (url.pathExtension.isEmpty ? "wav" : url.pathExtension))
        let local = FileManager.default.temporaryDirectory.appendingPathComponent("feed-\(UUID().uuidString).\(ext)")
        try FileManager.default.moveItem(at: tmp, to: local)
        defer { try? FileManager.default.removeItem(at: local) }
        return try await Task.detached(priority: .userInitiated) { try decode(fileURL: local) }.value
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
