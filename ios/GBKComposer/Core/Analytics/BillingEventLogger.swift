import Foundation

/// One paywall / StoreKit funnel event (#119). `name` is the wire taxonomy — do not rename:
/// `paywall_view` {reason}, `paywall_dismiss`, `plan_select` {plan}, `iap_purchase_start` {plan},
/// `iap_purchase_result` {plan, result}, `restore` {result}. The server-side funnel (#118) keys off
/// these names; `plan` is a StoreCatalog product id.
struct BillingEvent: Equatable {
    let name: String
    var reason: String? = nil
    var plan: String? = nil
    var result: String? = nil
    let ts: Int64

    func json() -> [String: Any] {
        var d: [String: Any] = ["event": name, "ts": ts]
        if let reason { d["reason"] = reason }
        if let plan { d["plan"] = plan }
        if let result { d["result"] = result }
        return d
    }
}

/// Outcome of a StoreKit `purchase()` call, as reported by `iap_purchase_result`.
enum BillingPurchaseResult: String { case success, cancelled, pending, failed }

/// Outcome of a restore, as reported by `restore`: restored Pro, nothing to restore, or App Store unreachable.
enum BillingRestoreResult: String { case success, none, failed }

/// Paywall + StoreKit event logging (#119). Same transport as feed impressions (ImpressionLogger):
/// batched to `POST /api/events` with `client: "ios"` and the guest install id as the actor
/// (`x-gbk-install` header); flushes every 10 events, every 20 s, and on `suspend()` (app background).
@MainActor
final class BillingEventLogger {
    static let shared = BillingEventLogger()
    static let batchSize = 10
    static let maxBatch = 50
    static let flushInterval: TimeInterval = 20

    private(set) var queue: [BillingEvent] = []
    private var flusher: Timer?
    var send: ([BillingEvent]) async -> Void = { events in
        let body: [String: Any] = ["session": ImpressionLogger.session, "client": "ios",
                                   "events": events.map { $0.json() }]
        var ep = Endpoint(path: "/api/events", method: .post, body: body)
        ep.headers["x-gbk-install"] = AnonymousIdentity.deviceID
        _ = try? await APIClient.shared.send(ep, as: OKResult.self)
    }
    var now: () -> Date = Date.init

    func paywallView(reason: String) { log(BillingEvent(name: "paywall_view", reason: reason, ts: stamp())) }
    func paywallDismiss() { log(BillingEvent(name: "paywall_dismiss", ts: stamp())) }
    func planSelect(plan: String) { log(BillingEvent(name: "plan_select", plan: plan, ts: stamp())) }
    func purchaseStart(plan: String) { log(BillingEvent(name: "iap_purchase_start", plan: plan, ts: stamp())) }
    func purchaseResult(plan: String, _ result: BillingPurchaseResult) {
        log(BillingEvent(name: "iap_purchase_result", plan: plan, result: result.rawValue, ts: stamp()))
    }
    func restore(_ result: BillingRestoreResult) {
        log(BillingEvent(name: "restore", result: result.rawValue, ts: stamp()))
    }

    private func stamp() -> Int64 { Int64(now().timeIntervalSince1970 * 1000) }

    private func log(_ event: BillingEvent) {
        queue.append(event)
        if queue.count >= Self.batchSize { flush() } else { armFlusher() }
    }

    private func armFlusher() {
        guard flusher == nil else { return }
        flusher = Timer.scheduledTimer(withTimeInterval: Self.flushInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.flush() }
        }
    }

    /// App backgrounded: send what we have.
    func suspend() { flush() }

    func flush() {
        guard !queue.isEmpty else { return }
        let batch = Array(queue.prefix(Self.maxBatch)); queue.removeFirst(batch.count)
        if queue.isEmpty { flusher?.invalidate(); flusher = nil }
        let send = self.send
        Task { await send(batch) }
    }
}
