import Foundation

/// App Store products mirroring the Stripe "GBK Composer Pro" catalog (docs/stripe.md, docs/asc/iap.md).
/// Every product grants the same `pro` entitlement; they differ only in billing.
enum StoreCatalog {
    static let subscriptionGroup = "GBK Pro"
    static let proEntitlement = "pro"

    struct Item: Identifiable, Hashable {
        let id: String
        let title: String
        /// Billing line; trial terms and prices come from StoreKit (PurchaseStore), never from here.
        let detail: String
        let period: String?
        let isSubscription: Bool
    }

    static let proMonthly = Item(id: "com.grepawk.moviefone.pro_monthly", title: "Pro Monthly",
                                 detail: "Billed monthly", period: "month", isSubscription: true)
    static let proYearly = Item(id: "com.grepawk.moviefone.pro_yearly", title: "Pro Yearly",
                                detail: "Billed yearly", period: "year", isSubscription: true)
    static let lifetime = Item(id: "com.grepawk.moviefone.lifetime", title: "Pro Lifetime",
                               detail: "One payment, Pro forever", period: nil, isSubscription: false)

    static let all = [proYearly, proMonthly, lifetime]
    static var ids: Set<String> { Set(all.map(\.id)) }

    static let benefits = [
        ("sparkles", "10× the Studio composer-agent daily budget"),
        ("waveform", "120 server renders per hour, up to 10 minutes each"),
        ("clock.arrow.circlepath", "Revision history: 100 snapshots kept per composition"),
        ("tray.full", "Rendered files kept for a year; pieces up to 256 bars"),
        ("person.crop.circle.badge.checkmark", "Works without signing in — guests can buy too"),
    ]
}
