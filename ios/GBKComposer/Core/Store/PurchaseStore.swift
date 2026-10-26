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
    /// Drives the app-wide paywall sheet (RootTabView).
    @Published var showPaywall = false
    /// Why the paywall was opened (the `paywall_view` event's `reason`, #119); set by presentPaywall.
    private(set) var paywallReason = "manual"

    private var updates: Task<Void, Never>?
    private let verifier: IAPVerifying
    private let accountId: @MainActor () -> String?
    private let serverPro: @MainActor () -> Bool
    private let billing: BillingEventLogger
    private var localPro = false
    private var meSub: AnyCancellable?

    init(verifier: IAPVerifying = IAPVerificationServices.current,
         accountId: @escaping @MainActor () -> String? = { AuthStore.shared.me?.id },
         serverPro: @escaping @MainActor () -> Bool = { AuthStore.shared.me?.hasActivePro() ?? false },
         billing: BillingEventLogger = .shared) {
        self.verifier = verifier
        self.accountId = accountId
        self.serverPro = serverPro
        self.billing = billing
    }

    /// Open the paywall sheet, remembering why so the view event can carry the reason (#119).
    func presentPaywall(reason: String) { paywallReason = reason; showPaywall = true }

    /// Pro = StoreKit entitlement on this device OR server `/api/me` `pro` (Stripe or Apple, any device).
    func recompute() { isPro = localPro || serverPro() }

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

    func price(for item: StoreCatalog.Item) -> String { products[item.id]?.displayPrice ?? item.fallbackPrice }

    func loadProducts() async {
        do {
            let list = try await Product.products(for: StoreCatalog.ids)
            products = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        } catch { message = "Couldn't load prices." }
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
        await refreshEntitlements(resubmit: true)
        billing.restore(isPro ? .success : .none)
        message = isPro ? "Purchases restored." : "No purchases to restore."
    }

    func refreshEntitlements(resubmit: Bool = false) async {
        var pro = false
        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, StoreCatalog.ids.contains(t.productID), t.revocationDate == nil else { continue }
            pro = true
            if resubmit { _ = try? await verifier.submit(signedTransaction: result.jwsRepresentation, appAccountToken: appAccountToken) }
        }
        localPro = pro
        recompute()
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let t) = result else { message = "Purchase couldn't be verified."; return }
        do {
            let r = try await verifier.submit(signedTransaction: result.jwsRepresentation, appAccountToken: t.appAccountToken ?? appAccountToken)
            if r.entitlements.contains(StoreCatalog.proEntitlement) { localPro = true; recompute() }
            await t.finish()
            await AuthStore.shared.loadMe() // pick up pro / pro_source / pro_expires_at / pro_environment
        } catch {
            // Leave unfinished so StoreKit redelivers via Transaction.updates; unlock locally meanwhile.
            message = "Purchased. We'll finish activating Pro shortly."
        }
        await refreshEntitlements()
    }
}
