import SwiftUI

/// GBK Pro paywall sheet. Opened from Profile, the Create tab, and any Studio link to /pricing or checkout.
struct PaywallView: View {
    @ObservedObject var store: PurchaseStore
    @Environment(\.dismiss) private var dismiss
    @State private var selected = StoreCatalog.proYearly.id

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    header
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(StoreCatalog.benefits, id: \.1) { icon, text in
                            Label { Text(text).foregroundStyle(Theme.text) } icon: { Image(systemName: icon).foregroundStyle(Theme.accent) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(spacing: 10) { ForEach(StoreCatalog.all) { option($0) } }
                    buyButton
                    if let m = store.message { Text(m).font(.footnote).foregroundStyle(Theme.textSecondary) }
                    footer
                }
                .padding(24)
            }
            .background(Theme.background.ignoresSafeArea())
            .onAppear { BillingEventLogger.shared.paywallView(reason: store.paywallReason) }
            .onDisappear { BillingEventLogger.shared.paywallDismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("Restore") { Task { await store.restore() } } }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "crown.fill").font(.system(size: 48)).foregroundStyle(Theme.accent)
            Text(store.isPro ? "You're Pro" : "GBK Pro").font(.largeTitle.bold()).foregroundStyle(Theme.text)
            Text("Compose more, render longer.").font(.headline).foregroundStyle(Theme.textSecondary)
        }
    }

    private func option(_ item: StoreCatalog.Item) -> some View {
        let isOn = selected == item.id
        return Button {
            if selected != item.id { selected = item.id; BillingEventLogger.shared.planSelect(plan: item.id) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.headline).foregroundStyle(Theme.text)
                    Text(item.detail).font(.caption).foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Text(store.price(for: item) + (item.period.map { " / \($0)" } ?? ""))
                    .font(.subheadline.bold()).foregroundStyle(Theme.text)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(isOn ? Theme.accent : Theme.border, lineWidth: isOn ? 2 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private var buyButton: some View {
        let item = StoreCatalog.all.first { $0.id == selected } ?? StoreCatalog.proYearly
        return Button { Task { await store.buy(item) } } label: {
            Group {
                if store.purchasing != nil { ProgressView().tint(Theme.onAccent) }
                else { Text(item.isSubscription ? "Start free trial" : "Buy lifetime") }
            }
            .font(.headline).frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.accent)
        .foregroundStyle(Theme.onAccent)
        .disabled(store.purchasing != nil || store.isPro)
    }

    private var footer: some View {
        VStack(spacing: 6) {
            Text("Subscriptions renew automatically unless cancelled at least 24 hours before the end of the period. Manage or cancel in Settings › Apple ID › Subscriptions.")
            HStack(spacing: 16) {
                Link("Terms", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                Link("Privacy", destination: URL(string: "https://compose.grepawk.com/privacy")!)
            }
            Link("Billing help: yisheng.jiang@gmail.com", destination: URL(string: "mailto:yisheng.jiang@gmail.com")!)
        }
        .font(.caption2).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
    }
}

/// Toolbar entry point used on Profile and Create.
struct ProButton: View {
    @ObservedObject var store = PurchaseStore.shared
    var body: some View {
        Button { store.presentPaywall(reason: "profile") } label: { Label(store.isPro ? "Pro" : "Get Pro", systemImage: "crown.fill") }
            .accessibilityIdentifier("getPro")
    }
}
