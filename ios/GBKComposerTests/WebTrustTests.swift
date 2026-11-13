import WebKit
import XCTest
@testable import GBKComposer

/// Real WKWebView: a page on another origin gets neither the guest credential nor MIDI input.
@MainActor
final class WebTrustTests: XCTestCase {
    private let page = "<html><body><script>window.done = true; try { navigator.requestMIDIAccess(); } catch (e) {}</script></body></html>"

    private func load(_ base: String) async throws -> (WKWebView, MIDIBridge) {
        let config = WKWebViewConfiguration()
        HumBridge.install(on: config, bridge: HumBridge())
        let midi = MIDIBridge.install(in: config)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: config)
        midi.webView = web
        web.loadHTMLString(page, baseURL: URL(string: base))
        let host = URL(string: base)!.host!
        let deadline = Date().addingTimeInterval(120) // a busy CI simulator can take long to commit the page
        while Date() < deadline {
            let ok = try? await web.evaluateJavaScript("location.host === '\(host)' && window.done === true") as? Bool
            if ok == true { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        try await Task.sleep(for: .milliseconds(500)) // let a posted MIDI request reach native
        return (web, midi)
    }

    func testForeignOriginGetsNoCredentialOrMIDI() async throws {
        let (web, midi) = try await load("https://evil.example/")
        let native = try await web.evaluateJavaScript("typeof window.gbkNative") as? String
        XCTAssertEqual(native, "undefined")
        XCTAssertFalse(midi.requested)
    }

    func testComposeOriginGetsBridges() async throws {
        let (web, midi) = try await load("https://compose.grepawk.com/studio")
        let device = try await web.evaluateJavaScript("typeof window.gbkNative.deviceId") as? String
        XCTAssertEqual(device, "string")
        XCTAssertTrue(midi.requested)
    }
}
