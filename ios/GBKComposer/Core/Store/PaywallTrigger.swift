import Foundation
import Combine

/// What the trigger engine decided for one `/api/me` snapshot (#123).
enum PaywallTriggerDecision: Equatable {
    case none
    /// Show the native paywall now. `hard` = the account is at a real limit (daily AI budget /
    /// render limit), so the sheet is a gate rather than a nudge and the soft cooldown is skipped.
    case present(reason: String, hard: Bool)
}

/// The trigger's persisted memory: when a soft paywall was last shown, when a trigger sheet was
/// last dismissed, and which soft/hard reason is inside an already-presented episode. The server
/// runs the same 24 h cooldown off its own dismiss reports (`MePaywall.cooldownUntil`); this local
/// copy keeps the cadence when a report is lost (offline) and stops re-presentation on every
/// `/api/me` refresh while a trigger stays armed.
struct PaywallTriggerState: Equatable {
    var lastSoftShownAt: Date? = nil
    var lastDismissedAt: Date? = nil
    var softEpisodeReason: String? = nil
    var hardEpisodeReason: String? = nil

    private static let shownKey = "paywall.trigger.lastSoftShownAt"
    private static let dismissedKey = "paywall.trigger.lastDismissedAt"
    private static let softKey = "paywall.trigger.softEpisodeReason"
    private static let hardKey = "paywall.trigger.hardEpisodeReason"

    static func load(from defaults: UserDefaults = .standard) -> PaywallTriggerState {
        PaywallTriggerState(
            lastSoftShownAt: defaults.object(forKey: shownKey) as? Date,
            lastDismissedAt: defaults.object(forKey: dismissedKey) as? Date,
            softEpisodeReason: defaults.string(forKey: softKey),
            hardEpisodeReason: defaults.string(forKey: hardKey))
    }

    func save(to defaults: UserDefaults = .standard) {
        if let lastSoftShownAt { defaults.set(lastSoftShownAt, forKey: Self.shownKey) }
        else { defaults.removeObject(forKey: Self.shownKey) }
        if let lastDismissedAt { defaults.set(lastDismissedAt, forKey: Self.dismissedKey) }
        else { defaults.removeObject(forKey: Self.dismissedKey) }
        if let softEpisodeReason { defaults.set(softEpisodeReason, forKey: Self.softKey) }
        else { defaults.removeObject(forKey: Self.softKey) }
        if let hardEpisodeReason { defaults.set(hardEpisodeReason, forKey: Self.hardKey) }
        else { defaults.removeObject(forKey: Self.hardKey) }
    }
}

/// Pure trigger logic (#123): one `/api/me` snapshot in, a presentation decision out.
/// Soft triggers (`second_composition`, `export_after_2`) present on the eligibility flip — at
/// most once per distinct reason, and at most once per 24 h (the persisted cooldown, anchored at
/// both the last soft presentation and the last dismissal). Hard reasons (`ai_limit`,
/// `render_limit`) present immediately, once per episode, cooldown or not: the user is blocked,
/// not nudged. Pro users never see a trigger. Episode markers re-arm when the reason clears.
struct PaywallTriggerEngine {
    static let cooldown: TimeInterval = 24 * 3_600
    private(set) var state: PaywallTriggerState

    init(state: PaywallTriggerState = PaywallTriggerState()) { self.state = state }

    mutating func evaluate(paywall: MePaywall?, isPro: Bool, now: Date) -> PaywallTriggerDecision {
        guard !isPro, let paywall, let reason = paywall.reason else {
            state.softEpisodeReason = nil
            state.hardEpisodeReason = nil
            return .none
        }
        if MePaywall.hardReasons.contains(reason) {
            guard state.hardEpisodeReason != reason else { return .none }
            state.hardEpisodeReason = reason
            return .present(reason: reason, hard: true)
        }
        state.hardEpisodeReason = nil // a non-hard snapshot ends any hard episode
        guard MePaywall.softReasons.contains(reason) else {
            state.softEpisodeReason = nil
            return .none
        }
        guard paywall.eligible else { return .none } // server cooldown, or the trigger is not armed
        guard state.softEpisodeReason != reason else { return .none } // already shown for this trigger
        if let t = state.lastDismissedAt, now.timeIntervalSince(t) < Self.cooldown { return .none }
        if let t = state.lastSoftShownAt, now.timeIntervalSince(t) < Self.cooldown { return .none }
        state.softEpisodeReason = reason
        state.lastSoftShownAt = now
        return .present(reason: reason, hard: false)
    }

    /// A trigger-presented sheet was dismissed: start the local 24 h cooldown.
    mutating func noteDismissed(now: Date) { state.lastDismissedAt = now }
}

/// Watches `/api/me` snapshots (AuthStore) for paywall-eligibility flips and opens the native
/// paywall (#123). Refresh points live with the callers — Studio tab open (RootTabView), app
/// foreground (GBKComposerApp) and publish completion (StudioWebView) re-run
/// `AuthStore.loadMe()`; every resulting snapshot, plus snapshots from elsewhere (sign-in,
/// purchase), is evaluated here. Trigger presentations and dismissals are reported to
/// `POST /api/me/engagement` (#115) so the server's counters and cooldown advance; the #119
/// funnel events (`paywall_view` / `paywall_dismiss` to `/api/events`) fire from PaywallView.
@MainActor
final class PaywallTriggerWatcher {
    static let shared = PaywallTriggerWatcher()

    private var engine: PaywallTriggerEngine
    private let defaults: UserDefaults
    private var subs: [AnyCancellable] = []
    private var started = false

    /// Injectable for tests: presents the paywall (default: PurchaseStore, reason-tagged for #119).
    var present: (String) -> Void = { PurchaseStore.shared.presentPaywall(reason: $0) }
    /// Injectable for tests: the reason of the sheet that just closed (default: PurchaseStore).
    var sheetReason: () -> String = { PurchaseStore.shared.paywallReason }
    /// Injectable for tests: reports an engagement event, then resyncs `/api/me` so the next
    /// snapshot carries the server's updated eligibility/cooldown.
    var report: (String) -> Void = { event in
        Task { @MainActor in
            _ = try? await APIClient.shared.send(Endpoints.meEngagement(event: event), as: EngagementReply.self)
            await AuthStore.shared.loadMe()
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.engine = PaywallTriggerEngine(state: PaywallTriggerState.load(from: defaults))
    }

    func start() {
        guard !started else { return }
        started = true
        AuthStore.shared.$me.receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.evaluate() }.store(in: &subs)
        PurchaseStore.shared.$isPro.receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.evaluate() }.store(in: &subs)
        evaluate()
    }

    /// The paywall sheet closed. Only trigger presentations count: a dismissal starts the 24 h
    /// cooldown, locally and (via the report) on the server. Manual opens (Profile button, Studio
    /// pricing links) neither consume a trigger nor start its cooldown.
    func sheetDismissed() {
        let reason = sheetReason()
        guard MePaywall.softReasons.contains(reason) || MePaywall.hardReasons.contains(reason) else { return }
        engine.noteDismissed(now: Date())
        persist()
        report("paywall_dismiss")
    }

    private func evaluate() {
        guard !PurchaseStore.shared.showPaywall else { return } // never stomp a sheet already up
        let me = AuthStore.shared.me
        let isPro = PurchaseStore.shared.isPro || (me?.hasActivePro() ?? false)
        let decision = engine.evaluate(paywall: me?.paywall, isPro: isPro, now: Date())
        persist()
        if case .present(let reason, _) = decision {
            present(reason)
            report("paywall_view")
        }
    }

    private func persist() { engine.state.save(to: defaults) }

    /// `POST /api/me/engagement` reply (`{ usage, paywall }`): only the paywall is decoded; the
    /// follow-up `loadMe()` in `report` resyncs the full record either way.
    private struct EngagementReply: Decodable { let paywall: MePaywall? }
}
