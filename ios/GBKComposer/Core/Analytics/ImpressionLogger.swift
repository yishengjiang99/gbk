import Foundation
import UIKit

/// Feed impression logging (docs/social/ranking.md; web src/components/social/impressions.ts).
/// One event per card the user settled on: dwell, listen ratio, completed, fast skip, replay, actions.
/// Batched to `POST /api/events` with `client: "ios"`: flushes every 10 events, every 20 s, and when the app
/// leaves the foreground. Native requests carry no Origin; the actor is the bearer or `x-gbk-install`.
/// `like` = a rating of 4+ stars (sent in addition to `rate`); `follow` is reserved until follow ships.
enum FeedAction: String, Codable { case rate, comment, remix, openStudio = "open_studio", share, like, follow, profileTap = "profile_tap" }

struct Impression: Codable, Equatable {
    let song: String
    let dwellMs: Int
    let listenRatio: Double
    let completed: Bool
    let fastSkip: Bool
    let replay: Bool
    let actions: [FeedAction]
    let position: Int
    let feed: String
    let modelVersion: String
    let ts: Int64
    /// Scroll speed (pt/s, 0...20000) of the gesture that left the card; nil when unknown.
    var scrollV: Double? = nil
}

/// Pure bookkeeping for one open impression, sampled from the player clock.
struct OpenImpression {
    let song: String, position: Int, feed: String, modelVersion: String
    let t0: Date
    var actions: [FeedAction] = []
    var listened: Double = 0
    var lastT: Double?
    var replay = false
    var duration: Double = 0

    /// Web `sample()`: forward steps under 2 s count as listening; a jump back over 0.5 s is a replay (loop/seek).
    mutating func sample(time: Double?, duration d: Double?) {
        if let d, d.isFinite, d > 0 { duration = d }
        guard let t = time else { return }
        if let last = lastT {
            let step = t - last
            if step > 0 && step < 2 { listened += step } else if step < -0.5 { replay = true }
        }
        lastT = t
    }

    func close(at now: Date, scrollV: Double? = nil) -> Impression {
        let dwell = Int((now.timeIntervalSince(t0) * 1000).rounded())
        let ratio = duration > 0 ? listened / duration : 0
        return Impression(song: song, dwellMs: dwell, listenRatio: (ratio * 1000).rounded() / 1000,
                          completed: ratio >= 0.9 || replay, fastSkip: dwell < 2000, replay: replay, actions: actions,
                          position: position, feed: feed, modelVersion: modelVersion, ts: Int64(now.timeIntervalSince1970 * 1000),
                          scrollV: scrollV.map { min(20000, max(0, $0.rounded())) })
    }
}

@MainActor
final class ImpressionLogger {
    static let shared = ImpressionLogger()
    static let batchSize = 10
    static let maxBatch = 50
    static let flushInterval: TimeInterval = 20

    /// Per-launch random id (web: per tab), also sent as `?session=` on /api/feed for session-aware ranking.
    nonisolated static let session: String = (0..<12).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()

    private(set) var queue: [Impression] = []
    private var open: OpenImpression?
    private var clock: (time: @MainActor () -> Double?, duration: @MainActor () -> Double?)?
    private var sampler: Timer?
    private var flusher: Timer?
    var send: ([Impression]) async -> Void = { events in
        let body: [String: Any] = ["session": ImpressionLogger.session, "client": "ios",
                                   "events": events.map(ImpressionLogger.json)]
        var ep = Endpoint(path: "/api/events", method: .post, body: body)
        ep.headers["x-gbk-install"] = AnonymousIdentity.deviceID
        _ = try? await APIClient.shared.send(ep, as: OKResult.self)
    }
    var now: () -> Date = Date.init
    private var lastScroll: (y: Double, at: Date)?
    private var peakScrollV: Double = 0

    /// Feed scroll offset changed: track the peak speed since the current card started (web `noteScroll`).
    func noteScroll(offset y: Double) {
        let t = now()
        if let l = lastScroll, t > l.at { peakScrollV = max(peakScrollV, abs(y - l.y) / t.timeIntervalSince(l.at)) }
        lastScroll = (y, t)
    }

    /// Rating logged as `rate`, plus `like` for 4+ stars (nil = cleared).
    func markRate(stars: Int?, song: String) { mark(.rate, song: song); if let s = stars, s >= 4 { mark(.like, song: song) } }

    func start(song: String, position: Int, feed: String, modelVersion: String,
               time: @escaping @MainActor () -> Double?, duration: @escaping @MainActor () -> Double?) {
        if open?.song == song { return }
        end(); peakScrollV = 0
        open = OpenImpression(song: song, position: position, feed: feed, modelVersion: modelVersion, t0: now())
        clock = (time, duration)
        if sampler == nil {
            sampler = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in Task { @MainActor in ImpressionLogger.shared.sample() } }
            flusher = Timer.scheduledTimer(withTimeInterval: Self.flushInterval, repeats: true) { _ in Task { @MainActor in ImpressionLogger.shared.flush() } }
        }
    }

    func sample() {
        guard open != nil, let clock else { return }
        open?.sample(time: clock.time(), duration: clock.duration())
    }

    /// Close the open impression (if any) and queue it.
    func end() {
        guard open != nil else { return }
        sample()
        if let o = open { queue.append(o.close(at: now(), scrollV: peakScrollV > 0 ? peakScrollV : nil)) }
        peakScrollV = 0
        open = nil; clock = nil
        if queue.count >= Self.batchSize { flush() }
    }

    func mark(_ action: FeedAction, song: String) {
        if open?.song == song {
            if !(open!.actions.contains(action)) { open!.actions.append(action) }
        } else {
            queue.append(Impression(song: song, dwellMs: 0, listenRatio: 0, completed: false, fastSkip: false, replay: false,
                                    actions: [action], position: -1, feed: "detail", modelVersion: "none",
                                    ts: Int64(now().timeIntervalSince1970 * 1000)))
        }
    }

    /// App backgrounded: end the impression and send what we have.
    func suspend() { end(); flush() }

    func flush() {
        guard !queue.isEmpty else { return }
        let batch = Array(queue.prefix(Self.maxBatch)); queue.removeFirst(batch.count)
        let send = self.send
        Task { await send(batch) }
    }

    nonisolated static func json(_ e: Impression) -> [String: Any] {
        var d: [String: Any] = ["song": e.song, "dwell_ms": e.dwellMs, "listen_ratio": e.listenRatio, "completed": e.completed,
         "fast_skip": e.fastSkip, "replay": e.replay, "actions": e.actions.map(\.rawValue), "position": e.position,
         "feed": e.feed, "model_version": e.modelVersion, "ts": e.ts]
        if let v = e.scrollV { d["scroll_v"] = v }
        return d
    }
}
