import Accelerate
import AVFoundation
import MediaToolbox

/// Lock-protected mono sample ring filled from the audio render thread by an MTAudioProcessingTap.
final class AudioTapSink: @unchecked Sendable {
    private let lock = NSLock()
    private var ring: [Float]
    private var writeIndex = 0
    private(set) var sampleRate: Double = 44_100
    private var channels = 1
    private var interleaved = false
    /// Host time of the last render callback; the tap is "live" only while buffers keep arriving.
    private var lastPush: CFAbsoluteTime = 0
    var isLive: Bool { lock.lock(); defer { lock.unlock() }; return CFAbsoluteTimeGetCurrent() - lastPush < 0.25 }

    init(capacity: Int = FeedVisuals.fftSize * 2) { ring = [Float](repeating: 0, count: capacity) }

    func prepare(_ asbd: AudioStreamBasicDescription) {
        lock.lock(); defer { lock.unlock() }
        sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 44_100
        channels = max(Int(asbd.mChannelsPerFrame), 1)
        interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    }

    /// Render thread: copy the first channel of float32 audio.
    func push(_ list: UnsafeMutablePointer<AudioBufferList>, frames: Int) {
        let abl = UnsafeMutableAudioBufferListPointer(list)
        guard let buf = abl.first, let data = buf.mData, frames > 0 else { return }
        let samples = data.assumingMemoryBound(to: Float.self)
        lock.lock(); defer { lock.unlock() }
        let stride = interleaved ? channels : 1
        let available = Int(buf.mDataByteSize) / MemoryLayout<Float>.size / stride
        let n = min(frames, available)
        lastPush = CFAbsoluteTimeGetCurrent()
        for i in 0..<n {
            ring[writeIndex] = samples[i * stride]
            writeIndex = (writeIndex + 1) % ring.count
        }
    }

    /// Most recent `count` samples, oldest first.
    func latest(_ count: Int) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let n = min(count, ring.count)
        var out = [Float](repeating: 0, count: n)
        var r = (writeIndex - n + ring.count) % ring.count
        for i in 0..<n { out[i] = ring[r]; r = (r + 1) % ring.count }
        return out
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        for i in ring.indices { ring[i] = 0 }
        lastPush = 0
    }

    /// AVAudioMix that installs a post-effects tap on `track` feeding this sink.
    func makeAudioMix(for track: AVAssetTrack) -> AVAudioMix? {
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(self).toOpaque()),
            init: { _, clientInfo, storageOut in storageOut.pointee = clientInfo },
            finalize: { tap in
                Unmanaged<AudioTapSink>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
            },
            prepare: { tap, _, asbd in
                Unmanaged<AudioTapSink>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().prepare(asbd.pointee)
            },
            unprepare: nil,
            process: { tap, frames, _, bufferList, framesOut, flagsOut in
                guard MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, nil, framesOut) == noErr else { return }
                Unmanaged<AudioTapSink>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                    .push(bufferList, frames: Int(framesOut.pointee))
            })
        var tap: MTAudioProcessingTap?
        guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) == noErr,
              let tap else {
            Unmanaged<AudioTapSink>.fromOpaque(callbacks.clientInfo!).release()
            return nil
        }
        let params = AVMutableAudioMixInputParameters(track: track)
        params.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [params]
        return mix
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
    /// Primary source: MTAudioProcessingTap on the AVPlayerItem. On some devices/streams the tap never
    /// renders (TestFlight build 4 showed a blank spectrum), so `pcm` (the same mp3 decoded off the main
    /// thread) is read at AVPlayer's current time whenever the tap isn't delivering buffers.
    var sink: AudioTapSink?
    var pcm: DecodedPCM?

    init(fftSize: Int = FeedVisuals.fftSize) {
        n = fftSize
        log2n = vDSP_Length(log2(Double(fftSize)))
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: fftSize)
        vDSP_hann_window(&window, vDSP_Length(fftSize), Int32(vDSP_HANN_NORM))
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func reset() { levels = [Float](repeating: 0, count: FeedVisuals.barCount); lastTime = nil }

    /// The most recent `fftSize` mono samples ending at `mediaTime`, plus their sample rate; nil when no source has audio.
    func latestSamples(mediaTime: Double?) -> (samples: [Float], rate: Double)? {
        if let sink, sink.isLive { return (sink.latest(n), sink.sampleRate) }
        if let pcm, let t = mediaTime, let w = pcm.window(endingAt: t, count: n) { return (w, pcm.sampleRate) }
        return nil
    }

    /// One viz frame: smoothed 0...1 levels for the 48 log-spaced bars and the raw samples for the waveform.
    func frame(now: Double, mediaTime: Double?) -> (levels: [Float], samples: [Float]?) {
        let dt = lastTime.map { now - $0 } ?? 0
        lastTime = now
        guard let src = latestSamples(mediaTime: mediaTime) else {
            levels = SpectrumMath.smooth(previous: levels, target: levels.map { _ in 0 }, dt: dt)
            return (levels, nil)
        }
        if src.rate != bandsRate {
            bandsRate = src.rate
            bands = SpectrumMath.logBands(fftSize: n, sampleRate: bandsRate)
        }
        let target = SpectrumMath.levels(powers: powerSpectrum(src.samples), bands: bands)
        levels = SpectrumMath.smooth(previous: levels, target: target, dt: dt)
        return (levels, src.samples)
    }

    func bars(now: Double, mediaTime: Double? = nil) -> [Float] { frame(now: now, mediaTime: mediaTime).levels }

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

/// The active song decoded to mono float PCM (download + AVAudioFile), indexed by media time.
final class DecodedPCM: @unchecked Sendable {
    let samples: [Float]
    let sampleRate: Double

    init(samples: [Float], sampleRate: Double) { self.samples = samples; self.sampleRate = sampleRate }

    /// `count` samples ending at `t` seconds (zero-padded before the start); nil past the end.
    func window(endingAt t: Double, count: Int) -> [Float]? {
        guard t.isFinite, !samples.isEmpty else { return nil }
        let end = Int(t * sampleRate)
        guard end > 0, end <= samples.count + count else { return nil }
        var out = [Float](repeating: 0, count: count)
        let start = end - count
        for i in 0..<count {
            let j = start + i
            if j >= 0 && j < samples.count { out[i] = samples[j] }
        }
        return out
    }

    static func load(url: URL) async -> DecodedPCM? {
        let ext = url.pathExtension.isEmpty ? "mp3" : url.pathExtension
        var file = url
        var temp: URL?
        if !url.isFileURL {
            guard let (downloaded, _) = try? await URLSession.shared.download(from: url) else { return nil }
            let dst = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
            guard (try? FileManager.default.moveItem(at: downloaded, to: dst)) != nil else { return nil }
            file = dst; temp = dst
        }
        defer { if let temp { try? FileManager.default.removeItem(at: temp) } }
        let source = file
        return await Task.detached(priority: .utility) { decode(source) }.value
    }

    static func decode(_ url: URL) -> DecodedPCM? {
        guard let f = try? AVAudioFile(forReading: url) else { return nil }
        let format = f.processingFormat
        let total = AVAudioFrameCount(f.length)
        guard total > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: total),
              (try? f.read(into: buf)) != nil, let ch = buf.floatChannelData else { return nil }
        let frames = Int(buf.frameLength), chans = Int(format.channelCount)
        var mono = [Float](repeating: 0, count: frames)
        for c in 0..<chans { vDSP_vadd(mono, 1, ch[c], 1, &mono, 1, vDSP_Length(frames)) }
        if chans > 1 { var k = 1 / Float(chans); vDSP_vsmul(mono, 1, &k, &mono, 1, vDSP_Length(frames)) }
        return DecodedPCM(samples: mono, sampleRate: format.sampleRate)
    }
}
