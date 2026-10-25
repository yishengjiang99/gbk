import AVFoundation

/// Single owner of the app's AVAudioSession (feed AVPlayer, studio WKWebView, native Hum).
///
/// Normal use is `.playback` / `.default` (loudspeaker, plays with the silent switch on, like music apps).
/// Only while something records (native Hum, or the studio page's mic) is it `.playAndRecord` with
/// `.defaultToSpeaker` and mode `.default`. Never `.measurement` / `.voiceChat` / `.videoChat`: those modes add
/// voice processing or drop output gain, and playAndRecord without `.defaultToSpeaker` routes to the earpiece
/// receiver; both made playback "really quiet even at max volume" in TestFlight build 4.
///
/// WebKit can also rewrite the shared session when the page captures; a route-change observer re-asserts our
/// configuration and forces the speaker whenever output lands on the built-in receiver.
@MainActor
final class AudioSessionController {
    static let shared = AudioSessionController()

    enum Mode: Equatable { case playback, recording }

    struct Config: Equatable {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    nonisolated static func config(for mode: Mode) -> Config {
        switch mode {
        case .playback:
            return Config(category: .playback, mode: .default, options: [])
        case .recording:
            return Config(category: .playAndRecord, mode: .default,
                          options: [.defaultToSpeaker, .allowBluetoothA2DP, .allowBluetooth])
        }
    }

    /// Recorders currently holding the mic (e.g. "hum", "web-mic"); recording while non-empty.
    private(set) var recorders: Set<String> = []
    var mode: Mode { recorders.isEmpty ? .playback : .recording }
    private var routeObserver: NSObjectProtocol?
    private var reapplying = false

    private init() {}

    /// Call at launch: applies `.playback` and starts guarding the route.
    func start() {
        apply()
        guard routeObserver == nil else { return }
        let center = NotificationCenter.default
        routeObserver = center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in AudioSessionController.shared.enforce() }
        }
        _ = center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in AudioSessionController.shared.apply() }
        }
    }

    func beginRecording(_ id: String) throws {
        recorders.insert(id)
        try apply(throwing: true)
    }

    func endRecording(_ id: String) {
        guard recorders.remove(id) != nil else { return }
        apply()
    }

    /// Applies the current mode's configuration and activates the session.
    func apply() { try? apply(throwing: false) }

    private func apply(throwing: Bool) throws {
        let c = Self.config(for: mode)
        let session = AVAudioSession.sharedInstance()
        reapplying = true
        defer { reapplying = false }
        do {
            if session.category != c.category || session.mode != c.mode || session.categoryOptions != c.options {
                try session.setCategory(c.category, mode: c.mode, options: c.options)
            }
            try session.setActive(true)
        } catch {
            if throwing { throw error }
        }
        fixReceiverRoute()
    }

    /// Re-asserts our configuration if someone else (WebKit) changed it, and keeps output off the earpiece.
    func enforce() {
        guard !reapplying else { return }
        let c = Self.config(for: mode)
        let session = AVAudioSession.sharedInstance()
        if session.category != c.category || session.mode != c.mode
            || (mode == .playback && session.categoryOptions != c.options)
            || (mode == .recording && !session.categoryOptions.contains(.defaultToSpeaker)) {
            apply()
        } else {
            fixReceiverRoute()
        }
    }

    nonisolated static func isReceiver(_ route: AVAudioSessionRouteDescription) -> Bool {
        route.outputs.contains { $0.portType == .builtInReceiver }
    }

    private func fixReceiverRoute() {
        let session = AVAudioSession.sharedInstance()
        guard Self.isReceiver(session.currentRoute) else { return }
        if session.category == .playAndRecord { try? session.overrideOutputAudioPort(.speaker) }
    }
}
