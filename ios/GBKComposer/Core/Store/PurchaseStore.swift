import Foundation
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

    private var updates: Task<Void, Never>?
    private let verifier: IAPVerifying
    private let accountId: () -> String?

    init(verifier: IAPVerifying = IAPVerificationServices.current,
         accountId: @escaping () -> String? = { AuthStore.shared.me?.id }) {
        self.verifier = verifier
        self.accountId = accountId
    }

    var appAccountToken: UUID { AppAccountToken.resolve(accountId: accountId()) }

    /// Start once at launch: transaction listener + current entitlements.
    func start() {
        guard updates == nil else { return }
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
        do {
            switch try await product.purchase(options: [.appAccountToken(appAccountToken)]) {
            case .success(let result): await handle(result)
            case .pending: message = "Purchase pending approval."
            case .userCancelled: break
            @unknown default: break
            }
        } catch { message = "Purchase failed. Please try again." }
    }

    func restore() async {
        do { try await AppStore.sync() } catch { message = "Couldn't reach the App Store."; return }
        await refreshEntitlements(resubmit: true)
        message = isPro ? "Purchases restored." : "No purchases to restore."
    }

    func refreshEntitlements(resubmit: Bool = false) async {
        var pro = false
        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, StoreCatalog.ids.contains(t.productID), t.revocationDate == nil else { continue }
            pro = true
            if resubmit { _ = try? await verifier.submit(signedTransaction: result.jwsRepresentation, appAccountToken: appAccountToken) }
        }
        isPro = pro
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let t) = result else { message = "Purchase couldn't be verified."; return }
        do {
            let r = try await verifier.submit(signedTransaction: result.jwsRepresentation, appAccountToken: t.appAccountToken ?? appAccountToken)
            if r.entitlements.contains(StoreCatalog.proEntitlement) { isPro = true }
            await t.finish()
        } catch {
            // Leave unfinished so StoreKit redelivers via Transaction.updates; unlock locally meanwhile.
            message = "Purchased. We'll finish activating Pro shortly."
        }
        await refreshEntitlements()
    }
}
