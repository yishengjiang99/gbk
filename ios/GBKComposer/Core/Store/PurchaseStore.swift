import Foundation
import Combine
import StoreKit

/// StoreKit 2: loads products, buys, restores, listens to `Transaction.updates`, and forwards each
/// verified transaction's JWS to the server (`IAPVerificationServices.current`).
@MainActor
final class PurchaseStore: ObservableObject {
    static let shared = PurchaseStore()

    @Published private(set) var products: [String: Product] = [:]
    @Published private(set) var isPro = false
    @Published private(set) var purchasing: String?
    @Published var message: String?
    /// Where Pro comes from and when it renews; nil when not Pro. Drives the "You're Pro" card.
    @Published private(set) var proStatus: ProStatus?
    /// Products didn't load (network / StoreKit); the paywall shows an error with Retry, not a dead button.
    @Published private(set) var productsFailed = false
    @Published private(set) var loadingProducts = false
    /// Product id → whether this Apple ID can still redeem that subscription's introductory offer.
    @Published private(set) var introEligible: [String: Bool] = [:]
    /// Drives the app-wide paywall sheet (RootTabView).
    @Published var showPaywall = false
    /// Why the paywall was opened (the `paywall_view` event's `reason`, #119); set by presentPaywall.
    private(set) var paywallReason = "manual"

    private var updates: Task<Void, Never>?
    private let verifier: IAPVerifying
    private let accountId: @MainActor () -> String?
    private let serverPro: @MainActor () -> Bool
    private let serverMe: @MainActor () -> Me?
    private let billing: BillingEventLogger
    private var localPro = false
    private var localExpiry: Date?
    private var meSub: AnyCancellable?

    init(verifier: IAPVerifying = IAPVerificationServices.current,
         accountId: @escaping @MainActor () -> String? = { AuthStore.shared.me?.id },
         serverPro: @escaping @MainActor () -> Bool = { AuthStore.shared.me?.hasActivePro() ?? false },
         serverMe: @escaping @MainActor () -> Me? = { AuthStore.shared.me },
         billing: BillingEventLogger = .shared) {
        self.serverMe = serverMe
        self.verifier = verifier
        self.accountId = accountId
        self.serverPro = serverPro
        self.billing = billing
    }

    /// Open the paywall sheet, remembering why so the view event can carry the reason (#119).
    /// Pro users never get the paywall from gated actions; only the Profile Pro button opens it (as the status card).
    func presentPaywall(reason: String) {
        guard !isPro || reason == "profile" else { return }
        paywallReason = reason; showPaywall = true
    }

    /// Pro = StoreKit entitlement on this device OR server `/api/me` `pro` (Stripe or Apple, any device).
    func recompute() {
        isPro = localPro || serverPro()
        proStatus = isPro ? ProStatus.resolve(localPro: localPro, localExpiry: localExpiry, me: serverMe()) : nil
    }

    var appAccountToken: UUID { AppAccountToken.resolve(accountId: accountId()) }

    /// Start once at launch: transaction listener + current entitlements.
    func start() {
        guard updates == nil else { return }
        meSub = AuthStore.shared.$me.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.recompute() }
        updates = Task { [weak self] in
            for await result in Transaction.updates { await self?.handle(result) }
        }
        Task { await loadProducts(); await refreshEntitlements() }
    }

    /// StoreKit's localized price; nil until products load (no hardcoded fallback).
    func price(for item: StoreCatalog.Item) -> String? { products[item.id]?.displayPrice }

    /// The intro offer this user can redeem for `item`, if any.
    func introOffer(for item: StoreCatalog.Item) -> Product.SubscriptionOffer? {
        guard introEligible[item.id] == true else { return nil }
        return products[item.id]?.subscription?.introductoryOffer
    }

    /// "7-day free trial" / "$0.99 for 3 months", from the StoreKit offer.
    func introText(for item: StoreCatalog.Item) -> String? {
        introOffer(for: item).flatMap {
            Self.introText(mode: $0.paymentMode, unit: $0.period.unit, value: $0.period.value, periodCount: $0.periodCount, price: $0.displayPrice)
        }
    }

    static func introText(mode: Product.SubscriptionOffer.PaymentMode, unit: Product.SubscriptionPeriod.Unit,
                          value: Int, periodCount: Int, price: String) -> String? {
        let n = value * max(periodCount, 1)
        let name: String
        switch unit {
        case .day: name = "day"
        case .week: name = "week"
        case .month: name = "month"
        case .year: name = "year"
        @unknown default: return nil
        }
        switch mode {
        case .freeTrial: return "\(n)-\(name) free trial"
        case .payAsYouGo, .payUpFront: return "\(price) for \(n) \(name)\(n == 1 ? "" : "s")"
        default: return nil
        }
    }

    func loadProducts() async {
        loadingProducts = true; productsFailed = false
        defer { loadingProducts = false }
        do {
            let list = try await Product.products(for: StoreCatalog.ids)
            var eligible: [String: Bool] = [:]
            for p in list { if let sub = p.subscription { eligible[p.id] = await sub.isEligibleForIntroOffer } }
            products = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
            introEligible = eligible
            productsFailed = list.isEmpty
        } catch { productsFailed = true }
    }

    func buy(_ item: StoreCatalog.Item) async {
        if products[item.id] == nil { await loadProducts() }
        guard let product = products[item.id] else { message = "This item isn't available right now."; return }
        purchasing = item.id
        defer { purchasing = nil }
        billing.purchaseStart(plan: item.id)
        do {
            switch try await product.purchase(options: [.appAccountToken(appAccountToken)]) {
            case .success(let result):
                billing.purchaseResult(plan: item.id, .success)
                await handle(result)
            case .pending:
                billing.purchaseResult(plan: item.id, .pending)
                message = "Purchase pending approval."
            case .userCancelled:
                billing.purchaseResult(plan: item.id, .cancelled)
            @unknown default: break
            }
        } catch {
            billing.purchaseResult(plan: item.id, .failed)
            message = "Purchase failed. Please try again."
        }
    }

    func restore() async {
        do { try await AppStore.sync() } catch {
            billing.restore(.failed)
            message = "Couldn't reach the App Store."; return
        }
        let outcomes = await refreshEntitlements(resubmit: true)
        billing.restore(isPro ? .success : .none)
        message = Self.restoreMessage(isPro: isPro, outcomes: outcomes)
    }

    /// Restore copy: a server refusal (e.g. 409 IAP_OWNED_BY_OTHER) wins over the local Pro flag.
    static func restoreMessage(isPro: Bool, outcomes: [VerifyOutcome]) -> String {
        for o in outcomes { if case .refused(let m) = o { return m } }
        if outcomes.contains(.transient) { return "Restored on this device. We'll finish syncing Pro shortly." }
        return isPro ? "Purchases restored." : "No purchases to restore."
    }

    /// Re-reads StoreKit entitlements; with `resubmit`, sends each to the server under the transaction's own account token.
    @discardableResult
    func refreshEntitlements(resubmit: Bool = false) async -> [VerifyOutcome] {
        var pro = false
        var expiry: Date?
        var outcomes: [VerifyOutcome] = []
        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, StoreCatalog.ids.contains(t.productID), t.revocationDate == nil else { continue }
            pro = true
            if let e = t.expirationDate { expiry = max(expiry ?? e, e) }
            if resubmit { outcomes.append(await verify(jws: result.jwsRepresentation, token: t.appAccountToken ?? appAccountToken)) }
        }
        localPro = pro
        localExpiry = expiry
        recompute()
        return outcomes
    }

    /// Server verdict on one signed transaction.
    enum VerifyOutcome: Equatable {
        case granted
        /// 2xx without the `pro` entitlement.
        case notGranted
        /// Permanent 4xx (invalid JWS, owned by another account…): retrying won't help.
        case refused(String)
        /// Network, 5xx, 401, 404/503, 429: StoreKit should redeliver.
        case transient

        /// Finish only when the server granted Pro or refused permanently.
        var shouldFinish: Bool {
            switch self { case .granted, .refused: return true; case .notGranted, .transient: return false }
        }
    }

    func verify(jws: String, token: UUID) async -> VerifyOutcome {
        do {
            let r = try await verifier.submit(signedTransaction: jws, appAccountToken: token)
            return r.entitlements.contains(StoreCatalog.proEntitlement) ? .granted : .notGranted
        } catch let e as APIError {
            if case .badStatus(let code, let body) = e, (400..<500).contains(code), code != 408 {
                return .refused(Self.refusalMessage(code: code, body: body))
            }
            return .transient
        } catch { return .transient }
    }

    static func refusalMessage(code: Int, body: APIErrorBody?) -> String {
        if code == 409 || body?.code == "IAP_OWNED_BY_OTHER" {
            return "This purchase belongs to another GBK account. Sign in to that account, or contact support."
        }
        return (body?.message).map { "Couldn't activate Pro: \($0)" } ?? "Couldn't activate Pro. Please contact support."
    }

    static func isInactive(revoked: Date?, expires: Date?, now: Date = Date()) -> Bool {
        revoked != nil || (expires.map { $0 <= now } ?? false)
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let t) = result else { message = "Purchase couldn't be verified."; return }
        // Refunds/revocations and lapsed renewals arrive here too; the server grants nothing for them, so just finish.
        if Self.isInactive(revoked: t.revocationDate, expires: t.expirationDate) {
            await t.finish(); await refreshEntitlements(); return
        }
        let outcome = await verify(jws: result.jwsRepresentation, token: t.appAccountToken ?? appAccountToken)
        if outcome.shouldFinish { await t.finish() } // else StoreKit redelivers via Transaction.updates
        switch outcome {
        case .granted:
            localPro = true; recompute()
            await AuthStore.shared.loadMe() // pick up pro / pro_source / pro_expires_at / pro_environment
        case .refused(let m): message = m
        case .notGranted, .transient: message = "Purchased. We'll finish activating Pro shortly."
        }
        await refreshEntitlements()
    }
}

/// Where an active Pro entitlement comes from, for the paywall's "You're Pro" card.
struct ProStatus: Equatable {
    enum Source: Equatable { case apple, stripe, lifetime }
    let source: Source
    /// Next renewal / expiry; nil for lifetime.
    let renews: Date?

    /// Server `/api/me` `pro_source` / `pro_expires_at` win (they cover every device); else this device's StoreKit.
    static func resolve(localPro: Bool, localExpiry: Date?, me: Me?) -> ProStatus {
        if let me, me.hasActivePro() {
            let renews = me.proExpiresAt.map { Date(timeIntervalSince1970: Double($0) / 1000) }
            if renews == nil { return ProStatus(source: .lifetime, renews: nil) }
            return ProStatus(source: me.proSource == "stripe" ? .stripe : .apple, renews: renews)
        }
        return localExpiry.map { ProStatus(source: .apple, renews: $0) } ?? ProStatus(source: .lifetime, renews: nil)
    }
}
