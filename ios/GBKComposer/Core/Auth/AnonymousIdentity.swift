import Foundation

/// Install-time anonymous identity: a friendly two-word username ("MellowFox", never digits) and a device UUID,
/// both kept in the Keychain. Used as the account identity before (and instead of) Apple/Google sign-in.
enum AnonymousIdentity {
    static let usernameKey = "anon.username"
    static let deviceIDKey = "anon.deviceId"

    static let adjectives = [
        "Mellow", "Sunny", "Gentle", "Brave", "Calm", "Cheerful", "Clever", "Cozy", "Dapper", "Eager",
        "Fancy", "Friendly", "Golden", "Happy", "Jolly", "Kind", "Lively", "Lucky", "Merry", "Nimble",
        "Plucky", "Quiet", "Rosy", "Silver", "Snappy", "Sparkly", "Swift", "Tidy", "Velvet", "Witty",
        "Bright", "Breezy", "Dreamy", "Fuzzy", "Humble", "Misty", "Peppy", "Bouncy", "Groovy", "Sleepy",
    ]
    static let nouns = [
        "Fox", "Otter", "Panda", "Robin", "Koala", "Badger", "Dolphin", "Falcon", "Heron", "Lark",
        "Maple", "Meadow", "Comet", "Harbor", "Pebble", "Willow", "Breeze", "Canyon", "River", "Sparrow",
        "Penguin", "Rabbit", "Turtle", "Owl", "Finch", "Lantern", "Cello", "Piano", "Banjo", "Tuba",
        "Melody", "Rhythm", "Ember", "Cloud", "Acorn", "Kitten", "Puffin", "Walrus", "Beacon", "Clover",
    ]

    /// A random adjective+noun not in `excluding` (case-insensitive). Letters only.
    static func generate<R: RandomNumberGenerator>(excluding: Set<String> = [], using rng: inout R) -> String {
        let taken = Set(excluding.map { $0.lowercased() })
        for _ in 0..<200 {
            let name = adjectives.randomElement(using: &rng)! + nouns.randomElement(using: &rng)!
            if !taken.contains(name.lowercased()) { return name }
        }
        for a in adjectives { for n in nouns where !taken.contains((a + n).lowercased()) { return a + n } }
        return adjectives[0] + nouns[0]
    }

    static func generate(excluding: Set<String> = []) -> String {
        var rng = SystemRandomNumberGenerator()
        return generate(excluding: excluding, using: &rng)
    }

    /// Server handle form: lowercase letters only (fits `a-z0-9_`, 3–20).
    static func handle(for username: String) -> String { username.lowercased() }

    /// Generated on first access (first launch) and persisted.
    static var username: String {
        if let name = Keychain.get(usernameKey), !name.isEmpty { return name }
        let name = generate()
        Keychain.set(name, for: usernameKey)
        return name
    }

    static func replaceUsername(excluding: Set<String>) -> String {
        let name = generate(excluding: excluding)
        Keychain.set(name, for: usernameKey)
        return name
    }

    static var deviceID: String {
        if let id = Keychain.get(deviceIDKey), !id.isEmpty { return id }
        let id = UUID().uuidString.lowercased()
        Keychain.set(id, for: deviceIDKey)
        return id
    }
}
