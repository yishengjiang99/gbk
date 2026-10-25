import Foundation

enum APIError: Error, Equatable {
    case badStatus(Int, APIErrorBody?)
    /// 404 (missing resource / route) or 503 (feature not configured on the server, e.g. APPLE_UNAVAILABLE).
    case notAvailable
    case unauthenticated
    case invalidURL
    /// 429 with the server's `retry-after` seconds (when sent) and body (e.g. guests' 20 comments/day).
    case rateLimited(retryAfter: TimeInterval?, APIErrorBody?)

    var userMessage: String {
        switch self {
        case .notAvailable: return "This isn't available yet."
        case .unauthenticated: return "Please sign in first."
        case .badStatus(_, let body): return body?.message ?? "Something went wrong."
        case .invalidURL: return "Something went wrong."
        case .rateLimited(_, let body): return body?.message ?? "Slow down a little and try again."
        }
    }
}

/// Cursor-paged feed source (`GET /api/feed`).
protocol FeedProviding {
    func feedPage(_ query: FeedQuery, cursor: String?, limit: Int) async throws -> FeedPage
}

protocol APIClientProtocol: FeedProviding {
    var baseURL: URL { get }
    func send<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T
}

final class APIClient: APIClientProtocol {
    static let shared = APIClient()
    static let defaultBaseURL = URL(string: "https://compose.grepawk.com")!

    static func makeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    let baseURL: URL
    private let session: URLSession
    private let tokenProvider: () -> String?
    private let decoder = APIClient.makeDecoder()

    init(baseURL: URL = APIClient.defaultBaseURL,
         session: URLSession = .shared,
         tokenProvider: @escaping () -> String? = { AuthStore.currentAccessToken() }) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    func url(for endpoint: Endpoint) throws -> URL {
        guard var comps = URLComponents(url: baseURL.appendingPathComponent(endpoint.path), resolvingAgainstBaseURL: false)
        else { throw APIError.invalidURL }
        if !endpoint.query.isEmpty { comps.queryItems = endpoint.query }
        guard let url = comps.url else { throw APIError.invalidURL }
        return url
    }

    func request(for endpoint: Endpoint) throws -> URLRequest {
        var req = URLRequest(url: try url(for: endpoint))
        req.httpMethod = endpoint.method.rawValue
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = endpoint.body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        // Bearer only; never cookies (doc: never send both).
        req.httpShouldHandleCookies = false
        for (k, v) in endpoint.headers { req.setValue(v, forHTTPHeaderField: k) }
        if let token = tokenProvider() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    func send<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        do {
            return try await perform(endpoint, as: type)
        } catch APIError.unauthenticated where !endpoint.isAuthCall {
            guard await refreshTokens() else { throw APIError.unauthenticated }
            return try await perform(endpoint, as: type)
        }
    }

    /// Like `send`, but returns nil when the endpoint is not deployed yet (404).
    func sendIfAvailable<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T? {
        do { return try await send(endpoint, as: type) } catch APIError.notAvailable { return nil }
    }

    private func perform<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request(for: endpoint))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = try? decoder.decode(APIErrorBody.self, from: data)
            switch http.statusCode {
            case 401: throw APIError.unauthenticated
            case 404, 503: throw APIError.notAvailable
            case 429: throw APIError.rateLimited(retryAfter: (http.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init), body)
            default: throw APIError.badStatus(http.statusCode, body)
            }
        }
        return try decoder.decode(T.self, from: data)
    }

    /// On a 401: rotate tokens with `POST /api/auth/refresh` (the old refresh token is revoked server-side).
    /// A rejected refresh (401 INVALID_REFRESH) signs out locally. Concurrent 401s share one refresh.
    func refreshTokens() async -> Bool {
        if let inFlight = await RefreshGate.shared.current() { return await inFlight.value }
        let task = Task<Bool, Never> {
            guard let refresh = AuthStore.currentRefreshToken() else { return false }
            do {
                let pair = try await AuthServices.current.refresh(refreshToken: refresh)
                await AuthStore.shared.store(pair)
                return true
            } catch APIError.unauthenticated {
                await AuthStore.shared.clearLocal()
                return false
            } catch {
                return false
            }
        }
        await RefreshGate.shared.set(task)
        let ok = await task.value
        await RefreshGate.shared.set(nil)
        return ok
    }

    // MARK: Convenience

    func feedPage(_ query: FeedQuery, cursor: String?, limit: Int = 20) async throws -> FeedPage {
        if let tag = query.tag, query.label == nil, query.sort == .forYou {
            return try await send(Endpoints.tag(tag, cursor: cursor), as: FeedPage.self)
        }
        return try await send(Endpoints.feed(query, cursor: cursor, limit: limit), as: FeedPage.self)
    }

    func mediaURL(slug: String, kind: String = "mp3") -> URL {
        baseURL.appendingPathComponent("/api/shares/\(slug)/media/\(kind)")
    }

}

/// Serialises token refreshes so parallel 401s don't burn the rotating refresh token twice.
actor RefreshGate {
    static let shared = RefreshGate()
    private var task: Task<Bool, Never>?
    func current() -> Task<Bool, Never>? { task }
    func set(_ t: Task<Bool, Never>?) { task = t }
}
