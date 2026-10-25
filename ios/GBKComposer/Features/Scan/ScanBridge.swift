import Foundation
import WebKit

/// Studio <-> native contract for Scan (see docs/ios/scan.md "Web contract").
///   native -> web at document start (HumBridge.capabilityScript, shared): window.gbkNative.capabilities includes "scan" (and .scan === true)
///   web -> native: webkit.messageHandlers.gbkScan.postMessage({type: "scan.start", project: {ppq, channels, noteCount, readOnly, readOnlyReason?}})
///   native -> web: window.gbkStudio.applyNativeOps(ops, {label: "scan sheet music", source: "scan"}) -> {ok, revision?, error?}
///                  window.dispatchEvent(new CustomEvent("gbknative:scan", {detail: {status, tracks?, notes?, error?}}))
enum ScanBridge {
    static let handlerName = "gbkScan"
    static let label = "scan sheet music"

    /// The capability flag lives in the shared `window.gbkNative` object HumBridge injects (it is frozen).
    static var userScript: String { HumBridge.capabilityScript }

    struct Message: Decodable, Equatable {
        var type: String
        var project: StudioProjectInfo?
    }

    static func decode(_ body: Any) -> Message? {
        guard JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        return try? JSONDecoder().decode(Message.self, from: data)
    }

    static func applyScript(ops: [StudioOp]) throws -> String {
        let opsJSON = try ScoreOps.json(ops)
        return """
        (function(){ var s = window.gbkStudio; if (!s || typeof s.applyNativeOps !== 'function') return JSON.stringify({ok:false,error:'studio bridge missing'});
        try { var r = s.applyNativeOps(\(opsJSON), {label: \(jsString(label)), source: 'scan'}); return JSON.stringify(r || {ok:true}); }
        catch (e) { return JSON.stringify({ok:false,error:String(e && e.message || e)}); } })()
        """
    }

    static func eventScript(status: String, tracks: Int? = nil, notes: Int? = nil, error: String? = nil) -> String {
        var d: [String: Any] = ["status": status]
        if let tracks { d["tracks"] = tracks }
        if let notes { d["notes"] = notes }
        if let error { d["error"] = error }
        let json = (try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return "window.dispatchEvent(new CustomEvent('gbknative:scan', {detail: \(json)}));"
    }

    static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    struct ApplyResult: Decodable { var ok: Bool; var error: String? }
}

/// Owns the scan sheet state and talks to the web view.
@MainActor
final class ScanController: NSObject, ObservableObject, WKScriptMessageHandler {
    enum Phase: Equatable { case choose, working, error(ScanError), done(tracks: Int, notes: Int) }

    @Published var isPresented = false
    @Published var phase: Phase = .choose
    private(set) var project: StudioProjectInfo?
    weak var webView: WKWebView?
    let recognizer: SheetRecognizer

    init(recognizer: SheetRecognizer = HomrSheetRecognizer()) { self.recognizer = recognizer }

    func install(on config: WKWebViewConfiguration) {
        config.userContentController.add(WeakScriptHandler(self), name: ScanBridge.handlerName)
    }

    nonisolated func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        let msg = ScanBridge.decode(message.body)
        Task { @MainActor in self.handle(msg) }
    }

    func handle(_ msg: ScanBridge.Message?) {
        guard let msg, msg.type == "scan.start" else { return }
        project = msg.project
        phase = (msg.project?.readOnly ?? false) ? .error(.readOnlyProject) : .choose
        isPresented = true
    }

    func fail(_ e: ScanError) { phase = .error(e) }

    func recognize(_ pages: [SheetPage]) {
        guard !pages.isEmpty else { return }
        phase = .working
        Task {
            do {
                let score = try await recognizer.recognize(pages: pages)
                let ops = try ScoreOps.ops(for: score, project: project ?? StudioProjectInfo(ppq: 480, channels: [], noteCount: 0, readOnly: false))
                try await apply(ops)
                let tracks = ops.filter { if case .addTrack = $0 { return true }; return false }.count
                phase = .done(tracks: tracks, notes: score.noteCount)
                webView?.evaluateJavaScript(ScanBridge.eventScript(status: "added", tracks: tracks, notes: score.noteCount), completionHandler: nil)
                try? await Task.sleep(nanoseconds: 900_000_000)
                if case .done = phase { isPresented = false }
            } catch let e as ScanError {
                phase = .error(e)
            } catch {
                phase = .error(.failed(error.localizedDescription))
            }
        }
    }

    private func apply(_ ops: [StudioOp]) async throws {
        guard let webView else { throw ScanError.failed("the studio isn't loaded") }
        let raw = try await webView.evaluateJavaScript(try ScanBridge.applyScript(ops: ops))
        guard let s = raw as? String, let r = try? JSONDecoder().decode(ScanBridge.ApplyResult.self, from: Data(s.utf8)) else { return }
        if !r.ok {
            if r.error == "studio bridge missing" { throw ScanError.studioNotReady }
            if (r.error ?? "").uppercased().contains("READ_ONLY") || (r.error ?? "").lowercased().contains("read-only") { throw ScanError.readOnlyProject }
            throw ScanError.failed(r.error ?? "the studio rejected the new tracks")
        }
    }

    func cancel() {
        isPresented = false
        webView?.evaluateJavaScript(ScanBridge.eventScript(status: "cancelled"), completionHandler: nil)
    }
}

/// WKUserContentController retains its handlers; break the cycle.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
