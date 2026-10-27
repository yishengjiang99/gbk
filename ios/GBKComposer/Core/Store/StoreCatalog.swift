import Foundation

/// App Store products mirroring the Stripe "GBK Composer Pro" catalog (docs/stripe.md, docs/asc/iap.md).
/// Every product grants the same `pro` entitlement; they differ only in billing.
enum StoreCatalog {
    static let subscriptionGroup = "GBK Pro"
    static let proEntitlement = "pro"

    struct Item: Identifiable, Hashable {
        let id: String
        let title: String
        let detail: String
        /// Fallback price label used before StoreKit returns localized prices (and in snapshots).
        let fallbackPrice: String
        let period: String?
        let isSubscription: Bool
    }

    static let proMonthly = Item(id: "com.grepawk.moviefone.pro_monthly", title: "Pro Monthly",
                                 detail: "7-day free trial, then billed monthly", fallbackPrice: "$5.99", period: "month", isSubscription: true)
    static let proYearly = Item(id: "com.grepawk.moviefone.pro_yearly", title: "Pro Yearly",
                                detail: "7-day free trial, then billed yearly — save 33%", fallbackPrice: "$47.99", period: "year", isSubscription: true)
    static let lifetime = Item(id: "com.grepawk.moviefone.lifetime", title: "Pro Lifetime",
                               detail: "One payment, Pro forever", fallbackPrice: "$99.99", period: nil, isSubscription: false)

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
