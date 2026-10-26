import SwiftUI

/// What the active card needs to animate. Cards without one draw a static frame.
/// Time and duration are read from AVPlayer by closure every frame (CMTime → seconds), never via published state.
struct CardPlayback {
    let time: @MainActor () -> Double?
    let duration: @MainActor () -> Double?
    let analyzer: SpectrumAnalyzer?
    let isPlaying: Bool
}

private let blackKeys: Set<Int> = [1, 3, 6, 8, 10]

/// Feed now-playing viz, a port of web `LiveRoll` (src/components/social/LiveRoll.tsx, gbk #108, db68404).
/// The roll fills the canvas: playing = 4 s scrolling window, else the whole song (no playhead). Playing cards overlay
/// 48 spectrum bars + the 256-point waveform semi-transparently over the bottom 38%; paused cards show a faint idle line.
struct NowPlayingVizView: View {
    let preview: SongPreview?
    let playback: CardPlayback?

    var body: some View {
        let live = playback?.isPlaying ?? false
        TimelineView(.animation(minimumInterval: nil, paused: !live)) { timeline in
            Canvas { ctx, size in
                draw(&ctx, size: size, now: timeline.date.timeIntervalSinceReferenceDate, live: live)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("piano-roll and spectrum")
        .accessibilityIdentifier("card-pianoroll")
    }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, now: Double, live: Bool) {
        let W = size.width, H = size.height
        let mid = H * (1 - FeedVisuals.overlayFraction / 2), amp = H * FeedVisuals.overlayFraction / 2 - 2
        guard live else {
            // Overview: preview start/len are 0...1000 of the song, so a 1 s "song" in a 1 s window shows all of it.
            drawRoll(&ctx, W: W, H: H, t: 0, dur: 1, window: 1, playhead: 0)
            ctx.fill(Path(CGRect(x: 0, y: mid, width: W, height: 1)), with: .color(Theme.vizDim.opacity(FeedVisuals.idleAlpha)))
            return
        }
        let dur = playback?.duration().flatMap { $0 > 0 && $0.isFinite ? $0 : nil } ?? FeedVisuals.fallbackDuration
        let t = playback?.time() ?? 0
        drawRoll(&ctx, W: W, H: H, t: t, dur: dur, window: FeedVisuals.windowSeconds, playhead: FeedVisuals.playheadFraction)

        // Overlay, anchored to the bottom: spectrum bars + waveform drawn semi-transparently over the roll.
        let sH = H * FeedVisuals.overlayFraction
        let analyzer = playback?.analyzer
        let levels = analyzer?.bars(now: now) ?? []
        let bw = W / CGFloat(FeedVisuals.barCount)
        var bars = Path()
        for b in 0..<FeedVisuals.barCount {
            let v = b < levels.count ? CGFloat(levels[b]) : 0
            let h = max(1, v * (sH - 4))
            bars.addRect(CGRect(x: CGFloat(b) * bw + 1, y: H - h, width: max(1, bw - 2), height: h))
        }
        ctx.fill(bars, with: .color((analyzer != nil ? Theme.vizBar : Theme.vizDim).opacity(FeedVisuals.barAlpha)))

        let samples = analyzer?.waveform() ?? [Float](repeating: 0, count: FeedVisuals.waveformPoints)
        var wave = Path()
        for (k, s) in samples.enumerated() {
            let p = CGPoint(x: CGFloat(k) / CGFloat(samples.count - 1) * W, y: mid - CGFloat(s) * amp)
            if k == 0 { wave.move(to: p) } else { wave.addLine(to: p) }
        }
        ctx.stroke(wave, with: .color((analyzer != nil ? Theme.vizWave : Theme.vizDim).opacity(FeedVisuals.waveAlpha)), lineWidth: max(1, H / 200))
    }

    private func drawRoll(_ ctx: inout GraphicsContext, W: CGFloat, H: CGFloat, t: Double, dur: Double,
                          window: Double, playhead: Double) {
        ctx.fill(Path(CGRect(x: 0, y: 0, width: W, height: H)), with: .color(Theme.vizBg))
        let notes = PianoRollMath.notes(from: preview, durationSeconds: dur)
        let span = PianoRollMath.noteSpan(notes, fallbackLo: preview?.lo ?? 60, fallbackHi: preview?.hi ?? 72)
        let (lo, hi) = PianoRollMath.pitchRange(lo: span.lo, hi: span.hi)
        let rows = hi - lo + 1, rh = H / rows
        for q in Int(lo)...Int(hi) where blackKeys.contains(((q % 12) + 12) % 12) {
            ctx.fill(Path(CGRect(x: 0, y: H - (Double(q) - lo + 1) * rh, width: W, height: rh)), with: .color(Theme.vizRow))
        }
        let tracks = preview?.tracks ?? []
        let gap = FeedVisuals.noteGap, minS = FeedVisuals.minNoteSize
        for n in PianoRollMath.window(notes: notes, time: t, lo: span.lo, hi: span.hi,
                                            windowSeconds: window, playhead: playhead) {
            let hex = n.note.track >= 0 && n.note.track < tracks.count ? tracks[n.note.track] : nil
            let x0 = n.x0 * W, x1 = n.x1 * W
            let rect = CGRect(x: x0, y: CGFloat(n.row) * rh + gap / 2, width: max(minS, x1 - x0 - gap), height: max(minS, rh - gap))
            switch n.state {
            case .active:
                ctx.fill(Path(rect), with: .color(Theme.trackLit(hex)))
                ctx.stroke(Path(rect.insetBy(dx: 0.5, dy: 0.5)), with: .color(Theme.vizHead), lineWidth: 1)
            case .past: ctx.fill(Path(rect), with: .color(Theme.track(hex).opacity(FeedVisuals.pastAlpha)))
            case .upcoming: ctx.fill(Path(rect), with: .color(Theme.track(hex).opacity(FeedVisuals.upcomingAlpha)))
            }
        }
        guard playhead > 0 else { return }
        let hx = (W * playhead).rounded()
        ctx.fill(Path(CGRect(x: hx - 1, y: 0, width: 2, height: H)), with: .color(Theme.vizHead))
    }
}

#Preview("Viz light") { NowPlayingVizView(preview: nil, playback: nil).frame(height: 300).preferredColorScheme(.light) }
#Preview("Viz dark") { NowPlayingVizView(preview: nil, playback: nil).frame(height: 300).preferredColorScheme(.dark) }
