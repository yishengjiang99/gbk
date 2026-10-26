import XCTest
@testable import GBKComposer

/// #123: the native paywall triggers — `/api/me` paywall decoding, the pure trigger engine
/// (soft flips, persisted 24 h cooldown, hard limit gates), state persistence, and the
/// watcher's dismiss filter. The watcher's snapshot evaluation reads the AuthStore /
/// PurchaseStore singletons, so it is covered indirectly through the engine it delegates to.
@MainActor
final class PaywallTriggerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func pw(_ eligible: Bool, _ reason: String?) -> MePaywall {
        MePaywall(eligible: eligible, reason: reason, cooldownUntil: nil)
    }

    // MARK: /api/me decoding

    func testMeDecodesPaywallEligibility() throws {
        let json = #"{"id":"a","handle":"h","paywall":{"eligible":true,"reason":"export_after_2","cooldown_until":1700000000000}}"#
        let me = try APIClient.makeDecoder().decode(Me.self, from: Data(json.utf8))
        XCTAssertEqual(me.paywall?.eligible, true)
        XCTAssertEqual(me.paywall?.reason, "export_after_2")
        XCTAssertEqual(me.paywall?.cooldownUntil, 1_700_000_000_000)
        let cooling = try APIClient.makeDecoder().decode(Me.self, from: Data(
            #"{"id":"a","handle":"h","paywall":{"eligible":false,"reason":"ai_limit","cooldown_until":null}}"#.utf8))
        XCTAssertEqual(cooling.paywall?.eligible, false)
        XCTAssertEqual(cooling.paywall?.reason, "ai_limit")
        XCTAssertNil(cooling.paywall?.cooldownUntil)
        let bare = try APIClient.makeDecoder().decode(Me.self, from: Data(#"{"id":"a","handle":"h"}"#.utf8))
        XCTAssertNil(bare.paywall)
    }

    // MARK: Engine — soft triggers

    func testProNeverTriggers() {
        var e = PaywallTriggerEngine()
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: true, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "ai_limit"), isPro: true, now: t0), .none)
    }

    func testNoReasonNoTrigger() {
        var e = PaywallTriggerEngine()
        XCTAssertEqual(e.evaluate(paywall: nil, isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(false, nil), isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "something_else"), isPro: false, now: t0), .none)
    }

    func testSoftFlipPresentsOncePerTrigger() {
        var e = PaywallTriggerEngine()
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0),
                       .present(reason: "second_composition", hard: false))
        // The same snapshot re-evaluated (every /api/me refresh) does not present again.
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0), .none)
    }

    func testSoftRequiresServerEligible() {
        var e = PaywallTriggerEngine()
        // eligible == false (server cooldown) suppresses the soft trigger without consuming it.
        XCTAssertEqual(e.evaluate(paywall: pw(false, "second_composition"), isPro: false, now: t0), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0),
                       .present(reason: "second_composition", hard: false))
    }

    func testSoftCooldownAfterDismissal() {
        var e = PaywallTriggerEngine()
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0),
                       .present(reason: "second_composition", hard: false))
        e.noteDismissed(now: t0)
        // A different soft trigger inside 24 h is held back by the cooldown…
        XCTAssertEqual(e.evaluate(paywall: pw(true, "export_after_2"), isPro: false,
                                  now: t0.addingTimeInterval(3_600)), .none)
        // …and may present once the cooldown has passed.
        XCTAssertEqual(e.evaluate(paywall: pw(true, "export_after_2"), isPro: false,
                                  now: t0.addingTimeInterval(25 * 3_600)),
                       .present(reason: "export_after_2", hard: false))
    }

    func testSoftEpisodeRearmsWhenReasonClears() {
        var e = PaywallTriggerEngine()
        _ = e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0)
        e.noteDismissed(now: t0)
        // Same reason after the cooldown is still the same episode: no re-present.
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false,
                                  now: t0.addingTimeInterval(25 * 3_600)), .none)
        // The reason clearing (the server consumed the trigger) re-arms it.
        XCTAssertEqual(e.evaluate(paywall: pw(false, nil), isPro: false,
                                  now: t0.addingTimeInterval(26 * 3_600)), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "second_composition"), isPro: false,
                                  now: t0.addingTimeInterval(26 * 3_600)),
                       .present(reason: "second_composition", hard: false))
    }

    // MARK: Engine — hard gates

    func testHardGatePresentsDespiteCooldownAndIneligibility() {
        var e = PaywallTriggerEngine()
        _ = e.evaluate(paywall: pw(true, "second_composition"), isPro: false, now: t0)
        e.noteDismissed(now: t0) // soft cooldown now running
        // At the AI limit (TOKEN_BUDGET_EXHAUSTED) the sheet is a gate: it presents even while
        // the server reports eligible == false for its dismiss cooldown.
        XCTAssertEqual(e.evaluate(paywall: pw(false, "ai_limit"), isPro: false,
                                  now: t0.addingTimeInterval(3_600)),
                       .present(reason: "ai_limit", hard: true))
        // Once per episode: refreshes while still at the limit do not re-present.
        XCTAssertEqual(e.evaluate(paywall: pw(false, "ai_limit"), isPro: false,
                                  now: t0.addingTimeInterval(2 * 3_600)), .none)
        // The episode ends when the limit clears; a later render limit is a new episode.
        XCTAssertEqual(e.evaluate(paywall: pw(false, nil), isPro: false,
                                  now: t0.addingTimeInterval(3 * 3_600)), .none)
        XCTAssertEqual(e.evaluate(paywall: pw(true, "render_limit"), isPro: false,
                                  now: t0.addingTimeInterval(3 * 3_600)),
                       .present(reason: "render_limit", hard: true))
    }

    // MARK: Persisted state

    func testTriggerStatePersistenceRoundTrip() throws {
        let suite = "PaywallTriggerTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var s = PaywallTriggerState()
        s.lastSoftShownAt = t0
        s.lastDismissedAt = t0
        s.softEpisodeReason = "export_after_2"
        s.hardEpisodeReason = "ai_limit"
        s.save(to: defaults)
        XCTAssertEqual(PaywallTriggerState.load(from: defaults), s)
        PaywallTriggerState().save(to: defaults)
        XCTAssertEqual(PaywallTriggerState.load(from: defaults), PaywallTriggerState())
    }

    // MARK: Watcher dismiss filter

    func testWatcherDismissReportsOnlyForTriggerReasons() throws {
        let suite = "PaywallTriggerTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var reported: [String] = []
        let watcher = PaywallTriggerWatcher(defaults: defaults)
        watcher.report = { reported.append($0) }
        // A manual open (Profile button) closing starts no cooldown and reports nothing.
        watcher.sheetReason = { "profile" }
        watcher.sheetDismissed()
        XCTAssertEqual(reported, [])
        XCTAssertNil(PaywallTriggerState.load(from: defaults).lastDismissedAt)
        // A trigger sheet closing reports the dismissal and persists the cooldown anchor.
        watcher.sheetReason = { "second_composition" }
        watcher.sheetDismissed()
        XCTAssertEqual(reported, ["paywall_dismiss"])
        XCTAssertNotNil(PaywallTriggerState.load(from: defaults).lastDismissedAt)
    }
}
