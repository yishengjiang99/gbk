import Foundation

enum APIError: Error, Equatable {
    case badStatus(Int, APIErrorBody?)
    /// 404 from an endpoint that is specced but not deployed yet (or a missing resource).
    case notAvailable
    case unauthenticated
    case invalidURL

    var userMessage: String {
        switch self {
        case .notAvailable: return "This isn't available yet."
        case .unauthenticated: return "Please sign in first."
        case .badStatus(_, let body): return body?.message ?? "Something went wrong."
        case .invalidURL: return "Something went wrong."
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
            case 404: throw APIError.notAvailable
            default: throw APIError.badStatus(http.statusCode, body)
            }
        }
        return try decoder.decode(T.self, from: data)
    }

    /// Refresh via `AuthServices.current` (iOS-1). Returns false when there is no refresh token or the route is not live.
    func refreshTokens() async -> Bool {
        guard let refresh = AuthStore.currentRefreshToken(),
              let pair = try? await AuthServices.current.refresh(refreshToken: refresh) else { return false }
        await AuthStore.shared.store(pair)
        return true
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
