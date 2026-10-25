import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Google sign-in without the SDK: OAuth 2.0 authorization code + PKCE for an iOS client
/// (ASWebAuthenticationSession → https://oauth2.googleapis.com/token, no client secret), then the ID token goes to
/// `POST /api/auth/google/native` (`{ idToken }` → TokenPair). The server accepts the iOS client ID when it is listed
/// in its `GOOGLE_IOS_CLIENT_IDS`.
///
/// Client ID: Info.plist `GIDClientID` = build setting `GOOGLE_IOS_CLIENT_ID` (project.yml). Empty = "not available yet".
/// Redirect: `<reversed client id>:/oauth2redirect`, registered as a URL scheme via `GOOGLE_REVERSED_CLIENT_ID`.
enum GoogleSignIn {
    struct Config: Equatable {
        let clientID: String
        var reversedClientID: String {
            clientID.split(separator: ".").reversed().joined(separator: ".")
        }
        var redirectURI: String { "\(reversedClientID):/oauth2redirect" }

        static func fromBundle(_ bundle: Bundle = .main) -> Config? {
            guard let id = bundle.object(forInfoDictionaryKey: "GIDClientID") as? String,
                  id.hasSuffix(".apps.googleusercontent.com") else { return nil }
            return Config(clientID: id)
        }
    }

    enum Failure: Error { case cancelled, noCode, noIDToken }

    @MainActor
    static func signIn(auth: AuthStore) async throws {
        guard let config = Config.fromBundle() else { throw APIError.notAvailable }
        let verifier = randomURLSafe(48)
        let state = randomURLSafe(16)
        let url = authorizationURL(config: config, verifier: verifier, state: state)
        let callback = try await present(url: url, scheme: config.reversedClientID)
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value else { throw Failure.noCode }
        let idToken = try await tokenExchange(config: config, code: code, verifier: verifier)
        try await exchange(idToken: idToken, auth: auth)
    }

    @MainActor
    static func exchange(idToken: String, auth: AuthStore) async throws {
        let pair = try await AuthServices.current.exchangeGoogle(idToken: idToken)
        auth.store(pair, anonymous: false)
        await auth.loadMe()
    }

    static func authorizationURL(config: Config, verifier: String, state: String) -> URL {
        var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        c.queryItems = [
            URLQueryItem(name: "client_id", value: config.clientID),
            URLQueryItem(name: "redirect_uri", value: config.redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: codeChallenge(verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        return c.url!
    }

    /// RFC 7636 S256: base64url(sha256(verifier)) without padding.
    static func codeChallenge(_ verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func randomURLSafe(_ bytes: Int) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
        return base64URL(Data(b))
    }

    private static func tokenExchange(config: Config, code: String, verifier: String) async throws -> String {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = ReviewerSignIn.formBody(["client_id": config.clientID, "code": code, "code_verifier": verifier,
                                                "grant_type": "authorization_code", "redirect_uri": config.redirectURI])
        let (data, _) = try await URLSession.shared.data(for: req)
        struct TokenResponse: Decodable { let id_token: String? }
        guard let id = try JSONDecoder().decode(TokenResponse.self, from: data).id_token else { throw Failure.noIDToken }
        return id
    }

    @MainActor
    private static func present(url: URL, scheme: String) async throws -> URL {
        let anchor = PresentationAnchor()
        return try await withCheckedThrowingContinuation { cont in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                if let callback { cont.resume(returning: callback) }
                else { cont.resume(throwing: error ?? Failure.cancelled) }
            }
            session.presentationContextProvider = anchor
            session.prefersEphemeralWebBrowserSession = false
            anchor.session = session
            if !session.start() { cont.resume(throwing: Failure.cancelled) }
        }
    }

    private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        var session: ASWebAuthenticationSession?
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
