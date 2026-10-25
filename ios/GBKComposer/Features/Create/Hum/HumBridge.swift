import UIKit
import WebKit

/// Native Hum for the studio web view. Contract (for GBK Social; see docs/social/STATUS.md "iOS native Hum"):
/// - Native injects `window.gbkNative = { platform: "ios", version: 1, capabilities: ["hum"] }` at document start.
/// - Web renders the mic button in the composer prompt bar when `gbkNative.capabilities` has "hum", and on tap
///   posts `webkit.messageHandlers.hum.postMessage({ type: "toggle" })`.
/// - Web exposes `window.gbkHum`:
///   - `context()` → `{ ppq, tempos: [{tick, microPerQuarter}], tracks: [{channel}], readOnlyReason: string|null }`
///   - `apply(ops, { label: "hum a melody", selectTrackId })` → `{ ok: true }` or `{ ok: false, error }`; one
///     `workstation.userEdit` (one undo step), then select the new track.
///   - `showReadOnlyHint(reason)` (web's readOnlyHintListeners) and `onState({ phase, elapsed, progress })`
///     with phase "idle" | "recording" | "transcribing" so the web button shows ⏺ 0:12 Stop / 🎤 42%.
/// Errors use web's HumButton wording, shown as native alerts (no native views over the web toolbar/input).
@MainActor
final class HumBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "hum"
    static let capabilityScript = #"window.gbkNative = Object.freeze({ platform: "ios", version: 1, capabilities: ["hum"] });"#

    enum Phase: String { case idle, recording, transcribing }

    weak var webView: WKWebView?
    private let recorder = HumRecorder()
    private(set) var phase: Phase = .idle
    private var ticker: Timer?
    /// UI tests: transcribe this file instead of the (silent) simulator mic.
    var fixtureURL: URL? = ProcessInfo.processInfo.arguments.contains("-uiTestHumFixture")
        ? Bundle.main.url(forResource: "hum-fixture", withExtension: "wav") : nil

    static func install(on config: WKWebViewConfiguration, bridge: HumBridge) {
        config.userContentController.addUserScript(WKUserScript(source: capabilityScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(WeakHandler(bridge), name: handlerName)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, Self.isTrusted(message.frameInfo.securityOrigin) else { return }
        guard (message.body as? [String: Any])?["type"] as? String == "toggle" else { return }
        Task { await toggle() }
    }

    static func isTrusted(_ origin: WKSecurityOrigin) -> Bool {
        (origin.protocol == "https" && origin.host == "compose.grepawk.com") || origin.protocol == "file"
    }

    func toggle() async {
        switch phase {
        case .idle: await start()
        case .recording: await stopAndTranscribe()
        case .transcribing: break
        }
    }

    private func start() async {
        let ctx = await context()
        if let reason = ctx.readOnlyReason {
            await js("window.gbkHum?.showReadOnlyHint?.(\(Self.jsonString(reason)))")
            return
        }
        if fixtureURL == nil {
            guard await HumRecorder.requestPermission() else {
                alert("Microphone access was denied. Allow microphone access for GBK in Settings, then tap Hum again.")
                return
            }
            do { try recorder.start() } catch {
                alert("Could not start recording: \(error)")
                return
            }
            recorder.onAutoStop = { [weak self] in Task { await self?.stopAndTranscribe() } }
        }
        setPhase(.recording)
        ticker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.report() }
        }
    }

    private func stopAndTranscribe() async {
        guard phase == .recording else { return }
        ticker?.invalidate(); ticker = nil
        setPhase(.transcribing)
        defer { setPhase(.idle) }
        let take: (samples: [Float], seconds: Double)
        if let fixtureURL {
            let s = (try? HumRecorder.load(url: fixtureURL)) ?? []
            take = (s, Double(s.count) / HumRecorder.targetRate)
        } else {
            take = recorder.stop()
        }
        if take.seconds < 0.3 || take.samples.isEmpty {
            alert("That take was too short to transcribe — hum a few notes, then tap Stop.")
            return
        }
        do {
            let notes = try await HumTranscriber.transcribe(take.samples) { f in
                Task { @MainActor [weak self] in self?.report(progress: f) }
            }
            guard !notes.isEmpty else {
                alert("No melody detected in that take — try humming a clear, single tune closer to the microphone.")
                return
            }
            let ctx = await context()
            let trackId = HumNotesToOps.newTrackId()
            let ops = HumNotesToOps.ops(project: ctx, notes: notes, trackId: trackId)
            let r = await js("return window.gbkHum ? window.gbkHum.apply(\(Self.jsonString(ops.map(\.json))), { label: 'hum a melody', selectTrackId: \(Self.jsonString(trackId)) }) : { ok: false, error: 'This page does not support native Hum yet.' }")
            if let d = r as? [String: Any], d["ok"] as? Bool != true {
                alert("Transcription failed: \(d["error"] as? String ?? "the studio rejected the notes")")
            }
        } catch {
            alert("Transcription failed: \(error)")
        }
    }

    private func setPhase(_ p: Phase) { phase = p; report() }

    private func report(progress: Double = 0) {
        let e = phase == .recording ? (fixtureURL == nil ? recorder.elapsed : 0) : 0
        Task { await js("window.gbkHum?.onState?.({ phase: '\(phase.rawValue)', elapsed: \(e), progress: \(progress) })") }
    }

    private func context() async -> HumProjectContext {
        let r = await js("const c = window.gbkHum?.context?.(); return c ? JSON.stringify(c) : null")
        guard let s = r as? String, let data = s.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return HumProjectContext() }
        return Self.parseContext(raw)
    }

    nonisolated static func parseContext(_ raw: [String: Any]) -> HumProjectContext {
        var c = HumProjectContext()
        if let ppq = raw["ppq"] as? Int, ppq > 0 { c.ppq = ppq }
        if let t = raw["tempos"] as? [[String: Any]] {
            let tempos = t.compactMap { d -> HumTempo? in
                guard let tick = d["tick"] as? Int, let mpq = d["microPerQuarter"] as? Int, mpq > 0 else { return nil }
                return HumTempo(tick: tick, microPerQuarter: mpq)
            }
            if !tempos.isEmpty { c.tempos = tempos }
        }
        c.trackChannels = (raw["tracks"] as? [[String: Any]])?.compactMap { $0["channel"] as? Int } ?? []
        c.readOnlyReason = raw["readOnlyReason"] as? String
        return c
    }

    @discardableResult
    private func js(_ body: String) async -> Any? {
        guard let webView else { return nil }
        return try? await webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
    }

    static func jsonString(_ v: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])) ?? Data("null".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private func alert(_ message: String) {
        guard let webView else { return }
        var vc = webView.window?.rootViewController
        while let p = vc?.presentedViewController { vc = p }
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        vc?.present(a, animated: true)
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: (WKScriptMessageHandler & NSObject)?
    init(_ t: WKScriptMessageHandler & NSObject) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
