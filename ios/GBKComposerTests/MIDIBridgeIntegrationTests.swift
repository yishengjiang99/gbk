import CoreMIDI
import WebKit
import XCTest
@testable import GBKComposer

/// End to end: virtual CoreMIDI source (MIDISourceCreate) → MIDIInputHub → MIDIBridge → polyfilled
/// navigator.requestMIDIAccess in a real WKWebView, consumed the way web MidiInputManager does
/// (inputs.values(), addEventListener("midimessage"), onstatechange hot-plug).
@MainActor
final class MIDIBridgeIntegrationTests: XCTestCase {
    private let page = """
    <html><body><script>
    window.got = []; window.names = [];
    navigator.requestMIDIAccess({ sysex: false }).then(function (a) {
      function attach() { for (const i of a.inputs.values()) if (!i.__a && i.state !== "disconnected") { i.__a = 1;
        i.addEventListener("midimessage", function (e) { got.push({ name: i.name, d: Array.from(e.data), u8: e.data instanceof Uint8Array, t: e.timeStamp, now: performance.now() }); }); }
        window.names = Array.from(a.inputs.values()).map(function (i) { return i.name; }); }
      a.onstatechange = attach; attach(); window.ready = true;
    }, function (e) { window.err = String(e); });
    </script></body></html>
    """

    func testVirtualSourceNotesReachWebMIDIListener() async throws {
        let config = WKWebViewConfiguration()
        let bridge = MIDIBridge.install(in: config)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: config)
        bridge.webView = web
        web.loadHTMLString(page, baseURL: URL(string: "https://compose.grepawk.com/studio"))
        do { try await waitJS(web, "window.ready === true", "requestMIDIAccess resolved", timeout: 30) } catch {
            let diag = (try? await web.evaluateJavaScript("[typeof navigator.requestMIDIAccess, typeof window.__gbkMidi, typeof window.gbkMidiNative, document.readyState].join(',')")) as? String
            XCTFail("diag js=\(diag ?? "nil") requested=\(bridge.requested) started=\(bridge.hub.started) err=\(bridge.hub.lastError) devices=\(bridge.hub.devices.count)")
            throw error
        }
        let bt = try await web.evaluateJavaScript("typeof window.gbkMidiNative.openBluetoothPairing") as? String
        XCTAssertEqual(bt, "function")

        // Hot-plug: create the source after access is granted; onstatechange must announce it.
        // The iOS simulator refuses virtual endpoints (kMIDINotPermitted) without the "audio" background mode, which
        // the app doesn't declare. Then the same UMP words go through MIDIInputHub.ingestUMP (the CoreMIDI callback's
        // path after unpacking the event list) from a device injected through the bridge's hot-plug call.
        var client = MIDIClientRef(), src = MIDIEndpointRef()
        XCTAssertEqual(MIDIClientCreateWithBlock("GBK Test" as CFString, &client, nil), noErr)
        let status = MIDISourceCreateWithProtocol(client, "GBK Test Source" as CFString, ._1_0, &src)
        let virtual = status == noErr
        if !virtual {
            XCTAssertEqual(status, kMIDINotPermitted, "unexpected MIDISourceCreate error")
            bridge.sendDevices(bridge.hub.devices + [MIDIInputDevice(id: "coremidi-test", name: "GBK Test Source", manufacturer: "")])
        }
        try await waitJS(web, "window.names.indexOf('GBK Test Source') >= 0", "source announced via statechange")

        let words: [UInt32] = [0x2090_3C64, 0x20B0_407F, 0x20B0_0121, 0x20E0_0050, 0x2080_3C00, 0x20B0_4000]
        let t0 = Date()
        if virtual { send(src, words) } else { bridge.hub.ingestUMP(words, sourceID: "coremidi-test") }
        try await waitJS(web, "window.got.length >= 6", "6 messages delivered")
        let elapsed = Date().timeIntervalSince(t0) * 1000
        add(XCTAttachment(string: virtual ? "path: virtual CoreMIDI source" : "path: ingestUMP (simulator: kMIDINotPermitted)"))
        print(virtual ? "MIDI integration path: virtual CoreMIDI source" : "MIDI integration path: ingestUMP (kMIDINotPermitted)")

        let got = try await web.evaluateJavaScript("JSON.stringify(window.got)") as! String
        let events = try JSONSerialization.jsonObject(with: Data(got.utf8)) as! [[String: Any]]
        XCTAssertEqual(events.map { $0["d"] as! [Int] }, [[0x90, 60, 100], [0xB0, 64, 127], [0xB0, 1, 33], [0xE0, 0, 80], [0x80, 60, 0], [0xB0, 64, 0]])
        XCTAssertTrue(events.allSatisfy { $0["u8"] as? Bool == true && $0["name"] as? String == "GBK Test Source" })
        for e in events { XCTAssertLessThanOrEqual(e["t"] as! Double, (e["now"] as! Double) + 0.01) }

        let lat = bridge.latencies
        let summary = String(format: "MIDI bridge latency: send→JS %.2f ms; CoreMIDI stamp→evaluateJavaScript done avg %.2f max %.2f ms over %d batches",
                             elapsed, lat.reduce(0, +) / Double(max(lat.count, 1)), lat.max() ?? 0, lat.count)
        print(summary)
        let a = XCTAttachment(string: summary); a.name = "midi-latency"; a.lifetime = .keepAlways; add(a)
        XCTAssertFalse(lat.isEmpty)

        // Hot-unplug.
        if virtual { MIDIEndpointDispose(src) } else { bridge.sendDevices(bridge.hub.devices) }
        try await waitJS(web, "window.names.indexOf('GBK Test Source') < 0", "source removed via statechange", timeout: 5)
        MIDIClientDispose(client)
    }

    private func send(_ src: MIDIEndpointRef, _ words: [UInt32]) {
        var list = MIDIEventList()
        var packet = MIDIEventListInit(&list, ._1_0)
        for w in words {
            var word = w
            packet = MIDIEventListAdd(&list, MemoryLayout<MIDIEventList>.size, packet, 0, 1, &word)
        }
        MIDIReceivedEventList(src, &list)
    }

    private func waitJS(_ web: WKWebView, _ expr: String, _ what: String, timeout: TimeInterval = 10, required: Bool = true) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if (try? await web.evaluateJavaScript(expr)) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        if required {
            let err = (try? await web.evaluateJavaScript("String(window.err)")) as? String
            XCTFail("timed out: \(what) (err=\(err ?? "nil"))")
            throw CancellationError()
        }
    }
}
