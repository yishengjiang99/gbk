import Foundation
import WebKit

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

enum PublishError: Error, Equatable {
    case limit(retryAfter: Int?)          // 429 GUEST_PUBLISH_LIMIT
    case rateLimited(retryAfter: Int?)    // 429 RATE_LIMITED (guest session)
    case notSaved                         // no saved song for this project yet
    case failed(String)

    var message: String {
        switch self {
        case .limit(let s): return "You've reached today's publish limit for guests." + Self.wait(s) + " Sign in with Apple or Google for more."
        case .rateLimited(let s): return "Too many tries." + Self.wait(s)
        case .notSaved: return "Your song isn't saved yet. Wait a moment and tap Publish again."
        case .failed(let m): return m.isEmpty ? "Couldn't publish. Check your connection and try again." : m
        }
    }
    static func wait(_ s: Int?) -> String {
        guard let s, s > 0 else { return " Try again later." }
        return s >= 3600 ? " Try again in about \((s + 1799) / 3600) h." : " Try again in \(max(1, (s + 59) / 60)) min."
    }
}

protocol GuestPublishing {
    func publish(_ draft: PublishDraft, projectId: String, slug: String?, as username: String) async throws -> PublishResult
}

enum GuestPublishServices {
    /// UI tests (`-uiTestPublishMock`) never publish to prod.
    @MainActor static func make(webView: WKWebView?) -> GuestPublishing {
        ProcessInfo.processInfo.arguments.contains("-uiTestPublishMock") ? MockGuestPublishService() : WebViewGuestPublishService(webView: webView)
    }
}

/// Publishes from inside the studio page (same origin, its cookie session), per docs/social-api.md "Guest publish":
/// `POST /api/auth/guest/web` (X-GBK-Device, X-GBK-Guest-Name) when there's no session → find the private save of
/// `projectId` (the slug from the web message; `GET /api/shares?mine=1` lookup only when it's missing) → `PATCH /api/shares/:slug { public: true, title }` →
/// `PATCH /api/songs/:slug/meta { labels, tags, prompt_shared }`. The device id never leaves the page request.
struct WebViewGuestPublishService: GuestPublishing {
    weak var webView: WKWebView?

    static let script = #"""
    const csrf = () => decodeURIComponent((document.cookie.match(/(?:^|; )gbk_csrf=([^;]*)/) || [])[1] || "");
    const H = () => ({ "content-type": "application/json", "x-gbk-csrf": csrf() });
    const fail = async (r) => { const b = await r.json().catch(() => ({})); return { ok: false, status: r.status, code: b.code || "", message: b.message || "", retryAfter: Number(r.headers.get("retry-after")) || 0 }; };
    let me = await fetch("/api/me", { credentials: "same-origin" });
    let handle = null;
    if (me.ok) { handle = (await me.json()).handle; }
    else {
      const g = await fetch("/api/auth/guest/web", { method: "POST", credentials: "same-origin", headers: { "x-gbk-device": deviceId, "x-gbk-guest-name": guestName } });
      if (!g.ok) return await fail(g);
      handle = (await g.json()).me.handle;
    }
    // The web saves privately first and sends the slug (41ba60a); the projectId lookup is only a fallback.
    let slug = knownSlug || null;
    for (let i = 0; i < 10 && !slug; i++) {
      const l = await fetch("/api/shares?mine=1&limit=100", { credentials: "same-origin" });
      if (l.ok) { const s = ((await l.json()).shares || []).find((x) => x.projectId === projectId); if (s) slug = s.slug; }
      if (!slug) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!slug) return { ok: false, status: 404, code: "NOT_SAVED" };
    const p = await fetch("/api/shares/" + slug, { method: "PATCH", credentials: "same-origin", headers: H(), body: JSON.stringify({ public: true, title }) });
    if (!p.ok) return await fail(p);
    const m = await fetch("/api/songs/" + slug + "/meta", { method: "PATCH", credentials: "same-origin", headers: H(), body: JSON.stringify({ labels, tags, prompt_shared: sharePrompt }) });
    if (!m.ok) return await fail(m);
    return { ok: true, slug, handle: handle || "" };
    """#

    @MainActor func publish(_ draft: PublishDraft, projectId: String, slug: String?, as username: String) async throws -> PublishResult {
        guard let webView else { throw PublishError.failed("The studio isn't ready yet.") }
        let args: [String: Any] = ["deviceId": AnonymousIdentity.deviceID, "guestName": username, "projectId": projectId, "knownSlug": slug ?? "",
                                   "title": draft.title.trimmingCharacters(in: .whitespaces), "labels": draft.labels,
                                   "tags": draft.tags, "sharePrompt": draft.sharePrompt]
        let raw: Any?
        do { raw = try await webView.callAsyncJavaScript(Self.script, arguments: args, in: nil, contentWorld: .page) }
        catch { throw PublishError.failed("") }
        return try Self.result(raw)
    }

    nonisolated static func result(_ raw: Any?) throws -> PublishResult {
        guard let d = raw as? [String: Any] else { throw PublishError.failed("") }
        if d["ok"] as? Bool == true, let slug = d["slug"] as? String, let url = URL(string: "https://compose.grepawk.com/s/\(slug)") {
            return PublishResult(slug: slug, url: url, author: d["handle"] as? String ?? "")
        }
        let status = (d["status"] as? NSNumber)?.intValue ?? 0, code = d["code"] as? String ?? ""
        let retry = (d["retryAfter"] as? NSNumber)?.intValue
        switch (status, code) {
        case (_, "GUEST_PUBLISH_LIMIT"): throw PublishError.limit(retryAfter: retry)
        case (429, _): throw PublishError.rateLimited(retryAfter: retry)
        case (_, "NOT_SAVED"): throw PublishError.notSaved
        default: throw PublishError.failed(d["message"] as? String ?? "")
        }
    }
}

struct MockGuestPublishService: GuestPublishing {
    func publish(_ draft: PublishDraft, projectId: String, slug: String?, as username: String) async throws -> PublishResult {
        try? await Task.sleep(nanoseconds: 400_000_000)
        let slug = "mock-" + String(projectId.prefix(8))
        return PublishResult(slug: slug, url: URL(string: "https://compose.grepawk.com/s/\(slug)")!, author: username.lowercased())
    }
}
