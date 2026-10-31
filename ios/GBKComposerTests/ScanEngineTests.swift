import Foundation
import OMRHomrIOS
import XCTest
@testable import GBKComposer

/// A successful fake parse output: the tiny C-major SMF (8 notes) as the page result, with
/// one staff's symbol counts and two stage timings attached.
func fakeGoodOutput() -> ScanPageOutput {
    var out = ScanPageOutput(result: ParseSheetMusicResult(
        midi: ScanController.testSMF,
        noteLayout: (0..<8).map { NoteLayout(symbolIndex: $0, midiNote: 60 + $0) },
        layoutSource: .midiFallback, staffCount: 1, warnings: []))
    out.backend = "fake-backend"
    out.stages = [.init(name: "decode", ms: 10), .init(name: "segnet", ms: 5)]
    out.staffSymbols = [.init(raw: 20, filtered: 18, isGrandstaff: false, voice: 0, row: 0)]
    return out
}

/// Fake `ScanPageParsing`: replays queued results, records which input path each parse took
/// (gray8 vs RGBX — how the engine feeds pages), and tracks peak concurrency.
private final class FakePageParser: ScanPageParsing, @unchecked Sendable {
    enum Call: Equatable { case gray(width: Int, height: Int), rgbx(width: Int, height: Int) }

    private let lock = NSLock()
    private var results: [Result<ScanPageOutput, Error>]
    private var recordedCalls: [Call] = []
    private var active = 0
    private var peak = 0
    /// Artificial parse time (serialization test).
    var delay: TimeInterval = 0

    init(results: [Result<ScanPageOutput, Error>]) { self.results = results }

    var backendDescription: String { "fake-backend" }
    var calls: [Call] { lock.lock(); defer { lock.unlock() }; return recordedCalls }
    var maxConcurrent: Int { lock.lock(); defer { lock.unlock() }; return peak }

    private func next(_ call: Call) throws -> ScanPageOutput {
        lock.lock()
        recordedCalls.append(call)
        active += 1
        peak = max(peak, active)
        let result = results.isEmpty ? .failure(OMRError.sessionNotConfigured("fake queue empty")) : results.removeFirst()
        lock.unlock()
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        lock.lock(); active -= 1; lock.unlock()
        return try result.get()
    }

    func parse(gray8: Data, width: Int, height: Int, progress: PageParseProgressHandler?) throws -> ScanPageOutput {
        try next(.gray(width: width, height: height))
    }

    func parse(rgbx: Data, width: Int, height: Int, bytesPerRow: Int, progress: PageParseProgressHandler?) throws -> ScanPageOutput {
        try next(.rgbx(width: width, height: height))
    }
}

private func makeImage(gray: Bool, w: Int = 40, h: Int = 30) -> CGImage {
    let space = gray ? CGColorSpaceCreateDeviceGray() : CGColorSpaceCreateDeviceRGB()
    let info = gray ? CGImageAlphaInfo.none.rawValue
        : CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                        bytesPerRow: gray ? w : w * 4, space: space, bitmapInfo: info)!
    ctx.setFillColor(gray ? CGColor(gray: 0.5, alpha: 1) : CGColor(red: 0.9, green: 0.2, blue: 0.2, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()!
}

/// Classification + summary: the pure seams of the native scan path (#166), mirroring
/// Music Reader's `PageRecognitionService.outcome(for:)` rules.
final class ScanClassifierTests: XCTestCase {
    private func result(midi: Data, notes: Int, staffs: Int) -> ParseSheetMusicResult {
        ParseSheetMusicResult(midi: midi,
                              noteLayout: (0..<notes).map { NoteLayout(symbolIndex: $0, midiNote: 60) },
                              layoutSource: .midiFallback, staffCount: staffs, warnings: [])
    }

    func testResultClassification() {
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: result(midi: Data(), notes: 0, staffs: 0))?.reasonCode, "no_staff")
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: result(midi: Data(), notes: 0, staffs: 2))?.reasonCode, "empty_midi")
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: result(midi: Data([0x4D]), notes: 0, staffs: 2))?.reasonCode, "no_notes")
        XCTAssertNil(ScanOutcomeClassifier.failure(for: result(midi: Data([0x4D]), notes: 3, staffs: 2)))
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: result(midi: Data(), notes: 0, staffs: 0))?.scanError, .nothingRecognized)
    }

    func testErrorClassification() {
        let missing = ScanOutcomeClassifier.failure(for: OMRError.modelsNotBundled("segnet_x.onnx"))
        XCTAssertEqual(missing.reasonCode, "models_not_bundled")
        guard case .recognizerUnavailable = missing.scanError else { return XCTFail("got \(missing.scanError)") }
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: PageStaffDetectionError.noStaffs).reasonCode, "no_staff")
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: PageStaffDetectionError.noNoteheads).scanError, .nothingRecognized)
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: OMRError.invalidPixelBuffer("bad")).reasonCode, "invalid_input")
        XCTAssertEqual(ScanOutcomeClassifier.failure(for: OMRError.sessionNotConfigured("x")).reasonCode, "session_not_configured")
    }

    func testSummaryAggregatesPages() {
        var s = ScanRunSummary()
        s.add(fakeGoodOutput())
        s.add(fakeGoodOutput())
        XCTAssertEqual(s.pages, 2)
        XCTAssertEqual(s.backend, "fake-backend")
        XCTAssertEqual(s.staffCount, 2)
        XCTAssertEqual(s.systemCount, 2, "one system per page")
        XCTAssertEqual(s.rawTokens, 40)
        XCTAssertEqual(s.filteredTokens, 36)
        XCTAssertEqual(s.noteCount, 16)
        XCTAssertEqual(s.midiBytes, ScanController.testSMF.count * 2)
        XCTAssertEqual(s.stagesField, "decode=20 segnet=10")
    }
}

/// The engine: session-provider failures, per-page classification, RGBX vs gray8 feeding
/// (Music Reader's rule), and FIFO serialization — all against fakes, no models needed.
final class NativeScanEngineTests: XCTestCase {
    func testProviderFailureIsClassified() async {
        let engine = NativeScanEngine(provider: { throw OMRError.modelsNotBundled("segnet_x.onnx") })
        let result = await engine.parse(page: SheetPage(image: makeImage(gray: true)))
        guard case .failure(let f) = result else { return XCTFail("expected failure") }
        XCTAssertEqual(f.reasonCode, "models_not_bundled")
        guard case .recognizerUnavailable = f.scanError else { return XCTFail("got \(f.scanError)") }
    }

    func testEmptyPageResultIsClassified() async {
        let empty = ScanPageOutput(result: ParseSheetMusicResult(
            midi: Data(), noteLayout: [], layoutSource: .midiFallback, staffCount: 0, warnings: []))
        let engine = NativeScanEngine(provider: { FakePageParser(results: [.success(empty)]) })
        let result = await engine.parse(page: SheetPage(image: makeImage(gray: true)))
        guard case .failure(let f) = result else { return XCTFail("expected failure") }
        XCTAssertEqual(f, ScanFailure(scanError: .nothingRecognized, reasonCode: "no_staff"))
    }

    func testColorPagesFeedRGBXAndGrayPagesFeedGray8() async {
        let fake = FakePageParser(results: [.success(fakeGoodOutput()), .success(fakeGoodOutput())])
        let engine = NativeScanEngine(provider: { fake })
        _ = await engine.parse(page: SheetPage(image: makeImage(gray: false)))
        _ = await engine.parse(page: SheetPage(image: makeImage(gray: true)))
        XCTAssertEqual(fake.calls, [.rgbx(width: 40, height: 30), .gray(width: 40, height: 30)])
    }

    func testParsesAreSerialized() async {
        let fake = FakePageParser(results: [.success(fakeGoodOutput()), .success(fakeGoodOutput())])
        fake.delay = 0.25
        let engine = NativeScanEngine(provider: { fake })
        let page = SheetPage(image: makeImage(gray: true))
        async let a = engine.parse(page: page)
        async let b = engine.parse(page: page)
        let ra = await a
        let rb = await b
        guard case .success = ra, case .success = rb else { return XCTFail("both parses should succeed") }
        XCTAssertEqual(fake.maxConcurrent, 1, "one parse at a time, like Music Reader's engine")
        let count = await engine.parseCount
        XCTAssertEqual(count, 2)
    }
}

/// The recognizer over the engine: page merge (append), failed-page skipping, fail-fast on
/// missing models, and the summary hand-off used by telemetry.
final class HomrEngineRecognizerTests: XCTestCase {
    private func pages(_ n: Int) -> [SheetPage] { (0..<n).map { _ in SheetPage(image: makeImage(gray: true)) } }

    func testMergesPagesAndRecordsSummary() async throws {
        let fake = FakePageParser(results: [.success(fakeGoodOutput()), .success(fakeGoodOutput())])
        let rec = HomrSheetRecognizer(engine: NativeScanEngine(provider: { fake }))
        let score = try await rec.recognize(pages: pages(2))
        XCTAssertEqual(score.noteCount, 16, "page 2's 8 notes append after page 1's")
        XCTAssertEqual(rec.lastScanSummary?.pages, 2)
        XCTAssertEqual(rec.lastScanSummary?.noteCount, 16)
        XCTAssertNil(rec.lastScanSummary?.failureReason)
    }

    func testSkipsFailedPages() async throws {
        let noStaff = ScanPageOutput(result: ParseSheetMusicResult(
            midi: Data(), noteLayout: [], layoutSource: .midiFallback, staffCount: 0, warnings: []))
        let fake = FakePageParser(results: [.success(noStaff), .success(fakeGoodOutput())])
        let rec = HomrSheetRecognizer(engine: NativeScanEngine(provider: { fake }))
        let score = try await rec.recognize(pages: pages(2))
        XCTAssertEqual(score.noteCount, 8)
        XCTAssertEqual(rec.lastScanSummary?.pages, 1, "only parsed pages are measured")
    }

    func testFailsFastWhenModelsMissing() async {
        let fake = FakePageParser(results: [
            .failure(OMRError.modelsNotBundled("segnet_x.onnx")),
            .success(fakeGoodOutput()),
        ])
        let rec = HomrSheetRecognizer(engine: NativeScanEngine(provider: { fake }))
        do {
            _ = try await rec.recognize(pages: pages(2))
            XCTFail("expected recognizerUnavailable")
        } catch let e as ScanError {
            guard case .recognizerUnavailable = e else { return XCTFail("got \(e)") }
        } catch { XCTFail("got \(error)") }
        XCTAssertEqual(fake.calls.count, 1, "the second page is never attempted")
        XCTAssertEqual(rec.lastScanSummary?.failureReason, "models_not_bundled")
    }

    func testSinglePageFailureSurfacesItsReason() async {
        let fake = FakePageParser(results: [.failure(OMRError.invalidPixelBuffer("bad pixels"))])
        let rec = HomrSheetRecognizer(engine: NativeScanEngine(provider: { fake }))
        do {
            _ = try await rec.recognize(pages: pages(1))
            XCTFail("expected unreadableInput")
        } catch let e as ScanError {
            guard case .unreadableInput = e else { return XCTFail("got \(e)") }
        } catch { XCTFail("got \(error)") }
        XCTAssertEqual(rec.lastScanSummary?.failureReason, "invalid_input")
    }
}

/// Telemetry event shapes (#166): names, fields, and the `/api/events` wire JSON.
@MainActor
final class ScanTelemetryTests: XCTestCase {
    func testEventShapes() async {
        let logger = ScanTelemetryLogger()
        var sent: [ScanTelemetryEvent] = []
        logger.send = { sent.append($0) }
        logger.now = { Date(timeIntervalSince1970: 1000) }

        logger.started(source: .camera, pages: 2, imageWidth: 3000, imageHeight: 2400)
        var summary = ScanRunSummary()
        summary.add(fakeGoodOutput())
        logger.completed(summary: summary, durationMs: 999, noteCount: 8)
        logger.failed(reason: "no_staff", summary: nil, durationMs: 50)

        for _ in 0..<200 where sent.count < 3 { await Task.yield() }
        XCTAssertEqual(sent.map(\.name), ["scan_started", "scan_completed", "scan_failed"])
        XCTAssertEqual(sent[0].fields["source"], .string("camera"))
        XCTAssertEqual(sent[0].fields["pages"], .int(2))
        XCTAssertEqual(sent[0].fields["image_w"], .int(3000))
        XCTAssertEqual(sent[0].json()["event"] as? String, "scan_started")
        XCTAssertEqual(sent[0].json()["ts"] as? Int64, 1_000_000)
        // duration comes from the summary's own total when present
        XCTAssertEqual(sent[1].fields["note_count"], .int(8))
        XCTAssertEqual(sent[1].fields["staff_count"], .int(1))
        XCTAssertEqual(sent[1].fields["backend"], .string("fake-backend"))
        XCTAssertEqual(sent[1].fields["stages"], .string("decode=10 segnet=5"))
        XCTAssertEqual(sent[2].fields["reason"], .string("no_staff"))
        XCTAssertEqual(sent[2].fields["duration_ms"], .int(50))
        XCTAssertNil(sent[2].fields["staff_count"], "no summary: no measurement fields")
    }
}
