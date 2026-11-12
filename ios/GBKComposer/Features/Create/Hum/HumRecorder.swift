import AVFoundation

/// Mic capture for Hum: AVAudioEngine input tap → mono float → 22,050 Hz (Basic Pitch rate). Auto-stops at 60 s.
/// The audio session (AudioSessionController) is playAndRecord/.default only while recording, then `.playback`.
///
/// Each take gets a fresh engine: a reused engine keeps the input format it first saw, and installing a tap with a
/// stale format after a route change (AirPods, 48 → 16 kHz) is an AVFAudio exception. If the hardware changes mid-take
/// the engine stops itself; we restart it on the new format and keep each stretch as its own segment (own rate).
/// An interruption (call, Siri) ends the take through `onAutoStop`, keeping what was captured.
@MainActor
final class HumRecorder {
    static let maxSeconds = 60.0
    static let targetRate = 22_050.0
    private static let maxRestarts = 3

    /// A stretch of capture at one input sample rate.
    struct Segment: Sendable { let rate: Double; var samples: [Float] }

    private var engine: AVAudioEngine?
    private var segments: [Segment] = []
    private var restarts = 0
    private var observers: [NSObjectProtocol] = []
    private(set) var isRecording = false
    var onAutoStop: (() -> Void)?
    var elapsed: Double { segments.reduce(0) { $0 + Double($1.samples.count) / $1.rate } }

    enum RecordError: Error { case denied, unavailable(String) }

    static func requestPermission() async -> Bool {
        await withCheckedContinuation { c in AVAudioApplication.requestRecordPermission { c.resume(returning: $0) } }
    }

    func start() throws {
        guard !isRecording else { return }
        do {
            try AudioSessionController.shared.beginRecording("hum")
        } catch {
            Self.restoreSession()
            throw RecordError.unavailable(error.localizedDescription)
        }
        segments = []
        restarts = 0
        do { try startEngine() } catch { Self.restoreSession(); throw error }
        isRecording = true
        observe()
    }

    private func startEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecordError.unavailable("no microphone input") }
        let seg = segments.count
        segments.append(Segment(rate: format.sampleRate, samples: []))
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let ch = buffer.floatChannelData?[0] else { return }
            let data = Array(UnsafeBufferPointer(start: ch, count: Int(buffer.frameLength)))
            Task { @MainActor in
                guard let self, self.isRecording, seg < self.segments.count else { return }
                self.segments[seg].samples.append(contentsOf: data)
                if self.elapsed >= Self.maxSeconds { self.onAutoStop?() }
            }
        }
        do { try engine.start() } catch {
            input.removeTap(onBus: 0); segments.removeLast()
            throw RecordError.unavailable(error.localizedDescription)
        }
        self.engine = engine
    }

    private func observe() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
                let source = note.object.map { ObjectIdentifier($0 as AnyObject) }
                Task { @MainActor in self?.engineChanged(source) }
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
                Task { @MainActor in if began, self?.isRecording == true { self?.onAutoStop?() } }
            },
        ]
    }

    /// The hardware changed under the running engine (it has stopped itself): resume on the new format.
    private func engineChanged(_ source: ObjectIdentifier?) {
        guard isRecording, let old = engine, source == ObjectIdentifier(old), !old.isRunning else { return }
        old.inputNode.removeTap(onBus: 0)
        engine = nil
        restarts += 1
        do {
            guard restarts <= Self.maxRestarts else { throw RecordError.unavailable("audio route kept changing") }
            try startEngine()
        } catch {
            onAutoStop?() // transcribe what we have
        }
    }

    /// Stops capture and returns the raw take (≤ 60 s); `resample(_:)` it off the main thread.
    func stop() -> [Segment] {
        guard isRecording else { return [] }
        isRecording = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        Self.restoreSession()
        var left = Self.maxSeconds
        let take = segments.map { s -> Segment in
            let keep = min(s.samples.count, max(0, Int(left * s.rate)))
            left -= Double(keep) / s.rate
            return Segment(rate: s.rate, samples: Array(s.samples.prefix(keep)))
        }
        segments = []
        return take
    }

    static func restoreSession() {
        AudioSessionController.shared.endRecording("hum")
    }

    /// A take's segments → one 22,050 Hz mono stream.
    nonisolated static func resample(_ segments: [Segment]) -> [Float] {
        segments.flatMap { resample($0.samples, from: $0.rate) }
    }

    /// Linear-interpolated resample after a simple box low-pass (enough for monophonic hum pitch detection).
    nonisolated static func resample(_ x: [Float], from rate: Double, to target: Double = targetRate) -> [Float] {
        guard !x.isEmpty, rate > 0 else { return [] }
        if abs(rate - target) < 1 { return x }
        let ratio = rate / target
        var src = x
        if ratio > 1.5 { // anti-alias: moving average over ~ratio samples
            let k = max(1, Int(ratio.rounded()))
            var acc: Float = 0; src = [Float](repeating: 0, count: x.count)
            for i in x.indices { acc += x[i]; if i >= k { acc -= x[i - k] }; src[i] = acc / Float(min(i + 1, k)) }
        }
        let n = Int((Double(x.count) / ratio).rounded())
        return (0..<n).map { i in
            let p = Double(i) * ratio, j = Int(p), f = Float(p - Double(j))
            let a = src[min(j, src.count - 1)], b = src[min(j + 1, src.count - 1)]
            return a + (b - a) * f
        }
    }

    /// Reads a WAV/CAF file to 22,050 Hz mono (UI-test fixture path; the simulator mic is silent).
    nonisolated static func load(url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let fmt = file.processingFormat
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(file.length)) else { return [] }
        try file.read(into: buf)
        guard let ch = buf.floatChannelData?[0] else { return [] }
        return resample(Array(UnsafeBufferPointer(start: ch, count: Int(buf.frameLength))), from: fmt.sampleRate)
    }
}
