import Foundation

/// App Review sign-in against the live reviewer routes (server/src/routes/reviewer.ts):
///   GET  /signin/reviewer            -> sets the `gbk_csrf` cookie (and serves the HTML form)
///   POST /api/auth/reviewer          -> form-urlencoded { csrf, username, password, return }; Origin must be allowed;
///                                       on success 303 + `Set-Cookie: gbk_cs=<session token>`
/// The `gbk_cs` value is the session token, which every /api route also accepts as `Authorization: Bearer`.
/// Uses an ephemeral session so nothing leaks into the shared cookie store; the token goes to the Keychain via AuthStore.
enum ReviewerSignIn {
    enum Failure: Error, Equatable { case unavailable, wrongCredentials, rateLimited, expired, noSession }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    static func signIn(username: String, password: String, baseURL: URL = APIClient.defaultBaseURL) async throws -> String {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .always
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        let formURL = baseURL.appendingPathComponent("/signin/reviewer")
        let (_, formResp) = try await session.data(from: formURL)
        guard let fr = formResp as? HTTPURLResponse else { throw Failure.unavailable }
        if fr.statusCode == 404 { throw Failure.unavailable }
        guard let csrf = cookie("gbk_csrf", in: fr, url: formURL) ?? config.httpCookieStorage?.cookies(for: formURL)?.first(where: { $0.name == "gbk_csrf" })?.value
        else { throw Failure.expired }

        var req = URLRequest(url: baseURL.appendingPathComponent("/api/auth/reviewer"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue(baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        req.httpShouldHandleCookies = false
        req.setValue("gbk_csrf=\(csrf)", forHTTPHeaderField: "Cookie")
        req.httpBody = formBody(["csrf": csrf, "username": username, "password": password, "return": "/"])
        let (_, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw Failure.noSession }
        switch http.statusCode {
        case 303, 302, 200: break
        case 401: throw Failure.wrongCredentials
        case 429: throw Failure.rateLimited
        case 404: throw Failure.unavailable
        default: throw Failure.expired
        }
        guard let token = cookie("gbk_cs", in: http, url: baseURL), !token.isEmpty else { throw Failure.noSession }
        return token
    }

    private static func cookie(_ name: String, in response: HTTPURLResponse, url: URL) -> String? {
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { d, kv in
            if let k = kv.key as? String, let v = kv.value as? String { d[k] = v }
        }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).first { $0.name == name }?.value
    }

    static func formBody(_ fields: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let s = fields.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
        return Data(s.utf8)
    }
}
