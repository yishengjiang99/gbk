import Foundation
import OMRHomrIOS
import UIKit

/// Warmup progress 0...1 with a simple ETA (seconds remaining, estimated from the previous
/// warmup's total; nil when unknown). Called from a background thread.
struct ScanWarmupProgress: Sendable, Equatable {
    var fraction: Double
    var etaSeconds: Double?
}

/// Called from a background thread; the call site hops to the main actor as needed.
typealias ScanWarmupProgressHandler = @Sendable (ScanWarmupProgress) -> Void

/// Thread-safe multicast for warmup progress: the launch warmup starts without a watcher, and a
/// scan that arrives mid-warmup attaches its handler to the in-flight run. Mirrors Music
/// Reader's `WarmupProgressBus`.
final class ScanWarmupProgressBus: @unchecked Sendable {
    private let lock = NSLock()
    private var handlers: [ScanWarmupProgressHandler] = []
    /// Last broadcast, replayed to handlers attached mid-run so a scan that starts during the
    /// warmup flips to "Warming up…" immediately instead of sitting at "Reading…" until the
    /// next step boundary.
    private var last = ScanWarmupProgress(fraction: 0, etaSeconds: nil)
    func add(_ h: @escaping ScanWarmupProgressHandler) {
        lock.lock(); handlers.append(h); let cur = last; lock.unlock()
        h(cur)
    }
    func broadcast(_ p: ScanWarmupProgress) {
        lock.lock(); last = p; let hs = handlers; lock.unlock()
        for h in hs { h(p) }
    }
    func clear() {
        lock.lock(); handlers.removeAll(); last = ScanWarmupProgress(fraction: 0, etaSeconds: nil); lock.unlock()
    }
    /// Drop a stale `last` when a fresh run begins (retry after failure); handlers re-attach after.
    func reset() {
        lock.lock(); last = ScanWarmupProgress(fraction: 0, etaSeconds: nil); lock.unlock()
    }
}

/// App-level warmup of the homr page models, at parity with Music Reader's `ModelWarmup` —
/// adapted to GBK: the thing warmed is the package's cached page session itself
/// (`PageSessionCache` via `OMRHomrIOS.warmUpPageSession`), because GBK's recognizer consumes
/// that cache, not app-owned sessions.
///
/// - Started at app launch (`GBKComposerApp`) and kicked again on foreground (a GBK addition;
///   Music Reader has no foreground kick), always in a detached utility task, never on main.
/// - A scan attaches to an in-flight warmup (progress bus replay) or to a re-warm after a
///   memory-warning release, but never starts a first-ever warmup — launch owns that, and a
///   scan on a never-warmed process falls back to the recognizer's lazy load, as before.
/// - On a memory warning the package cache is released and state returns to idle, preserving
///   `hasWarmedOnce` so the next warmup is reported as a re-warm.
@MainActor
final class ScanModelWarmup: ObservableObject {
    enum State: Equatable {
        case idle, warming, ready
        case failed(String)
    }

    /// Loads the shared page session, reporting load fractions 0...1. Throws on failure.
    typealias Loader = @Sendable (@escaping PageLoadProgressHandler) throws -> Void

    static let shared = ScanModelWarmup()

    @Published private(set) var state: State = .idle
    /// True once any warmup has completed. Tells a post-memory-warning re-warm apart from a
    /// first-ever warmup (launch owns that; a scan must never auto-start one).
    private(set) var hasWarmedOnce = false

    private let loader: Loader
    private let bus = ScanWarmupProgressBus()
    private var task: Task<Void, Never>?
    private var memoryObserver: NSObjectProtocol?

    /// ETA self-calibration (UserDefaults, GBK-namespaced): the last warmup's total, smoothed.
    static let expectedTotalDefaultsKey = "gbk.omr.warmup.expectedTotalMs"
    static let nominalTotalMs = 40_000.0

    init(loader: Loader? = nil, notificationCenter: NotificationCenter = .default) {
        self.loader = loader ?? { progress in _ = try OMRHomrIOS.warmUpPageSession(progress: progress) }
        memoryObserver = notificationCenter.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in self?.releaseModels() }
        }
    }

    deinit {
        if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
    }

    // MARK: - Pure helpers (unit-tested)

    /// Seconds remaining from elapsed time vs the expected total (never negative).
    /// `nonisolated`: also called from the detached warmup worker (ETA wrapping).
    nonisolated static func etaSeconds(elapsedMs: Double, expectedTotalMs: Double) -> Double {
        max(0, expectedTotalMs - elapsedMs) / 1_000
    }

    /// Exponentially smoothed expected total for the next run (0.7 old / 0.3 new, as Music Reader).
    nonisolated static func smoothedExpectedTotal(previousMs: Double, newMs: Double) -> Double {
        previousMs > 0 ? 0.7 * previousMs + 0.3 * newMs : newMs
    }

    // MARK: - Lifecycle

    /// If a warmup is in-flight, failed (retry), or due for re-warm after a memory warning,
    /// attach `progress` to it — starting it when needed — and return true. Returns false when
    /// already warm (proceed with no warmup phase) or never warmed. Never starts a first-ever
    /// warmup.
    func attachProgressIfNeeded(_ progress: @escaping ScanWarmupProgressHandler) -> Bool {
        switch state {
        case .ready:
            return false
        case .warming, .failed:
            break
        case .idle:
            guard hasWarmedOnce else { return false }
        }
        start(progress: progress)
        return true
    }

    /// Foreground kick: no-op when ready or already warming; (re)starts when failed or idle
    /// (never started, or released after a memory warning).
    func startOnForeground() {
        guard state != .ready, state != .warming else { return }
        start()
    }

    /// Starts the warmup once (re-runs only after a failure or a release). Returns immediately;
    /// the load runs in a detached utility task. `progress`, when given, is attached to the
    /// in-flight run (even one started earlier without a watcher, e.g. at app launch) and
    /// receives the bus's replayed current fraction immediately.
    func start(progress: ScanWarmupProgressHandler? = nil) {
        if task != nil, state != .idle, !isFailed {
            // Attach to the in-flight run: the bus replays the current fraction immediately.
            if let progress { bus.add(progress) }
            return
        }
        // Fresh run (first, retry, or post-memory-warning re-warm): drop any stale fraction
        // before attaching, so a late attacher never latches onto the previous run's ~95%.
        bus.reset()
        if let progress { bus.add(progress) }
        state = .warming
        let bus = bus
        let loader = loader
        let t0 = DispatchTime.now()
        var expectedTotalMs = UserDefaults.standard.double(forKey: Self.expectedTotalDefaultsKey)
        if expectedTotalMs <= 0 { expectedTotalMs = Self.nominalTotalMs }
        let worker = Task.detached(priority: .utility) { () -> Result<Void, Error> in
            Result {
                try loader { fraction in
                    let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
                    bus.broadcast(ScanWarmupProgress(
                        fraction: fraction,
                        etaSeconds: Self.etaSeconds(elapsedMs: elapsedMs, expectedTotalMs: expectedTotalMs)))
                }
            }
        }
        task = Task { [weak self] in
            let result = await worker.value
            bus.clear()
            guard let self else { return }
            switch result {
            case .success:
                state = .ready
                hasWarmedOnce = true
                let totalMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
                let ud = UserDefaults.standard
                ud.set(Self.smoothedExpectedTotal(previousMs: ud.double(forKey: Self.expectedTotalDefaultsKey), newMs: totalMs),
                       forKey: Self.expectedTotalDefaultsKey)
            case .failure(let error):
                state = .failed(String(describing: error))
            }
        }
    }

    /// Suspends until the in-flight warmup finishes (ready or failed). No-op when not warming.
    /// Callers proceed either way: on failure the recognizer's lazy load retries and surfaces
    /// its own error, exactly as it did before the warmup existed.
    func waitUntilReady() async {
        guard state == .warming, let task else { return }
        await task.value
    }

    /// Memory warning: drop the package's cached page session so ORT / CoreML memory is freed;
    /// the next warmup (foreground kick or scan attach) warms again. No-op while warming.
    /// `hasWarmedOnce` is preserved, so the next run is a re-warm.
    func releaseModels() {
        guard state != .warming else { return }
        OMRHomrIOS.releasePageSession()
        task = nil
        state = .idle
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }
}
