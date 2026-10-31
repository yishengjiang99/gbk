import XCTest
import UserNotifications
@testable import GBKComposer

/// #137: push was dead end-to-end — `enable()` had no call site, taps were never
/// routed, and TestFlight registered as production. These tests pin the opt-in
/// gate, the payload/link routing, and the provisioning-based APNs environment.
@MainActor
final class PushManagerTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suite = "test.push.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private final class FakeCenter: NotificationAuthorizing {
        var status: UNAuthorizationStatus
        var grantOnRequest = true
        private(set) var requestCount = 0
        init(status: UNAuthorizationStatus) { self.status = status }
        func authorizationStatus() async -> UNAuthorizationStatus { status }
        func requestAuthorization() async throws -> Bool {
            requestCount += 1
            if grantOnRequest { status = .authorized }
            return grantOnRequest
        }
    }

    private func makeManager(center: FakeCenter, register: @escaping () -> Void = {}, unregister: @escaping () -> Void = {}) -> PushManager {
        PushManager(center: center, service: MockAuthService(), defaults: defaults,
                    registerRemote: register, unregisterRemote: unregister)
    }

    // MARK: Opt-in gate (fix 1: the Profile toggle calls exactly these)

    func testEnablePromptsOnceAndRegistersWhenGranted() async {
        let center = FakeCenter(status: .notDetermined)
        var registers = 0
        let push = makeManager(center: center, register: { registers += 1 })
        let ok = await push.enable()
        XCTAssertTrue(ok)
        XCTAssertTrue(push.enabledInApp)
        XCTAssertTrue(defaults.bool(forKey: PushManager.enabledKey))
        XCTAssertEqual(center.requestCount, 1)
        XCTAssertEqual(registers, 1)
        XCTAssertEqual(push.status, .authorized)
    }

    func testEnableWhenAlreadyAuthorizedDoesNotPromptAgain() async {
        let center = FakeCenter(status: .authorized)
        var registers = 0
        let push = makeManager(center: center, register: { registers += 1 })
        XCTAssertTrue(await push.enable())
        XCTAssertEqual(center.requestCount, 0)
        XCTAssertEqual(registers, 1)
    }

    func testEnableWhenDeniedStaysOffAndNeverRegisters() async {
        let center = FakeCenter(status: .denied)
        var registers = 0
        let push = makeManager(center: center, register: { registers += 1 })
        let ok = await push.enable()
        XCTAssertFalse(ok)
        XCTAssertFalse(push.enabledInApp)
        XCTAssertFalse(defaults.bool(forKey: PushManager.enabledKey))
        XCTAssertEqual(registers, 0)
    }

    func testEnableWhenUserDeclinesThePromptStaysOff() async {
        let center = FakeCenter(status: .notDetermined)
        center.grantOnRequest = false
        var registers = 0
        let push = makeManager(center: center, register: { registers += 1 })
        XCTAssertFalse(await push.enable())
        XCTAssertFalse(push.enabledInApp)
        XCTAssertEqual(registers, 0)
    }

    func testDisableUnregistersAndPersistsOff() async {
        defaults.set(true, forKey: PushManager.enabledKey)
        var unregisters = 0
        let push = makeManager(center: FakeCenter(status: .authorized), unregister: { unregisters += 1 })
        XCTAssertTrue(push.enabledInApp, "toggle state restores from defaults")
        await push.disable()
        XCTAssertFalse(push.enabledInApp)
        XCTAssertFalse(defaults.bool(forKey: PushManager.enabledKey))
        XCTAssertEqual(unregisters, 1)
    }

    func testRefreshNeverRegistersWhenToggleIsOff() async {
        var registers = 0
        let push = makeManager(center: FakeCenter(status: .authorized), register: { registers += 1 })
        await push.refresh()
        XCTAssertEqual(registers, 0, "no opt-in, no registration — the prompt/registration only follows enable()")
        XCTAssertEqual(push.status, .authorized)
    }

    // MARK: Payload routing (fix 2)

    func testPayloadLinkParsesForCommentForkAndDM() {
        let comment: [AnyHashable: Any] = ["kind": "comment", "link": "https://compose.grepawk.com/s/ember-crown-rmpaqyj8"]
        XCTAssertEqual(PushPayload.linkURL(from: comment), URL(string: "https://compose.grepawk.com/s/ember-crown-rmpaqyj8"))
        XCTAssertEqual(DeepLink(url: PushPayload.linkURL(from: comment)!), .share(slug: "ember-crown-rmpaqyj8"))
        let dm: [AnyHashable: Any] = ["kind": "dm", "link": "https://compose.grepawk.com/inbox/maestroaria"]
        XCTAssertEqual(DeepLink(url: PushPayload.linkURL(from: dm)!), .inbox(handle: "maestroaria"))
    }

    func testPayloadRejectsForeignOrMalformedLinks() {
        XCTAssertNil(PushPayload.linkURL(from: ["kind": "comment", "link": "https://evil.example.com/s/ember-crown-rmpaqyj8"]))
        XCTAssertNil(PushPayload.linkURL(from: ["kind": "comment", "link": "not a url"]))
        XCTAssertNil(PushPayload.linkURL(from: ["kind": "comment"]))
        XCTAssertNil(PushPayload.linkURL(from: [:]))
    }

    func testDMFallbackRoutesToOwnInboxOnlyForDMs() {
        let url = PushPayload.linkURL(from: ["kind": "dm"], fallbackHandle: "maestroaria")
        XCTAssertEqual(url, URL(string: "https://compose.grepawk.com/inbox/maestroaria"))
        XCTAssertNil(PushPayload.linkURL(from: ["kind": "comment"], fallbackHandle: "maestroaria"))
        XCTAssertNil(PushPayload.linkURL(from: ["kind": "dm"], fallbackHandle: nil))
    }

    func testPushLinkStoreConsumesExactlyOnce() {
        let store = PushLinkStore()
        XCTAssertNil(store.consume())
        let url = URL(string: "https://compose.grepawk.com/inbox/maestroaria")!
        store.enqueue(url)
        XCTAssertEqual(store.consume(), url)
        XCTAssertNil(store.consume(), "a consumed tap must not re-route on the next foreground")
    }

    // MARK: APNs environment (fix 3)

    func testEnvironmentResolutionMatrix() {
        // Xcode / dev install: development entitlement.
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: "development", isTestFlight: false, hasEmbeddedProfile: true, receiptIsSandbox: true), "sandbox")
        // Ad hoc / enterprise: production entitlement.
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: "production", isTestFlight: false, hasEmbeddedProfile: true, receiptIsSandbox: false), "production")
        // TestFlight: Release build, distribution-looking profile — still sandbox tokens.
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: "production", isTestFlight: true, hasEmbeddedProfile: true, receiptIsSandbox: true), "sandbox")
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: nil, isTestFlight: true, hasEmbeddedProfile: true, receiptIsSandbox: true), "sandbox")
        // App Store: no embedded profile, real receipt.
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: nil, isTestFlight: false, hasEmbeddedProfile: false, receiptIsSandbox: false), "production")
        // Sandbox receipt without a parseable entitlement (TestFlight-shaped).
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: nil, isTestFlight: false, hasEmbeddedProfile: true, receiptIsSandbox: true), "sandbox")
        // Profile present but entitlement unreadable: not an App Store install.
        XCTAssertEqual(APNsEnvironment.resolve(apsEnvironment: nil, isTestFlight: false, hasEmbeddedProfile: true, receiptIsSandbox: false), "sandbox")
    }

    func testProvisioningProfileParsingExtractsEntitlements() throws {
        let profile: [String: Any] = [
            "AppIDName": "GBK",
            "Entitlements": ["aps-environment": "development", "beta-reports-active": true]
        ]
        let xml = try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
        var blob = Data([0x30, 0x82, 0xFF, 0x00]) // CMS signature junk around the plist
        blob.append(xml)
        blob.append(Data([0x00, 0x42, 0x13]))
        let parsed = try XCTUnwrap(APNsEnvironment.provisioningProfile(in: blob))
        let entitlements = try XCTUnwrap(parsed["Entitlements"] as? [String: Any])
        XCTAssertEqual(entitlements["aps-environment"] as? String, "development")
        XCTAssertEqual(entitlements["beta-reports-active"] as? Bool, true)
        XCTAssertNil(APNsEnvironment.provisioningProfile(in: Data([0x01, 0x02, 0x03])))
    }

    func testCurrentEnvironmentIsAValidGateway() {
        XCTAssertTrue(["sandbox", "production"].contains(PushManager.apnsEnvironment))
    }
}
