import Foundation

enum HTTPMethod: String { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

struct Endpoint {
    var path: String
    var method: HTTPMethod = .get
    var query: [URLQueryItem] = []
    var body: Data? = nil
}

enum Endpoints {
    /// Existing offset-paged public listing: GET /api/shares?limit=&offset= -> {shares:[...]}
    static func shares(limit: Int, offset: Int) -> Endpoint {
        Endpoint(path: "/api/shares", query: [URLQueryItem(name: "limit", value: String(limit)),
                                              URLQueryItem(name: "offset", value: String(offset))])
    }
    static func share(slug: String) -> Endpoint { Endpoint(path: "/api/shares/\(slug)") }
    /// Future cursor-paged feed (not yet on the server).
    static func feed(cursor: String?) -> Endpoint {
        Endpoint(path: "/api/feed", query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    }
    static func mediaPath(slug: String, kind: String = "mp3") -> String { "/api/shares/\(slug)/media/\(kind)" }
}
