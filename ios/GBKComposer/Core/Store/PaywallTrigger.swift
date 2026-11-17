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

/// Pure trigger logic: one `/api/me` snapshot in, a presentation decision out.
/// Only hard reasons from `/api/me` (`ai_budget`, `render_limit`) auto-present, once per episode,
/// cooldown or not: the user is blocked, not nudged. Pro users never see a trigger. Episode
/// markers re-arm when the reason clears. Soft `third_song` is not on this snapshot — it is
/// decided when a free user starts a new song (`ThirdSongGate`).
struct PaywallTriggerEngine {
    static let cooldown: TimeInterval = 24 * 3_600
    private(set) var state: PaywallTriggerState

    init(state: PaywallTriggerState = PaywallTriggerState()) { self.state = state }

    mutating func evaluate(paywall: MePaywall?, isPro: Bool, now _: Date) -> PaywallTriggerDecision {
        guard !isPro, let paywall, let reason = paywall.reason, MePaywall.isHard(reason) else {
            state.hardEpisodeReason = nil
            return .none
        }
        guard state.hardEpisodeReason != reason else { return .none }
        state.hardEpisodeReason = reason
        return .present(reason: reason, hard: true)
    }

    /// A trigger-presented sheet was dismissed: start the local 24 h cooldown.
    mutating func noteDismissed(now: Date) { state.lastDismissedAt = now }
}

/// Watches `/api/me` snapshots (AuthStore) for hard paywall limits and opens the native paywall.
/// Refresh points live with the callers — Studio tab open (RootTabView), app foreground
/// (GBKComposerApp) and publish completion (StudioWebView) re-run `AuthStore.loadMe()`.
/// Presentations and dismissals are reported to `POST /api/me/engagement` with the reason;
/// funnel events to `/api/events` fire from PaywallView.
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
    /// Injectable for tests: reports an engagement event with its reason, then resyncs `/api/me`.
    var report: (String, String) -> Void = { event, reason in
        Task { @MainActor in
            _ = try? await APIClient.shared.send(Endpoints.meEngagement(event: event, reason: reason), as: EngagementReply.self)
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

    /// The paywall sheet closed. Trigger presentations (hard limits, 3rd-song, export) report
    /// `paywall_dismiss` with the reason. Manual opens (Profile button, untagged Studio links)
    /// do not. A `third_song` dismiss starts no cooldown; hard/export dismiss cannot resume the
    /// blocked action — that action already failed the 402 / export check.
    func sheetDismissed() {
        let reason = sheetReason()
        guard MePaywall.softReasons.contains(reason) || MePaywall.hardReasons.contains(reason) else { return }
        if reason != "third_song" {
            engine.noteDismissed(now: Date())
            persist()
        }
        report("paywall_dismiss", reason)
    }

    private func evaluate() {
        guard !PurchaseStore.shared.showPaywall else { return } // never stomp a sheet already up
        let me = AuthStore.shared.me
        let isPro = PurchaseStore.shared.isPro || (me?.hasActivePro() ?? false)
        let decision = engine.evaluate(paywall: me?.paywall, isPro: isPro, now: Date())
        persist()
        if case .present(let reason, _) = decision {
            present(reason)
            report("paywall_view", reason)
        }
    }

    private func persist() { engine.state.save(to: defaults) }

    /// `POST /api/me/engagement` reply (`{ usage, paywall }`): only the paywall is decoded; the
    /// follow-up `loadMe()` in `report` resyncs the full record either way.
    private struct EngagementReply: Decodable { let paywall: MePaywall? }
}
