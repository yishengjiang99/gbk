import XCTest
@testable import GBKComposer

/// Hard `/api/me` triggers (ai_budget, render_limit) and the watcher's dismiss filter.
@MainActor
final class PaywallTriggerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func pw(_ eligible: Bool, _ reason: String?, seen: Bool? = nil) -> MePaywall {
        MePaywall(eligible: eligible, reason: reason, cooldownUntil: nil, thirdSongSeen: seen)
    }

    func testMeDecodesPaywallReasonsAndThirdSongSeen() throws {
        let json = #"{"id":"a","handle":"h","song_count":3,"paywall":{"eligible":true,"reason":"ai_budget","cooldown_until":null,"third_song_seen":false}}"#
        let me = try APIClient.makeDecoder().decode(Me.self, from: Data(json.utf8))
        XCTAssertEqual(me.paywall?.reason, "ai_budget")
        XCTAssertEqual(me.paywall?.thirdSongSeen, false)
        XCTAssertEqual(me.songCount, 3)
        let seen = try APIClient.makeDecoder().decode(Me.self, from: Data(
            #"{"id":"a","handle":"h","paywall":{"eligible":false,"reason":"render_limit","cooldown_until":null,"third_song_seen":true}}"#.utf8))
        XCTAssertEqual(seen.paywall?.reason, "render_limit")
        XCTAssertEqual(seen.paywall?.thirdSongSeen, true)
        let bare = try APIClient.makeDecoder().decode(Me.self, from: Data(#"{"id":"a","handle":"h"}"#.utf8))
        XCTAssertNil(bare.paywall)
    }

    func testProAndRetiredReasonsNeverTrigger() {
        var e = PaywallTriggerEngine()
        XCTAssertEqual(e.evaluate(paywall: pw(true, "ai_budget"), isPro: true, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: nil, isPro: false, now: t0), .none)
        // Retired soft/hard reasons from older servers are ignored.
        XCTAssertEqual(e.evaluate(paywall: pw(true, "landing"), isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "export_after_2"), isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(false, "ai_limit"), isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "third_song"), isPro: false, now: t0), .none)
    }

    func testHardGatePresentsOncePerEpisode() {
        var e = PaywallTriggerEngine()
        XCTAssertEqual(e.evaluate(paywall: pw(false, "ai_budget"), isPro: false, now: t0),
                       .present(reason: "ai_budget", hard: true))
        XCTAssertEqual(e.evaluate(paywall: pw(false, "ai_budget"), isPro: false,
                                  now: t0.addingTimeInterval(3_600)), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(false, nil), isPro: false,
                                  now: t0.addingTimeInterval(2 * 3_600)), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "render_limit"), isPro: false,
                                  now: t0.addingTimeInterval(3 * 3_600)),
                       .present(reason: "render_limit", hard: true))
    }

    func testWatcherDismissReportsReasonAndSkipsManualOpens() throws {
        let suite = "PaywallTriggerTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var reported: [(String, String)] = []
        let watcher = PaywallTriggerWatcher(defaults: defaults)
        watcher.report = { reported.append(($0, $1)) }
        watcher.sheetReason = { "profile" }
        watcher.sheetDismissed()
        XCTAssertEqual(reported.count, 0)
        XCTAssertNil(PaywallTriggerState.load(from: defaults).lastDismissedAt)
        watcher.sheetReason = { "third_song" }
        watcher.sheetDismissed()
        XCTAssertEqual(reported.map { "\($0.0):\($0.1)" }, ["paywall_dismiss:third_song"])
        XCTAssertNil(PaywallTriggerState.load(from: defaults).lastDismissedAt, "third_song starts no cooldown")
        watcher.sheetReason = { "export" }
        watcher.sheetDismissed()
        XCTAssertEqual(reported.map { "\($0.0):\($0.1)" }, ["paywall_dismiss:third_song", "paywall_dismiss:export"])
        XCTAssertNotNil(PaywallTriggerState.load(from: defaults).lastDismissedAt)
    }
}
