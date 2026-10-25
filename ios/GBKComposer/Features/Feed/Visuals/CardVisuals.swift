import SwiftUI

/// What the active card needs to animate. Cards without one draw statically.
/// Time and duration are read from AVPlayer by closure every frame (CMTime → seconds), never via published state.
struct CardPlayback {
    let time: @MainActor () -> Double?
    let duration: @MainActor () -> Double?
    let analyzer: SpectrumAnalyzer?
    let isPlaying: Bool
}

private let blackKeys: Set<Int> = [1, 3, 6, 8, 10]

/// Row 1: windowed piano roll. Current and upcoming notes move right-to-left toward a fixed playhead at 25%;
/// finished notes disappear. Look follows the web Export video / LiveRoll: black-key row stripes, track colours,
/// active notes brightened with a glow, a 2 pt playhead line.
struct LiveRollView: View {
    let preview: SongPreview?
    let tracks: [String]
    let playback: CardPlayback?

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !(playback?.isPlaying ?? false))) { timeline in
            Canvas { ctx, size in
                _ = timeline.date // redraw every animation frame while unpaused
                draw(&ctx, size: size)
            }
        }
        .accessibilityLabel("Piano roll")
    }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize) {
        let lo = preview?.lo ?? 60, hi = preview?.hi ?? 72
        let rows = hi - lo + 1, span = max(12, rows), nh = size.height / span, off = (span - rows) * nh / 2
        for p in Int(lo)...Int(max(lo, hi)) where blackKeys.contains(p % 12) {
            ctx.fill(Path(CGRect(x: 0, y: (hi - Double(p)) * nh + off, width: size.width, height: nh)), with: .color(Theme.rollRow))
        }
        let duration = playback?.duration()
        if let playback, let duration, let time = playback.time() {
            let t = time.truncatingRemainder(dividingBy: duration)
            let notes = PianoRollMath.notes(from: preview, durationSeconds: duration)
            for n in PianoRollMath.window(notes: notes, time: t, lo: lo, hi: hi, durationSeconds: duration) {
                let rect = CGRect(x: n.x0 * size.width, y: n.yTop * size.height,
                                  width: max(2, (n.x1 - n.x0) * size.width), height: max(2, n.height * size.height))
                drawNote(&ctx, rect: rect, track: n.note.track, active: n.isActive)
            }
        } else {
            // Static (inactive / not loaded): whole-song overview.
            for raw in preview?.notes ?? [] where raw.count >= 4 {
                let rect = CGRect(x: raw[1] / 1000 * size.width, y: (hi - raw[3]) * nh + off,
                                  width: max(2, raw[2] / 1000 * size.width), height: max(2, nh * 0.85))
                drawNote(&ctx, rect: rect, track: Int(raw[0]), active: false)
            }
        }
        let x = size.width * FeedVisuals.playheadFraction
        ctx.fill(Path(CGRect(x: x - 1, y: 0, width: 2, height: size.height)), with: .color(Theme.playhead))
    }

    private func drawNote(_ ctx: inout GraphicsContext, rect: CGRect, track: Int, active: Bool) {
        let hex = track >= 0 && track < tracks.count ? tracks[track] : nil
        let path = Path(roundedRect: rect, cornerRadius: min(2, rect.height / 2))
        if active {
            ctx.drawLayer { layer in
                layer.addFilter(.shadow(color: Theme.track(hex), radius: 4))
                layer.fill(path, with: .color(Theme.trackLit(hex)))
            }
        } else {
            ctx.fill(path, with: .color(Theme.track(hex).opacity(0.85)))
        }
    }
}

/// Row 2 left: 48 log-spaced spectrum bars from the audio tap. Instant attack, 150 ms decay.
struct SpectrumBarsView: View {
    let playback: CardPlayback?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let colors = (0..<FeedVisuals.barCount).map { Theme.barColor($0, of: FeedVisuals.barCount, scheme: scheme) }
        TimelineView(.animation(minimumInterval: nil, paused: !(playback?.isPlaying ?? false))) { timeline in
            Canvas { ctx, size in
                let now = timeline.date.timeIntervalSinceReferenceDate
                let levels: [Float] = (playback?.isPlaying ?? false)
                    ? (playback?.analyzer?.bars(now: now) ?? [])
                    : []
                let bw = size.width / CGFloat(FeedVisuals.barCount)
                for i in 0..<FeedVisuals.barCount {
                    let v = i < levels.count ? CGFloat(levels[i]) : 0
                    let h = max(1, v * size.height)
                    ctx.fill(Path(CGRect(x: CGFloat(i) * bw + bw * 0.15, y: size.height - h, width: bw * 0.7, height: h)),
                             with: .color(colors[i]))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Row 2 right: oscilloscope of the latest time-domain buffer from the same tap.
struct WaveformView: View {
    let playback: CardPlayback?

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !(playback?.isPlaying ?? false))) { timeline in
            Canvas { ctx, size in
                _ = timeline.date
                let mid = size.height / 2
                ctx.fill(Path(CGRect(x: 0, y: mid - 0.5, width: size.width, height: 1)), with: .color(Theme.border))
                guard playback?.isPlaying == true, let sink = playback?.analyzer?.sink else { return }
                let pts = WaveformMath.points(sink.latest(1024))
                guard pts.count > 1 else { return }
                var path = Path()
                for (i, v) in pts.enumerated() {
                    let p = CGPoint(x: CGFloat(i) / CGFloat(pts.count - 1) * size.width, y: mid - CGFloat(v) * mid * 0.95)
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                ctx.stroke(path, with: .color(Theme.waveform), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
        }
        .accessibilityHidden(true)
    }
}
