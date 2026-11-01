import Foundation
import OMRScanKit

/// One native-scan telemetry event (#166). The taxonomy is the web scan telemetry's
/// (src/telemetry/scan.ts) — do not rename:
/// - `scan_started` {source, width, height, pages}
/// - `scan_completed` {source, totalMs, preprocessMs, segnetMs, detectMs, encodeMs, decodeMs,
///   staffCount, systemCount, voiceCount, notes, perStaffTokens, perStaffRawTokens, perStaffMs,
///   backendSegnet, backendEncoder, backendDecoder, layoutSource, warningCount}
/// - `scan_failed` {source, reason, totalMs, + whatever counts the scan produced}
///
/// Metadata and timings only: no image data, no file names, no user content.
struct ScanTelemetryEvent: Equatable {
    enum Value: Equatable {
        case string(String), int(Int), double(Double)
        var json: Any {
            switch self {
            case .string(let s): return s
            case .int(let i): return i
            case .double(let d): return d
            }
        }
    }

    let name: String
    var fields: [String: Value]
    let ts: Int64

    /// The client-error reporter's entry shape (kind "report", event name as the message,
    /// fields in `context` under `where: "scan"` — exactly how the web reporter sends them).
    func json() -> [String: Any] {
        var context: [String: Any] = ["where": "scan", "event": name]
        for (k, v) in fields { context[k] = v.json }
        return ["kind": "report", "message": name, "ts": ts, "context": context]
    }
}

/// Scan telemetry through the same server-side pathway the web scanner uses (#165): the
/// client-error reporter channel — `POST /api/client-errors` with kind "report" — because
/// `/api/events` is the feed-impression contract and cannot carry per-stage payloads. The
/// server stores the reports scrubbed and size-capped, readable by the owner; they are not
/// part of the user-facing analytics taxonomy. Scans are rare, so events send immediately
/// instead of batching. Send failures are swallowed: telemetry must never break the scan
/// it observes.
@MainActor
final class ScanTelemetryLogger {
    static let shared = ScanTelemetryLogger()

    var send: (ScanTelemetryEvent) async -> Void = { event in
        let ep = Endpoint(path: "/api/client-errors", method: .post, body: ["errors": [event.json()]])
        _ = try? await APIClient.shared.send(ep, as: OKResult.self)
    }
    var now: () -> Date = Date.init

    private func stamp() -> Int64 { Int64(now().timeIntervalSince1970 * 1000) }

    private func emit(_ event: ScanTelemetryEvent) {
        let send = send
        Task { await send(event) }
    }

    func started(source: ScanSource, pages: Int, imageWidth: Int?, imageHeight: Int?) {
        var fields: [String: ScanTelemetryEvent.Value] = [
            "source": .string(source.rawValue),
            "pages": .int(pages),
        ]
        if let imageWidth { fields["width"] = .int(imageWidth) }
        if let imageHeight { fields["height"] = .int(imageHeight) }
        emit(ScanTelemetryEvent(name: "scan_started", fields: fields, ts: stamp()))
    }

    func completed(source: ScanSource, diagnostics summary: ScanDiagnostics?, durationMs: Double, noteCount: Int) {
        var fields = measurementFields(summary)
        fields["source"] = .string(source.rawValue)
        fields["totalMs"] = .int(Int((summary?.totalMs ?? durationMs).rounded()))
        if fields["notes"] == nil { fields["notes"] = .int(noteCount) }
        emit(ScanTelemetryEvent(name: "scan_completed", fields: fields, ts: stamp()))
    }

    func failed(source: ScanSource, reason: String, diagnostics summary: ScanDiagnostics?, durationMs: Double) {
        var fields = measurementFields(summary)
        fields["source"] = .string(source.rawValue)
        fields["reason"] = .string(reason)
        fields["totalMs"] = .int(Int((summary?.totalMs ?? durationMs).rounded()))
        emit(ScanTelemetryEvent(name: "scan_failed", fields: fields, ts: stamp()))
    }

    /// The measurement fields in the web telemetry's shape. Empty without a summary
    /// (fixture recognizers, or a failure before the first page parsed).
    private func measurementFields(_ summary: ScanDiagnostics?) -> [String: ScanTelemetryEvent.Value] {
        guard let summary else { return [:] }
        var fields: [String: ScanTelemetryEvent.Value] = [
            "preprocessMs": .int(Int(summary.preprocessMs.rounded())),
            "segnetMs": .int(Int(summary.segnetMs.rounded())),
            "detectMs": .int(Int(summary.detectMs.rounded())),
            "encodeMs": .int(Int(summary.encodeMs.rounded())),
            "decodeMs": .int(Int(summary.decodeMs.rounded())),
            "staffCount": .int(summary.staffCount),
            "systemCount": .int(summary.systemCount),
            "voiceCount": .int(summary.voiceCount),
            "notes": .int(summary.noteCount),
            "perStaffTokens": .string(summary.perStaffTokens.map(String.init).joined(separator: ",")),
            "perStaffRawTokens": .string(summary.perStaffRawTokens.map(String.init).joined(separator: ",")),
            "perStaffMs": .string(summary.perStaffMs.map { String(Int($0.rounded())) }.joined(separator: ",")),
            "layoutSource": .string(summary.layoutSource),
            "warningCount": .int(summary.warningCount),
            "pages": .int(summary.pages),
            "midiBytes": .int(summary.midiBytes),
        ]
        if let b = summary.backendSegnet { fields["backendSegnet"] = .string(b) }
        if let b = summary.backendEncoder { fields["backendEncoder"] = .string(b) }
        if let b = summary.backendDecoder { fields["backendDecoder"] = .string(b) }
        return fields
    }
}
