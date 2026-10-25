import XCTest
@testable import GBKComposer

@MainActor
final class AnonymousIdentityTests: XCTestCase {
    override func tearDown() async throws { AuthStore.shared.clearLocal() }

    func testNamesAreTwoCapitalisedWordsWithoutDigits() {
        for _ in 0..<500 {
            let name = AnonymousIdentity.generate()
            XCTAssertNil(name.rangeOfCharacter(from: .decimalDigits), name)
            XCTAssertTrue(name.allSatisfy(\.isLetter), name)
            XCTAssertTrue(AnonymousIdentity.adjectives.contains { adj in
                name.hasPrefix(adj) && AnonymousIdentity.nouns.contains(String(name.dropFirst(adj.count)))
            }, name)
            let handle = AnonymousIdentity.handle(for: name)
            XCTAssertTrue((3...20).contains(handle.count), handle)
            XCTAssertEqual(handle, handle.lowercased())
        }
    }

    func testRegenerateAvoidsTakenNames() {
        let taken: Set<String> = ["MellowFox", "SunnyOtter"]
        for _ in 0..<200 { XCTAssertFalse(taken.contains(AnonymousIdentity.generate(excluding: taken))) }
    }

    func testUsernamePersists() {
        XCTAssertEqual(AnonymousIdentity.username, AnonymousIdentity.username)
        XCTAssertFalse(AnonymousIdentity.deviceID.isEmpty)
    }

    func testCollisionRegeneratesTwoWordNameNotDigits() async {
        AuthStore.shared.clearLocal()
        let first = AnonymousIdentity.username
        let mock = MockAuthService()
        mock.takenHandles = [AnonymousIdentity.handle(for: first)]
        let store = AuthStore()
        await store.ensureAnonymousSession(service: mock)
        XCTAssertTrue(store.isSignedIn)
        XCTAssertFalse(store.isLinkedAccount, "anonymous session is not a linked account")
        let now = AnonymousIdentity.username
        XCTAssertNotEqual(now.lowercased(), first.lowercased())
        XCTAssertNil(now.rangeOfCharacter(from: .decimalDigits))
        XCTAssertEqual(store.me?.handle, AnonymousIdentity.handle(for: now))
        store.clearLocal()
    }

    func testMissingEndpointStaysSignedOut() async {
        AuthStore.shared.clearLocal()
        final class Unavailable: MockAuthService {
            override func registerAnonymous(deviceID: String, username: String) async throws -> TokenPair {
                throw APIError.notAvailable
            }
        }
        let store = AuthStore()
        await store.ensureAnonymousSession(service: Unavailable())
        XCTAssertFalse(store.isSignedIn)
    }
}
