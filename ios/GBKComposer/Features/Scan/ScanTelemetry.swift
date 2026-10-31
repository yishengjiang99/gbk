import Foundation

/// One native-scan telemetry event (#166). `name` is the wire taxonomy shared with the web
/// scan telemetry — do not rename:
/// - `scan_started` {source, pages, image_w, image_h}
/// - `scan_completed` {duration_ms, pages, stages, backend, staff_count, system_count,
///   raw_tokens, filtered_tokens, note_count, midi_bytes, warnings}
/// - `scan_failed` {reason, duration_ms, + whatever measurements the scan produced}
///
/// Metadata only: no image data, no user content, no file names — the same rule as
/// Music Reader's scan diagnostics. `source` is one of `ScanSource`'s raw values
/// (camera / photos / file / fixture).
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

    func json() -> [String: Any] {
        var d: [String: Any] = ["event": name, "ts": ts]
        for (k, v) in fields { d[k] = v.json }
        return d
    }
}

/// Where a scan's pages came from (telemetry `source` + the sheet's entry points).
enum ScanSource: String {
    case camera, photos, file, fixture
}

/// Scan telemetry over the app's existing event pathway — the same transport as
/// `BillingEventLogger` / `ImpressionLogger`: `POST /api/events` with `client: "ios"` and
/// the guest install id (`x-gbk-install`). The server records scan events server-side
/// (structured log, via the events route's scan bridge); they are not feed impressions and
/// not part of the user-facing analytics taxonomy. Scans are rare, so events send
/// immediately instead of batching. Send failures are swallowed: telemetry must never
/// break the scan it observes.
@MainActor
final class ScanTelemetryLogger {
    static let shared = ScanTelemetryLogger()

    var send: (ScanTelemetryEvent) async -> Void = { event in
        let body: [String: Any] = ["session": ImpressionLogger.session, "client": "ios",
                                   "events": [event.json()]]
        var ep = Endpoint(path: "/api/events", method: .post, body: body)
        ep.headers["x-gbk-install"] = AnonymousIdentity.deviceID
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
        if let imageWidth { fields["image_w"] = .int(imageWidth) }
        if let imageHeight { fields["image_h"] = .int(imageHeight) }
        emit(ScanTelemetryEvent(name: "scan_started", fields: fields, ts: stamp()))
    }

    func completed(summary: ScanRunSummary?, durationMs: Double, noteCount: Int) {
        var fields = measurementFields(summary)
        fields["duration_ms"] = .int(Int((summary?.totalMs ?? durationMs).rounded()))
        if fields["note_count"] == nil { fields["note_count"] = .int(noteCount) }
        emit(ScanTelemetryEvent(name: "scan_completed", fields: fields, ts: stamp()))
    }

    func failed(reason: String, summary: ScanRunSummary?, durationMs: Double) {
        var fields = measurementFields(summary)
        fields["reason"] = .string(reason)
        fields["duration_ms"] = .int(Int((summary?.totalMs ?? durationMs).rounded()))
        emit(ScanTelemetryEvent(name: "scan_failed", fields: fields, ts: stamp()))
    }

    /// The measurement fields shared by completed/failed (a failed multi-page scan still
    /// reports the pages that parsed). Empty without a summary (fixture recognizers).
    private func measurementFields(_ summary: ScanRunSummary?) -> [String: ScanTelemetryEvent.Value] {
        guard let summary else { return [:] }
        var fields: [String: ScanTelemetryEvent.Value] = [
            "pages": .int(summary.pages),
            "staff_count": .int(summary.staffCount),
            "system_count": .int(summary.systemCount),
            "raw_tokens": .int(summary.rawTokens),
            "filtered_tokens": .int(summary.filteredTokens),
            "note_count": .int(summary.noteCount),
            "midi_bytes": .int(summary.midiBytes),
            "warnings": .int(summary.warningCount),
        ]
        if !summary.backend.isEmpty { fields["backend"] = .string(summary.backend) }
        if !summary.stageMs.isEmpty { fields["stages"] = .string(summary.stagesField) }
        return fields
    }
}
