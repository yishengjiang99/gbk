import SwiftUI

/// One-time scroll cue for the feed view: a "Swipe up" hint, plus a single bounce
/// 2 s after the first song starts playing. Both end after the first swipe to the
/// next card, persisted in UserDefaults. UI tests skip the cue unless they pass
/// `-UITestFeedScrollCue`.
struct FeedViewScrollCue {
    static let defaultsKey = "gbk.feedScrollCueDone"
    static let playDelay: TimeInterval = 2.0
    static let nudgePoints: CGFloat = 70
    static let nudgeDuration: TimeInterval = 0.35
    static let springBackDuration: TimeInterval = 0.60
    static let uiTestOptInArgument = "-UITestFeedScrollCue"

    private(set) var showsHint = false
    private var done: Bool
    private var scrolled = false
    /// Read-only peek at `scrolled`: safe to poll on every drag event without mutating state.
    var hasScrolled: Bool { scrolled }
    private var bounceFired = false
    private var scheduled = false

    static func shouldSkipForUITest(
        isUITest: Bool = UITestMode.isEnabled,
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> Bool {
        isUITest && !arguments.contains(uiTestOptInArgument)
    }

    init(defaults: UserDefaults = .standard, skipped: Bool = Self.shouldSkipForUITest()) {
        self.done = skipped || defaults.bool(forKey: Self.defaultsKey)
    }

    /// Call when the first card's song starts playing and a next card exists.
    /// Returns true the first time the 2 s bounce timer should be started.
    mutating func firstSongStartedPlaying(hasNextCard: Bool) -> Bool {
        guard !done, hasNextCard else { return false }
        showsHint = true
        guard !scrolled, !bounceFired, !scheduled else { return false }
        scheduled = true
        return true
    }

    /// Whether to run the bounce once the 2 s delay has elapsed.
    mutating func bounceDeadlineReached(reduceMotion: Bool) -> Bool {
        guard showsHint, !done, !scrolled, !bounceFired else { return false }
        bounceFired = true
        return !reduceMotion
    }

    /// Any user scroll before a swipe to the next card: skip the bounce, keep the hint.
    mutating func userScrolled() {
        scrolled = true
    }

    /// A filter change starts a new first song; allow the 2 s timer to be scheduled again
    /// if the bounce has not already run and the user has not scrolled.
    mutating func resetScheduleIfBounceStillPending() {
        if !bounceFired && !scrolled { scheduled = false }
    }

    mutating func swipedToNextCard(defaults: UserDefaults = .standard) {
        scrolled = true
        showsHint = false
        done = true
        defaults.set(true, forKey: Self.defaultsKey)
    }
}

/// Chevron + "Swipe up" at the bottom of the feed view. Pulses unless Reduce Motion is on.
struct FeedViewScrollCueHint: View {
    var pulse: Bool
    @State private var dimmed = false

    var body: some View {
        VStack(spacing: 2) {
            Image(systemName: "chevron.up")
                .font(.system(size: 18, weight: .bold))
            Text("Swipe up")
                .font(.subheadline.weight(.semibold))
        }
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Capsule().fill(Theme.surfaceRaised.opacity(0.92)))
        .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
        .opacity(dimmed ? 0.55 : 1)
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Swipe up")
        .accessibilityIdentifier("feedViewScrollCue")
        .onAppear {
            guard pulse else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                dimmed = true
            }
        }
    }
}
