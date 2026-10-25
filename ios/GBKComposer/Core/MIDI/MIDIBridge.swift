import CoreMIDI
import UIKit
import WebKit

/// Web MIDI for the studio WKWebView (WebKit has none). A document-start script installs a
/// `navigator.requestMIDIAccess` polyfill backed by `webkit.messageHandlers.gbkMidi`; native CoreMIDI input
/// (`MIDIInputHub`) is pushed into it as `midimessage` events with `{data: Uint8Array, timeStamp}`, so the
/// studio's own MidiInputManager → LiveInputSession plays and records exactly as on desktop Chrome.
/// Also exposes `window.gbkMidiNative` (capability flag + Bluetooth pairing). Contract: docs/ios/midi.md.
@MainActor
final class MIDIBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "gbkMidi"
    weak var webView: WKWebView?
    let hub: MIDIInputHub
    private(set) var requested = false
    /// Native receive (CoreMIDI timestamp) → evaluateJavaScript completion, ms. Last 256 batches.
    private(set) var latencies: [Double] = []

    init(hub: MIDIInputHub = .shared) { self.hub = hub }

    /// Add the polyfill script and message handler to a configuration. Keep the returned bridge alive and set `webView`.
    static func install(in config: WKWebViewConfiguration, hub: MIDIInputHub = .shared) -> MIDIBridge {
        let bridge = MIDIBridge(hub: hub)
        config.userContentController.addUserScript(WKUserScript(source: MIDIBridgeScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(MIDIWeakScriptHandler(bridge), name: handlerName)
        return bridge
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "request": startInput()
        case "openBluetooth": BluetoothMIDIPairing.present()
        default: break
        }
    }

    func startInput() {
        requested = true
        hub.onMessages = { [weak self] msgs in self?.deliver(msgs) }
        hub.onDevicesChanged = { [weak self] devs in self?.sendDevices(devs) }
        let status = hub.start()
        if status != noErr { send("window.__gbkMidi&&__gbkMidi.fail(\(status))"); return }
        hub.rescan()
        sendDevices(hub.devices)
    }

    func sendDevices(_ devices: [MIDIInputDevice]) {
        send("window.__gbkMidi&&__gbkMidi.devices(\(Self.encodeDevices(devices)))")
    }

    func deliver(_ msgs: [BridgedMIDIMessage]) {
        let now = mach_absolute_time()
        let oldest = msgs.map(\.hostTime).min() ?? now
        send(Self.encodeBatch(msgs, nowHostTime: now)) { [weak self] in
            let ms = MIDIInputHub.hostTimeToMs(mach_absolute_time() &- oldest)
            guard let self else { return }
            self.latencies.append(ms)
            if self.latencies.count > 256 { self.latencies.removeFirst(self.latencies.count - 256) }
        }
    }

    private func send(_ js: String, done: (() -> Void)? = nil) {
        guard let webView else { return }
        webView.evaluateJavaScript(js) { _, _ in done?() }
    }

    // MARK: wire format (unit-tested)

    static func encodeDevices(_ devices: [MIDIInputDevice]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        return (try? String(data: enc.encode(devices), encoding: .utf8)) ?? "[]"
    }

    /// `__gbkMidi.recv([[deviceId, [status, d1, d2], ageMs], ...])`. ageMs = time since CoreMIDI stamped the
    /// message, so JS sets `timeStamp = performance.now() - ageMs` (same clock base as Web MIDI).
    static func encodeBatch(_ msgs: [BridgedMIDIMessage], nowHostTime: UInt64) -> String {
        let items = msgs.map { m -> String in
            let age = m.hostTime > nowHostTime ? 0 : MIDIInputHub.hostTimeToMs(nowHostTime - m.hostTime)
            let id = (try? String(data: JSONEncoder().encode(m.sourceID), encoding: .utf8)) ?? "\"\""
            return "[\(id),[\(m.bytes.map(String.init).joined(separator: ","))],\(String(format: "%.3f", age))]"
        }
        return "window.__gbkMidi&&__gbkMidi.recv([\(items.joined(separator: ","))])"
    }
}

/// WKUserContentController retains its handlers; break the cycle.
private final class MIDIWeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?
    init(_ t: any WKScriptMessageHandler) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

enum MIDIBridgeScript {
    static let source = #"""
(function () {
  if (window.__gbkMidi || !(window.webkit && webkit.messageHandlers && webkit.messageHandlers.gbkMidi)) return;
  var post = function (m) { try { webkit.messageHandlers.gbkMidi.postMessage(m); } catch (e) {} };
  function MsgEvent(data, ts) {
    var e = new Event("midimessage");
    Object.defineProperty(e, "data", { value: data, enumerable: true });
    Object.defineProperty(e, "timeStamp", { value: ts, enumerable: true });
    return e;
  }
  function StateEvent(port) { var e = new Event("statechange"); Object.defineProperty(e, "port", { value: port }); return e; }
  function Port(d) {
    var t = new EventTarget();
    t.id = d.id; t.name = d.name; t.manufacturer = d.manufacturer || ""; t.version = ""; t.type = "input";
    t.state = "connected"; t.connection = "open"; t.onmidimessage = null; t.onstatechange = null;
    t.open = function () { return Promise.resolve(t); }; t.close = function () { return Promise.resolve(t); };
    t._emit = function (e) { if (typeof t.onmidimessage === "function") t.onmidimessage(e); t.dispatchEvent(e); };
    return t;
  }
  var access = new EventTarget();
  access.inputs = new Map(); access.outputs = new Map(); access.sysexEnabled = false; access.onstatechange = null;
  var fire = function (port) {
    var e = StateEvent(port);
    if (typeof access.onstatechange === "function") access.onstatechange(e); access.dispatchEvent(e);
    if (typeof port.onstatechange === "function") port.onstatechange(e);
  };
  var waiters = [], ready = false, failed = null;
  var stats = { received: 0, batches: 0, lastAgeMs: 0, maxAgeMs: 0 };
  window.__gbkMidi = {
    stats: stats,
    devices: function (list) {
      var ids = {};
      list.forEach(function (d) {
        ids[d.id] = 1;
        if (!access.inputs.has(d.id)) { var p = Port(d); access.inputs.set(d.id, p); if (ready) fire(p); }
      });
      Array.from(access.inputs.keys()).forEach(function (id) {
        if (!ids[id]) { var p = access.inputs.get(id); access.inputs.delete(id); p.state = "disconnected"; p.connection = "closed"; fire(p); }
      });
      if (!ready) { ready = true; waiters.splice(0).forEach(function (w) { w[0](access); }); }
    },
    fail: function (code) {
      failed = code;
      waiters.splice(0).forEach(function (w) { var e = new Error("CoreMIDI error " + code); e.name = "InvalidStateError"; w[1](e); });
    },
    recv: function (batch) {
      var now = performance.now();
      stats.batches++;
      for (var i = 0; i < batch.length; i++) {
        var m = batch[i], p = access.inputs.get(m[0]);
        stats.received++; stats.lastAgeMs = m[2]; if (m[2] > stats.maxAgeMs) stats.maxAgeMs = m[2];
        if (p) p._emit(MsgEvent(new Uint8Array(m[1]), now - m[2]));
      }
    }
  };
  navigator.requestMIDIAccess = function () {
    if (ready) return Promise.resolve(access);
    return new Promise(function (res, rej) { waiters.push([res, rej]); post({ type: "request" }); });
  };
  // window.gbkNative is frozen by HumBridge (capabilities include "midi"); MIDI extras live here.
  window.gbkMidiNative = { webMidiPolyfill: true, bluetooth: true, network: true,
    openBluetoothPairing: function () { post({ type: "openBluetooth" }); } };
})();
"""#
}
