import AVFoundation

/// Mic capture for Hum: AVAudioEngine input tap → mono float → 22,050 Hz (Basic Pitch rate). Auto-stops at 60 s.
/// The audio session is playAndRecord only while recording, then restored to the feed's `.playback`.
@MainActor
final class HumRecorder {
    static let maxSeconds = 60.0
    static let targetRate = 22_050.0

    private let engine = AVAudioEngine()
    private var chunks: [Float] = []
    private var inputRate = 48_000.0
    private(set) var isRecording = false
    var onAutoStop: (() -> Void)?
    var elapsed: Double { Double(chunks.count) / inputRate }

    enum RecordError: Error { case denied, unavailable(String) }

    static func requestPermission() async -> Bool {
        await withCheckedContinuation { c in AVAudioApplication.requestRecordPermission { c.resume(returning: $0) } }
    }

    func start() throws {
        guard !isRecording else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
            try session.setActive(true)
        } catch { throw RecordError.unavailable(error.localizedDescription) }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            Self.restoreSession(); throw RecordError.unavailable("no microphone input")
        }
        inputRate = format.sampleRate
        chunks = []
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let ch = buffer.floatChannelData?[0] else { return }
            let data = Array(UnsafeBufferPointer(start: ch, count: Int(buffer.frameLength)))
            Task { @MainActor in
                guard let self, self.isRecording else { return }
                self.chunks.append(contentsOf: data)
                if self.elapsed >= Self.maxSeconds { self.onAutoStop?() }
            }
        }
        do { try engine.start() } catch {
            input.removeTap(onBus: 0); Self.restoreSession(); throw RecordError.unavailable(error.localizedDescription)
        }
        isRecording = true
    }

    /// Stops capture and returns the take at 22,050 Hz mono.
    func stop() -> (samples: [Float], seconds: Double) {
        guard isRecording else { return ([], 0) }
        isRecording = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        Self.restoreSession()
        let seconds = min(elapsed, Self.maxSeconds)
        let take = Array(chunks.prefix(Int(Self.maxSeconds * inputRate)))
        chunks = []
        return (Self.resample(take, from: inputRate), seconds)
    }

    static func restoreSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        FeedPlayer.configureAudioSession()
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
        let n = Int(Double(x.count) / ratio)
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
