import Foundation

enum APIError: Error, Equatable {
    case badStatus(Int)
    case invalidURL
}

/// Feed paging abstraction so the offset-based /api/shares can later be swapped for cursor-based /api/feed.
protocol FeedProviding {
    /// `cursor` is opaque: for the offset implementation it's the stringified offset.
    func feedPage(cursor: String?, limit: Int) async throws -> FeedPage
}

protocol APIClientProtocol: FeedProviding {
    var baseURL: URL { get }
    func send<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T
    func mediaURL(slug: String, kind: String) -> URL
}

final class APIClient: APIClientProtocol {
    static let shared = APIClient()
    static let defaultBaseURL = URL(string: "https://compose.grepawk.com")!

    let baseURL: URL
    private let session: URLSession
    private let tokenProvider: () -> String?
    let decoder = JSONDecoder()

    init(baseURL: URL = APIClient.defaultBaseURL,
         session: URLSession = .shared,
         tokenProvider: @escaping () -> String? = { AuthStore.currentAccessToken() }) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    func request(for endpoint: Endpoint) throws -> URLRequest {
        guard var comps = URLComponents(url: baseURL.appendingPathComponent(endpoint.path), resolvingAgainstBaseURL: false)
        else { throw APIError.invalidURL }
        if !endpoint.query.isEmpty { comps.queryItems = endpoint.query }
        guard let url = comps.url else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = endpoint.method.rawValue
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = endpoint.body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token = tokenProvider() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    func send<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request(for: endpoint))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.badStatus(http.statusCode)
        }
        return try decoder.decode(T.self, from: data)
    }

    func feedPage(cursor: String?, limit: Int = 20) async throws -> FeedPage {
        let offset = cursor.flatMap(Int.init) ?? 0
        let page = try await send(Endpoints.shares(limit: limit, offset: offset), as: FeedPage.self)
        let next = page.shares.count < limit ? nil : String(offset + page.shares.count)
        return FeedPage(shares: page.shares, nextCursor: next)
    }

    func mediaURL(slug: String, kind: String = "mp3") -> URL {
        baseURL.appendingPathComponent(Endpoints.mediaPath(slug: slug, kind: kind))
    }

    // MARK: Push (stubbed until the server endpoint exists)
    func registerPush(installId: String, token: String, environment: String) async throws {}
    func unregisterPush(installId: String, token: String) async throws {}
}
