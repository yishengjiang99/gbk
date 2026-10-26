import XCTest
@testable import GBKComposer

@MainActor
final class BillingEventLoggerTests: XCTestCase {

    /// All six funnel events, in order, with the exact wire names and fields from #119.
    func testWireShapeForEveryEventKind() async {
        let log = BillingEventLogger()
        var sent: [[BillingEvent]] = []
        log.send = { sent.append($0) }
        log.now = { Date(timeIntervalSince1970: 2000) }
        log.paywallView(reason: "profile")
        log.planSelect(plan: StoreCatalog.proYearly.id)
        log.purchaseStart(plan: StoreCatalog.proYearly.id)
        log.purchaseResult(plan: StoreCatalog.proYearly.id, .success)
        log.restore(.none)
        log.paywallDismiss()
        log.flush()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first, [
            BillingEvent(name: "paywall_view", reason: "profile", ts: 2_000_000),
            BillingEvent(name: "plan_select", plan: StoreCatalog.proYearly.id, ts: 2_000_000),
            BillingEvent(name: "iap_purchase_start", plan: StoreCatalog.proYearly.id, ts: 2_000_000),
            BillingEvent(name: "iap_purchase_result", plan: StoreCatalog.proYearly.id, result: "success", ts: 2_000_000),
            BillingEvent(name: "restore", result: "none", ts: 2_000_000),
            BillingEvent(name: "paywall_dismiss", ts: 2_000_000),
        ])
        XCTAssertTrue(log.queue.isEmpty)
        let rows = (sent.first ?? []).map { $0.json() }
        XCTAssertEqual(rows.compactMap { $0["event"] as? String },
                       ["paywall_view", "plan_select", "iap_purchase_start", "iap_purchase_result", "restore", "paywall_dismiss"])
        XCTAssertEqual(rows[0]["reason"] as? String, "profile")
        XCTAssertNil(rows[0]["plan"])
        XCTAssertNil(rows[0]["result"])
        XCTAssertEqual(rows[1]["plan"] as? String, StoreCatalog.proYearly.id)
        XCTAssertEqual(rows[3]["result"] as? String, "success")
        XCTAssertEqual(rows[4]["result"] as? String, "none")
        XCTAssertEqual(Set(rows[5].keys), Set(["event", "ts"]))
    }

    func testPurchaseAndRestoreResultRawValues() {
        XCTAssertEqual(BillingPurchaseResult.success.rawValue, "success")
        XCTAssertEqual(BillingPurchaseResult.cancelled.rawValue, "cancelled")
        XCTAssertEqual(BillingPurchaseResult.pending.rawValue, "pending")
        XCTAssertEqual(BillingPurchaseResult.failed.rawValue, "failed")
        XCTAssertEqual(BillingRestoreResult.success.rawValue, "success")
        XCTAssertEqual(BillingRestoreResult.none.rawValue, "none")
        XCTAssertEqual(BillingRestoreResult.failed.rawValue, "failed")
    }

    /// Same batching as ImpressionLogger: nothing is sent before 10 events, then one batch of 10.
    func testFlushesAtBatchSizeTen() async {
        let log = BillingEventLogger()
        var sent: [[BillingEvent]] = []
        log.send = { sent.append($0) }
        for _ in 0..<9 { log.paywallDismiss() }
        XCTAssertEqual(log.queue.count, 9)
        XCTAssertTrue(sent.isEmpty)
        log.paywallDismiss()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(sent.map(\.count), [10])
        XCTAssertTrue(log.queue.isEmpty)
    }

    /// Events past a full batch stay queued, in order, for the next flush.
    func testRepeatedFlushesDrainInOrder() async {
        let log = BillingEventLogger()
        var sent: [[BillingEvent]] = []
        log.send = { sent.append($0) }
        for i in 0..<25 { log.planSelect(plan: "p\(i)") }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(sent.map(\.count), [10, 10])
        XCTAssertEqual(log.queue.count, 5)
        log.flush()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(sent.map(\.count), [10, 10, 5])
        XCTAssertEqual(sent.flatMap { $0 }.compactMap(\.plan), (0..<25).map { "p\($0)" })
        XCTAssertTrue(log.queue.isEmpty)
    }

    /// The store side of the reason plumbing: presentPaywall records why, then the sheet shows.
    func testPresentPaywallRecordsReason() {
        let store = PurchaseStore(billing: BillingEventLogger())
        XCTAssertFalse(store.showPaywall)
        XCTAssertEqual(store.paywallReason, "manual")
        store.presentPaywall(reason: "profile")
        XCTAssertTrue(store.showPaywall)
        XCTAssertEqual(store.paywallReason, "profile")
        store.showPaywall = false
        store.presentPaywall(reason: "studio_link")
        XCTAssertTrue(store.showPaywall)
        XCTAssertEqual(store.paywallReason, "studio_link")
    }
}
