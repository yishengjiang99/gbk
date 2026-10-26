import Foundation

/// What the native publish sheet sends. Mirrors web PublishDialog + docs/social-api.md
/// (`PATCH /api/shares/:slug` `{ title, public: true }`, `PATCH /api/songs/:slug/meta` `{ labels, tags, prompt_shared }`).
struct PublishDraft: Equatable {
    static let labelOptions = ["ambient", "lofi", "classical", "jazz", "rnb", "electronic", "cinematic", "game", "pop", "experimental", "wip"]
    static let maxLabels = 3, maxTags = 10, maxTagLength = 32

    var title = ""
    var labels: [String] = []
    var tags: [String] = []
    var sharePrompt = false

    mutating func toggleLabel(_ l: String) {
        if let i = labels.firstIndex(of: l) { labels.remove(at: i) } else if labels.count < Self.maxLabels { labels.append(l) }
    }

    /// Plain-text tags like the web: lowercased, `#` and spaces stripped, deduped, ≤10.
    @discardableResult mutating func addTags(_ raw: String) -> Bool {
        var added = false
        for part in raw.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }) {
            let t = String(part.lowercased().drop(while: { $0 == "#" }).prefix(Self.maxTagLength))
            guard !t.isEmpty, !tags.contains(t), tags.count < Self.maxTags else { continue }
            tags.append(t); added = true
        }
        return added
    }

    var canPublish: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }
}

struct PublishResult: Equatable { let slug: String; let url: URL; let author: String }

protocol GuestPublishing {
    func publish(_ draft: PublishDraft, as username: String) async throws -> PublishResult
}

enum GuestPublishServices {
    /// Mocked until GBK Social ships the guest-publish contract (guest identity header or token).
    static var current: GuestPublishing = MockGuestPublishService()
}

struct MockGuestPublishService: GuestPublishing {
    func publish(_ draft: PublishDraft, as username: String) async throws -> PublishResult {
        try? await Task.sleep(nanoseconds: 400_000_000)
        let base = draft.title.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        let slug = String(String(base).split(separator: "-").joined(separator: "-").prefix(40)) + "-guest"
        return PublishResult(slug: slug, url: URL(string: "https://compose.grepawk.com/s/\(slug)")!, author: username)
    }
}
