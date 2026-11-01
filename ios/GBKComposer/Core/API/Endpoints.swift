import Foundation

enum HTTPMethod: String { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

struct Endpoint {
    var path: String
    var method: HTTPMethod = .get
    var query: [URLQueryItem] = []
    var body: [String: Any]? = nil
    /// Skip the automatic refresh-and-retry on 401 (used by the auth endpoints themselves).
    var isAuthCall = false
    var headers: [String: String] = [:]
}

enum FeedSort: String, CaseIterable, Identifiable {
    case forYou = "for_you", new, top
    var id: String { rawValue }
    var title: String {
        switch self { case .forYou: return "For you"; case .new: return "New"; case .top: return "Top" }
    }
}

struct FeedQuery: Equatable {
    var sort: FeedSort = .forYou
    var label: String? = nil
    var tag: String? = nil
}

private func q(_ name: String, _ value: String?) -> [URLQueryItem] {
    guard let value, !value.isEmpty else { return [] }
    return [URLQueryItem(name: name, value: value)]
}

enum Endpoints {
    // MARK: Feed & songs (P1, live)
    static func feed(_ query: FeedQuery, cursor: String?, limit: Int = 20) -> Endpoint {
        Endpoint(path: "/api/feed", query: q("sort", query.sort.rawValue) + q("label", query.label) + q("tag", query.tag)
                 + q("cursor", cursor) + q("limit", String(limit)) + q("session", ImpressionLogger.session))
    }
    static func tag(_ tag: String, cursor: String?) -> Endpoint { Endpoint(path: "/api/tags/\(tag)", query: q("cursor", cursor)) }
    static func topTags(limit: Int = 20) -> Endpoint { Endpoint(path: "/api/tags/top", query: q("limit", String(limit))) }
    static func song(_ slug: String) -> Endpoint { Endpoint(path: "/api/songs/\(slug)") }
    static func play(_ slug: String) -> Endpoint { Endpoint(path: "/api/shares/\(slug)/play", method: .post, body: [:]) }

    // MARK: Ratings & comments (P1, live)
    static func rate(_ slug: String, stars: Int) -> Endpoint {
        Endpoint(path: "/api/shares/\(slug)/rating", method: .put, body: ["stars": stars])
    }
    static func clearRating(_ slug: String) -> Endpoint { Endpoint(path: "/api/shares/\(slug)/rating", method: .delete) }
    static func comments(_ slug: String, order: String = "new", cursor: String?) -> Endpoint {
        Endpoint(path: "/api/shares/\(slug)/comments", query: q("order", order) + q("cursor", cursor))
    }
    static func postComment(_ slug: String, body: String) -> Endpoint {
        Endpoint(path: "/api/shares/\(slug)/comments", method: .post, body: ["body": body])
    }
    static func deleteComment(_ id: String) -> Endpoint { Endpoint(path: "/api/comments/\(id)", method: .delete) }

    // MARK: Profiles (P1, live)
    static let me = Endpoint(path: "/api/me")
    /// Paywall engagement report (#115): `event` is `paywall_view`, `paywall_dismiss` or `export`;
    /// the reply carries the fresh `{ usage, paywall }`.
    static func meEngagement(event: String) -> Endpoint {
        Endpoint(path: "/api/me/engagement", method: .post, body: ["event": event])
    }
    static func user(_ handle: String, cursor: String?) -> Endpoint { Endpoint(path: "/api/users/\(handle.hasPrefix("@") ? String(handle.dropFirst()) : handle)", query: q("cursor", cursor)) }

    // MARK: Reports (P1, live) / blocks (P4, not live)
    static func report(kind: String, target: String, reason: String) -> Endpoint {
        Endpoint(path: "/api/reports", method: .post, body: ["kind": kind, "target": target, "reason": reason])
    }
    static func block(_ handle: String) -> Endpoint { Endpoint(path: "/api/blocks/\(handle)", method: .post, body: [:]) }
    static func unblock(_ handle: String) -> Endpoint { Endpoint(path: "/api/blocks/\(handle)", method: .delete) }

    // MARK: Native auth (live; Apple answers 503 until configured)
    static func appleExchange(identityToken: String, nonce: String, displayName: String?) -> Endpoint {
        var b: [String: Any] = ["identityToken": identityToken, "nonce": nonce]
        if let displayName { b["displayName"] = displayName }
        return Endpoint(path: "/api/auth/apple", method: .post, body: b, isAuthCall: true)
    }
    static func googleExchange(idToken: String) -> Endpoint {
        Endpoint(path: "/api/auth/google/native", method: .post, body: ["idToken": idToken], isAuthCall: true)
    }
    static func refresh(_ refreshToken: String) -> Endpoint {
        Endpoint(path: "/api/auth/refresh", method: .post, body: ["refresh_token": refreshToken], isAuthCall: true)
    }
    static func logout(refreshToken: String?) -> Endpoint {
        Endpoint(path: "/api/auth/logout", method: .post, body: refreshToken.map { ["refresh_token": $0] } ?? [:], isAuthCall: true)
    }
    static let webCode = Endpoint(path: "/api/auth/web-code", method: .post, body: [:])
    static func webCodeRedeemPath(code: String, returnPath: String) -> Endpoint {
        Endpoint(path: "/api/auth/web-code/redeem", query: q("code", code) + q("return", returnPath))
    }
    static let deleteMe = Endpoint(path: "/api/me", method: .delete)

    /// Guest account (docs/social-api.md "Guest accounts", spec 7692a7a; 404 until deployed):
    /// `{ deviceId, username }` → TokenPair. Idempotent per device; 409 HANDLE_TAKEN for a new device whose handle exists.
    static func anonymous(deviceID: String, username: String) -> Endpoint {
        Endpoint(path: "/api/auth/anonymous", method: .post, body: ["deviceId": deviceID, "username": username], isAuthCall: true)
    }

    // MARK: Push (live)
    static func pushRegister(installId: String, token: String, environment: String) -> Endpoint {
        Endpoint(path: "/api/push/register", method: .post, body: ["installId": installId, "token": token, "environment": environment])
    }
    static func pushUnregister(installId: String) -> Endpoint {
        Endpoint(path: "/api/push/unregister", method: .post, body: ["installId": installId])
    }
}
