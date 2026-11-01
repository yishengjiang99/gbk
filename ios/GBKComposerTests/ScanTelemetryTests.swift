import OMRScanKit
import XCTest
@testable import GBKComposer

/// Telemetry event shapes (#166): names, fields, and the client-error reporter's wire JSON
/// (the web scan telemetry's taxonomy and pathway).
@MainActor
final class ScanTelemetryTests: XCTestCase {
    func testEventShapes() async {
        let logger = ScanTelemetryLogger()
        var sent: [ScanTelemetryEvent] = []
        logger.send = { sent.append($0) }
        logger.now = { Date(timeIntervalSince1970: 1000) }

        logger.started(source: .camera, pages: 2, imageWidth: 3000, imageHeight: 2400)
        var summary = ScanDiagnostics()
        summary.pages = 1
        summary.staffCount = 1
        summary.noteCount = 8
        summary.layoutSource = "midi-fallback"
        summary.perStaffTokens = [18]
        summary.perStaffRawTokens = [20]
        summary.backendSegnet = "fake-segnet"
        summary.totalMs = 4321
        logger.completed(source: .photos, diagnostics: summary, durationMs: 999, noteCount: 8)
        logger.failed(source: .photos, reason: "no_staff", diagnostics: nil, durationMs: 50)

        for _ in 0..<200 where sent.count < 3 { await Task.yield() }
        XCTAssertEqual(sent.map(\.name), ["scan_started", "scan_completed", "scan_failed"])
        XCTAssertEqual(sent[0].fields["source"], .string("camera"))
        XCTAssertEqual(sent[0].fields["pages"], .int(2))
        XCTAssertEqual(sent[0].fields["width"], .int(3000))
        // Wire shape: a kind:"report" client-error entry, fields in context under where:"scan".
        let wire = sent[0].json()
        XCTAssertEqual(wire["kind"] as? String, "report")
        XCTAssertEqual(wire["message"] as? String, "scan_started")
        XCTAssertEqual(wire["ts"] as? Int64, 1_000_000)
        let context = wire["context"] as? [String: Any]
        XCTAssertEqual(context?["where"] as? String, "scan")
        XCTAssertEqual(context?["event"] as? String, "scan_started")
        XCTAssertEqual(context?["source"] as? String, "camera")
        // The summary's own total wins over the caller's fallback duration.
        XCTAssertEqual(sent[1].fields["totalMs"], .int(4321))
        XCTAssertEqual(sent[1].fields["notes"], .int(8))
        XCTAssertEqual(sent[1].fields["staffCount"], .int(1))
        XCTAssertEqual(sent[1].fields["backendSegnet"], .string("fake-segnet"))
        XCTAssertEqual(sent[1].fields["perStaffTokens"], .string("18"))
        XCTAssertEqual(sent[1].fields["perStaffRawTokens"], .string("20"))
        XCTAssertEqual(sent[1].fields["layoutSource"], .string("midi-fallback"))
        XCTAssertEqual(sent[2].fields["reason"], .string("no_staff"))
        XCTAssertEqual(sent[2].fields["totalMs"], .int(50))
        XCTAssertNil(sent[2].fields["staffCount"], "no summary: no measurement fields")
    }
}
