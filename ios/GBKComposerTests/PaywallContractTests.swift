import XCTest
@testable import GBKComposer

/// Behavior for the paywall contract: 402 decode, export check gating, 3rd-song shown once.
@MainActor
final class PaywallContractTests: XCTestCase {
    override func setUp() {
        StubProtocol.handler = nil
        StubProtocol.requests = []
    }

    override func tearDown() {
        PaywallPresentation.handler = { PurchaseStore.shared.presentPaywall(reason: $0) }
        StubProtocol.handler = nil
        StubProtocol.requests = []
    }

    func test402DecodePresentsTheReason() async {
        var presented: [String] = []
        PaywallPresentation.handler = { presented.append($0) }
        let client = APIClient(session: StubProtocol.session(), tokenProvider: { nil }, testMode: true)
        let export = """
        {"code":"PRO_REQUIRED","reason":"export","message":"Exporting songs is a GBK Pro feature.","signed_in":false,\
        "paywall":{"reason":"export","hard":true,"default_plan":"pro_yearly","trial_days":7,\
        "pricing_url":"https://compose.grepawk.com/pricing?plan=pro_yearly&reason=export"}}
        """
        StubProtocol.handler = { _ in (402, export) }
        do {
            _ = try await client.send(Endpoints.paywallCheck(action: "export", kind: "midi"), as: OKResult.self)
            XCTFail("expected paywall")
        } catch APIError.paywall(let p) {
            XCTAssertEqual(p.code, "PRO_REQUIRED")
            XCTAssertEqual(p.effectiveReason, "export")
            XCTAssertTrue(p.isHard)
            XCTAssertEqual(p.message, "Exporting songs is a GBK Pro feature.")
            XCTAssertEqual(p.paywall?.defaultPlan, "pro_yearly")
        } catch {
            XCTFail("wrong error: \(error)")
        }
        XCTAssertEqual(presented, ["export"])
        XCTAssertEqual(StubProtocol.requests.first?.value(forHTTPHeaderField: "X-GBK-Test"), "1")

        let ai = #"{"code":"AI_BUDGET_EXHAUSTED","reason":"ai_budget","message":"Daily AI budget used up.","signed_in":true,"paywall":{"reason":"ai_budget","hard":true,"default_plan":"pro_yearly","trial_days":7,"pricing_url":"https://compose.grepawk.com/pricing?plan=pro_yearly&reason=ai_budget"}}"#
        StubProtocol.handler = { _ in (402, ai) }
        do {
            _ = try await client.send(Endpoints.me, as: Me.self)
            XCTFail("expected paywall")
        } catch APIError.paywall(let p) {
            XCTAssertEqual(p.effectiveReason, "ai_budget")
            XCTAssertTrue(p.isHard)
        } catch {
            XCTFail("wrong error: \(error)")
        }
        XCTAssertEqual(presented, ["export", "ai_budget"])
    }

    func testExportCheckGatesOnlyOn402() async {
        var presented: [String] = []
        PaywallPresentation.handler = { presented.append($0) }
        let client = APIClient(session: StubProtocol.session(), tokenProvider: { nil }, testMode: false)

        StubProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/api/paywall/check")
            XCTAssertEqual(req.httpMethod, "POST")
            let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: String]) ?? [:]
            XCTAssertEqual(body["action"], "export")
            XCTAssertEqual(body["kind"], "midi")
            XCTAssertNil(req.value(forHTTPHeaderField: "X-GBK-Test"))
            return (200, #"{"ok":true,"pro":true}"#)
        }
        var allowed = await Paywall.allowExport(kind: .midi, client: client)
        XCTAssertTrue(allowed)
        XCTAssertTrue(presented.isEmpty)

        StubProtocol.handler = { _ in
            (402, #"{"code":"PRO_REQUIRED","reason":"export","message":"Pro only.","signed_in":false,"paywall":{"reason":"export","hard":true,"default_plan":"pro_yearly","trial_days":7,"pricing_url":"https://x"}}"#)
        }
        allowed = await Paywall.allowExport(kind: .wav, client: client)
        XCTAssertFalse(allowed)
        XCTAssertEqual(presented, ["export"])

        presented.removeAll()
        StubProtocol.handler = { _ in (404, #"{"code":"NOT_FOUND"}"#) }
        allowed = await Paywall.allowExport(kind: .midi, client: client)
        XCTAssertTrue(allowed, "404 before the route ships must not block the export")
        XCTAssertTrue(presented.isEmpty)

        StubProtocol.handler = { _ in (500, #"{"code":"INTERNAL"}"#) }
        allowed = await Paywall.allowExport(kind: .wav, client: client)
        XCTAssertTrue(allowed)
        XCTAssertTrue(presented.isEmpty)
    }

    func testThirdSongShownOnce() throws {
        let suite = "ThirdSong-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(Paywall.shouldShowThirdSong(isPro: true, seen: false, existingSongs: 2))
        XCTAssertFalse(Paywall.shouldShowThirdSong(isPro: false, seen: true, existingSongs: 2))
        XCTAssertFalse(Paywall.shouldShowThirdSong(isPro: false, seen: false, existingSongs: 1))
        XCTAssertTrue(Paywall.shouldShowThirdSong(isPro: false, seen: false, existingSongs: 2))

        let me = try APIClient.makeDecoder().decode(Me.self, from: Data(
            #"{"id":"a","handle":"h","song_count":3,"pro":false,"paywall":{"eligible":false,"reason":null,"cooldown_until":null,"third_song_seen":false}}"#.utf8))
        var presented: [String] = []
        XCTAssertTrue(ThirdSongGate.maybePresent(me: me, isPro: false, defaults: defaults, present: { presented.append($0) }))
        XCTAssertEqual(presented, ["third_song"])
        XCTAssertTrue(ThirdSongGate.seenLocal(defaults: defaults))
        XCTAssertFalse(ThirdSongGate.maybePresent(me: me, isPro: false, defaults: defaults, present: { presented.append($0) }))
        XCTAssertEqual(presented, ["third_song"])

        defaults.removeObject(forKey: ThirdSongGate.defaultsKey)
        let seen = try APIClient.makeDecoder().decode(Me.self, from: Data(
            #"{"id":"a","handle":"h","song_count":3,"paywall":{"eligible":false,"reason":null,"cooldown_until":null,"third_song_seen":true}}"#.utf8))
        XCTAssertFalse(ThirdSongGate.maybePresent(me: seen, isPro: false, defaults: defaults, present: { presented.append($0) }))
        XCTAssertTrue(ThirdSongGate.seenLocal(defaults: defaults))
        XCTAssertEqual(presented, ["third_song"])
    }
}
