import Foundation

// Shapes from docs/social-api.md (v1), checked against prod (44b3be2).
// Decoded with APIClient.makeDecoder() (convertFromSnakeCase). Times are epoch milliseconds.

struct User: Codable, Hashable, Identifiable {
    let handle: String
    let displayName: String?
    let avatarUrl: String?
    let songCount: Int?
    let ratingAvg: Double?
    let createdAt: Int64?
    /// Public Pro flag (#133): bare boolean from the server; no source or expiry is ever exposed.
    var pro: Bool? = nil
    /// Public author badge (e.g. "AI artist"), shown next to the handle like the web card.
    var badge: String? = nil
    var id: String { handle }
}

/// `Me` = User + private fields.
struct Me: Codable, Hashable {
    let id: String
    let handle: String
    let displayName: String?
    let avatarUrl: String?
    let songCount: Int?
    let ratingAvg: Double?
    let createdAt: Int64?
    let dmPolicy: String?
    let handleChanged: Bool?
    let isAdmin: Bool?
    /// `"google"|"apple"|"phone"|"github"|"guest"` (guest-accounts spec).
    let provider: String?
    let isGuest: Bool?
    /// Entitlements (social-api.md "Entitlements in GET /api/me"), guests too.
    var pro: Bool? = nil
    /// `"stripe" | "apple" | nil`
    var proSource: String? = nil
    /// Unix ms; nil = lifetime (or no Pro).
    var proExpiresAt: Int64? = nil
    /// `"Production" | "Sandbox" | nil`
    var proEnvironment: String? = nil
    /// Paywall eligibility from the server's engagement counters (#115); the client trigger is #123.
    var paywall: MePaywall? = nil

    /// Server says Pro and it hasn't expired.
    func hasActivePro(now: Date = Date()) -> Bool {
        guard pro == true else { return false }
        guard let e = proExpiresAt else { return true }
        return Double(e) / 1000 > now.timeIntervalSince1970
    }

    var asUser: User {
        User(handle: handle, displayName: displayName, avatarUrl: avatarUrl, songCount: songCount, ratingAvg: ratingAvg, createdAt: createdAt, pro: pro)
    }
}

/// The `paywall` object in `GET /api/me` (#115): whether the server wants the native paywall shown,
/// and why. Soft reasons are the engagement triggers (`second_composition`: the 2nd composition
/// completed; `export_after_2`: a WAV/MIDI export after that paywall was seen). Hard reasons mean the
/// account is at a real limit right now (`ai_limit`: daily AI budget, TOKEN_BUDGET_EXHAUSTED;
/// `render_limit`). `eligible` already excludes Pro users and the server-side 24 h post-dismiss
/// cooldown, but `reason` stays populated while `eligible` is false, so the client can still
/// hard-present at a live limit (#123).
struct MePaywall: Codable, Hashable {
    let eligible: Bool
    let reason: String?
    /// Unix ms when the server cooldown ends; nil when not cooling down.
    let cooldownUntil: Int64?

    static let softReasons: Set<String> = ["second_composition", "export_after_2"]
    static let hardReasons: Set<String> = ["ai_limit", "render_limit"]
}

struct SongMedia: Codable, Hashable {
    let mp3: String?
    let wav: String?
    let midi: String?
}

/// Piano-roll preview. Prod shape (src/agent/piano-roll-preview.ts):
/// `{ tracks: [color], lo, hi, end, notes: [[trackIndex, start, length, pitch]] }`.
/// The doc says `{ notes: [[pitch,start,dur,track]], duration }`; both decode here.
struct SongPreview: Codable, Hashable {
    let tracks: [String]?
    let lo: Double?
    let hi: Double?
    let end: Double?
    let duration: Double?
    let notes: [[Double]]?
}

/// Feed item / song detail (`GET /api/feed`, `GET /api/songs/:slug`).
struct Song: Codable, Hashable, Identifiable {
    let slug: String
    let title: String
    let url: String?
    let author: User
    let createdAt: Int64
    let publishedAt: Int64?
    let labels: [String]
    let tags: [String]
    var ratingAvg: Double?
    var ratingCount: Int
    var commentCount: Int
    var playCount: Int
    let forkCount: Int
    var myRating: Int?
    let media: SongMedia?
    let preview: SongPreview?
    let promptShared: Bool?
    let promptText: String?
    let parentSlug: String?
    let isMine: Bool

    var id: String { slug }
    var mp3URL: URL? { media?.mp3.flatMap(URL.init(string:)) }
    /// What the feed plays: the song's MIDI, sequenced live through SF2Engine (no MP3/WAV playback).
    var midiURL: URL? { media?.midi.flatMap(URL.init(string:)) }
    /// Public song page; opening it in the app shows this card (DeepLink.share).
    var shareURL: URL { URL(string: "https://\(DeepLink.host)/s/\(slug)")! }
}

/// Generic cursor page: `{ items: [...], next_cursor }`.
struct Page<Item: Codable>: Codable {
    let items: [Item]
    let nextCursor: String?
    /// Feed only: ranker version that produced this page (logged with each impression).
    var modelVersion: String? = nil
}
typealias FeedPage = Page<Song>

struct UserProfilePage: Codable {
    let user: User
    let songs: [Song]
    let nextCursor: String?
}

struct RatingSummary: Codable, Hashable {
    let ratingAvg: Double?
    let ratingCount: Int
    let myRating: Int?
}

struct Comment: Codable, Hashable, Identifiable {
    let id: String
    let author: User
    let body: String
    let createdAt: Int64
    let canDelete: Bool
}

struct ReportResult: Codable { let ok: Bool; let id: String? }
struct OKResult: Codable { let ok: Bool }
struct PushUnregisterResult: Codable { let ok: Bool; let removed: Bool? }

struct TagCount: Codable, Hashable { let tag: String; let count: Int }
struct LabelCount: Codable, Hashable { let label: String; let count: Int }
struct TopTags: Codable { let tags: [TagCount]; let labels: [LabelCount]? }

struct TokenPair: Codable {
    let accessToken: String
    let tokenType: String?
    let expiresIn: Int?
    let refreshToken: String?
    let me: Me?
    /// Upgrade result when a guest bearer was sent with Apple/Google sign-in: "linked" | "merged".
    let upgraded: String?

    init(accessToken: String, tokenType: String?, expiresIn: Int?, refreshToken: String?, me: Me?, upgraded: String? = nil) {
        self.accessToken = accessToken; self.tokenType = tokenType; self.expiresIn = expiresIn
        self.refreshToken = refreshToken; self.me = me; self.upgraded = upgraded
    }
}

struct WebCode: Codable { let code: String; let expiresIn: Int? }

/// P4 (not live). `Message` = `{ id, from: handle, body, share: Song|null, created_at }`.
struct Message: Codable, Hashable, Identifiable {
    let id: String
    let from: String
    let body: String
    let share: Song?
    let createdAt: Int64
}

/// P4 inbox row: `{ with: User, last: Message, unread, updated_at }`.
struct Conversation: Codable, Hashable, Identifiable {
    let with: User
    let last: Message?
    let unread: Int
    let updatedAt: Int64
    var id: String { with.handle }
}

/// Fixed label set from the doc.
enum SongLabel {
    static let all = ["ambient", "lofi", "classical", "jazz", "rnb", "electronic", "cinematic", "game", "pop", "experimental", "wip"]
}

struct APIErrorBody: Codable, Hashable { let code: String?; let message: String? }
