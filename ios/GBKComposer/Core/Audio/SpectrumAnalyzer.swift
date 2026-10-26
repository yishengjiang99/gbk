import Accelerate
import AVFoundation
import QuartzCore

/// Mono ring of the engine's live output, filled by an `installTap` on the feed player's main mixer.
/// Tap buffers arrive in blocks (~10-100 ms); `latest` slides through the newest block by wall clock so the
/// waveform and bars move every frame instead of jumping per block.
final class OutputScope: @unchecked Sendable {
    private let lock = NSLock()
    private var ring: [Float]
    private var written = 0          // total frames ever written
    private var lastBlock = 0        // frames in the newest block
    private var lastBlockAt: CFTimeInterval = 0
    private(set) var sampleRate: Double = 44_100

    init(capacity: Int = 16_384) { ring = [Float](repeating: 0, count: capacity) }

    /// Tap thread: push one block of non-interleaved float audio (channels averaged).
    func push(_ buffer: AVAudioPCMBuffer, at now: CFTimeInterval = CACurrentMediaTime()) {
        guard let ch = buffer.floatChannelData else { return }
        let n = Int(buffer.frameLength), c = Int(buffer.format.channelCount)
        guard n > 0, c > 0 else { return }
        var mono = [Float](repeating: 0, count: n)
        mono.withUnsafeMutableBufferPointer { m in
            let mp = m.baseAddress!
            for k in 0..<c { vDSP_vadd(mp, 1, ch[k], 1, mp, 1, vDSP_Length(n)) }
            var s = 1 / Float(c)
            vDSP_vsmul(mp, 1, &s, mp, 1, vDSP_Length(n))
        }
        push(mono, sampleRate: buffer.format.sampleRate, at: now)
    }

    func push(_ mono: [Float], sampleRate rate: Double, at now: CFTimeInterval = CACurrentMediaTime()) {
        lock.lock(); defer { lock.unlock() }
        sampleRate = rate > 0 ? rate : 44_100
        let cap = ring.count
        for v in mono { ring[written % cap] = v; written += 1 }
        lastBlock = mono.count
        lastBlockAt = now
    }

    /// `count` samples ending at the interpolated "now" inside the newest block, oldest first.
    func latest(_ count: Int, now: CFTimeInterval = CACurrentMediaTime()) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let cap = ring.count, n = min(count, cap)
        var out = [Float](repeating: 0, count: n)
        guard written > 0 else { return out }
        let into = min(Double(lastBlock), max(0, (now - lastBlockAt) * sampleRate))
        let end = written - lastBlock + Int(into)
        for i in 0..<n {
            let idx = end - n + i
            if idx >= 0 && idx > written - cap { out[i] = ring[idx % cap] }
        }
        return out
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        for i in ring.indices { ring[i] = 0 }
        written = 0; lastBlock = 0
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
    /// Live output of the playing engine (tap); nil → silence.
    var source: OutputScope?

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
        guard let source, let samples = latestSamples(now: now) else {
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

    /// The newest `fftSize` output samples (what web's AnalyserNode sees), or nil before decode.
    func latestSamples(now: Double? = nil) -> [Float]? {
        guard let source else { return nil }
        return source.latest(n)
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
