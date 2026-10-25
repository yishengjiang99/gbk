// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — PageParseProgress: stage weights, monotonic fraction, real parsePage progress reports.
import Foundation
import XCTest
@testable import OMRHomrIOS

final class PageParseProgressTests: XCTestCase {
    func testWeightsSumToOneInPipelineOrder() {
        XCTAssertEqual(PageParseProgress.weights.map(\.stage), PageParseProgress.Stage.allCases)
        XCTAssertEqual(PageParseProgress.weights.map(\.weight).reduce(0, +), 1, accuracy: 1e-9)
    }

    /// The report sequence parsePage emits (54 SegNet tiles in 32-tile dispatches, 4 staffs) only goes up
    /// and ends at exactly 1.0.
    func testSimulatedPipelineIsMonotonicAndEndsAtOne() {
        var seq = [PageParseProgress(stage: .preprocess, completed: 1, total: 1)]
        seq += (1...54).map { PageParseProgress(stage: .segnet, completed: $0, total: 54) }
        seq.append(PageParseProgress(stage: .staffs, completed: 1, total: 1))
        seq += (1...4).map { PageParseProgress(stage: .decode, completed: $0, total: 4) }
        seq.append(PageParseProgress(stage: .render, completed: 1, total: 1))
        let f = seq.map(\.fraction)
        XCTAssertEqual(f.first ?? 0, 0.02, accuracy: 1e-9)
        for (a, b) in zip(f, f.dropFirst()) { XCTAssertLessThan(a, b) }
        XCTAssertEqual(f.last, 1.0)
        XCTAssertEqual(PageParseProgress(stage: .segnet, completed: 27, total: 54).fraction, 0.02 + 0.49 / 2, accuracy: 1e-9)
        XCTAssertEqual(PageParseProgress(stage: .decode, completed: 0, total: 0).fraction, 0.99, accuracy: 1e-9)
        XCTAssertEqual(PageParseProgress(stage: .segnet, completed: 99, total: 54).fraction, 0.51, accuracy: 1e-9, "clamped")
    }

    /// Real models on the C-scale page: every SegNet tile and every staff reports, in order, ending at 1.0.
    func testParsePageReportsRealProgress() throws {
        #if canImport(CONNXRuntime)
        guard ProcessInfo.processInfo.environment["OMR_SLOW_TESTS"] == "1" else {
            throw XCTSkip("set OMR_SLOW_TESTS=1 (real models, ~40 s in debug)")
        }
        let fixtures = try WriterOnlyFixtureTests.fixturesRoot()
        let models = fixtures.deletingLastPathComponent().appendingPathComponent("models")
        let session: PageInferenceSession
        do { session = try PageInferenceSession.load(modelsDirectory: models) } catch {
            throw XCTSkip("pinned models missing; run scripts/fetch-models (\(error))")
        }
        let png = try Data(contentsOf: fixtures.appendingPathComponent("mono.c_major_scale/input.png"))
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var items: [PageParseProgress] = []
            func add(_ p: PageParseProgress) { lock.lock(); items.append(p); lock.unlock() }
        }
        let box = Box()
        let r = try session.parsePage(png: png) { box.add($0) }
        let reports = box.items
        let tiles = session.segnet.lastTileCount
        XCTAssertGreaterThan(tiles, 1)
        XCTAssertEqual(reports.filter { $0.stage == .segnet }.map(\.completed), Array(1...tiles))
        XCTAssertEqual(reports.filter { $0.stage == .decode }.map(\.completed), Array(1...r.layout.staffs.count))
        for (a, b) in zip(reports, reports.dropFirst()) { XCTAssertLessThanOrEqual(a.fraction, b.fraction) }
        XCTAssertEqual(reports.last?.stage, .render)
        XCTAssertEqual(reports.last?.fraction, 1.0)
        #else
        throw XCTSkip("CONNXRuntime not linked")
        #endif
    }
}
