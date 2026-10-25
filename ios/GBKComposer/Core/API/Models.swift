import Foundation

/// Mirrors ShareView in server/src (store.view()).
struct Share: Codable, Identifiable, Hashable {
    struct ParentRef: Codable, Hashable { let slug: String; let title: String; let owner: String }
    let slug: String
    let title: String
    let owner: String
    let createdAt: String
    let updatedAt: String?
    let `public`: Bool
    let projectId: String?
    let parent: ParentRef?
    let hasMidi: Bool
    let hasWav: Bool
    let hasMp3: Bool
    let forks: Int?
    /// Present on create/detail responses only.
    let url: String?

    var id: String { slug }
}

/// One page of feed items. `nextCursor` is reserved for the future /api/feed endpoint.
struct FeedPage: Codable {
    let shares: [Share]
    var nextCursor: String? = nil
}

struct Profile: Codable, Identifiable, Hashable {
    let user: String
    let displayName: String?
    let avatarURL: URL?
    var id: String { user }
}

struct Conversation: Codable, Identifiable, Hashable {
    let id: String
    let participants: [String]
    let lastMessage: Message?
    let updatedAt: String
}

struct Message: Codable, Identifiable, Hashable {
    let id: String
    let conversationId: String
    let sender: String
    let text: String
    let createdAt: String
    let shareSlug: String?
}
