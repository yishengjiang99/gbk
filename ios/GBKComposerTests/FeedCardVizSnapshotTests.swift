import SwiftUI
import UIKit
import XCTest
import AVFoundation
@testable import GBKComposer

/// TestFlight build 4 regressions: tags wrapped mid-word, and the spectrum/waveform row was blank on device.
/// Writes light/dark PNGs (SNAPSHOT_DIR → `ios-snapshots` artifact) to compare with web's feed card
/// (docs/social/screenshots/web-feed-*.png).
@MainActor
final class FeedCardVizSnapshotTests: XCTestCase {
    nonisolated static let longTags = ["cinematic", "e-flat-major", "epic", "film-score", "heroic", "horns", "orchestral", "timpani",
                           "a-very-long-tag-that-is-wider-than-the-card"]

    static func song(tags: [String] = longTags, labels: [String] = ["classical", "cinematic"]) -> Song {
        let enc = { (a: [String]) in String(data: try! JSONEncoder().encode(a), encoding: .utf8)! }
        let json = """
        {"slug":"ember-crown","title":"Ember Crown","url":null,
         "author":{"handle":"maestroaria","display_name":"maestroaria","avatar_url":null,"song_count":3,"rating_avg":2,"created_at":0},
         "created_at":0,"published_at":0,"labels":\(enc(labels)),"tags":\(enc(tags)),"rating_avg":2,"rating_count":1,
         "comment_count":0,"play_count":2,"fork_count":0,"my_rating":null,"media":null,
         "preview":{"tracks":["#4fc3f7","#ffb74d","#81c784","#e57373"],"lo":50,"hi":80,"end":61440,
           "notes":[[0,0,40,62],[1,20,30,74],[2,30,40,55],[3,40,20,71],[0,60,40,65],[1,70,30,77],[2,80,60,58]]},
         "prompt_shared":false,"prompt_text":null,"parent_slug":null,"is_mine":false}
        """
        return try! APIClient.makeDecoder().decode(Song.self, from: Data(json.utf8))
    }

    /// Analyzer fed with decoded PCM (the device fallback path), a 220 Hz + 1760 Hz tone, no tap.
    static func playingBack() -> CardPlayback {
        let rate = 44_100.0
        let pcm = DecodedPCM(samples: (0..<Int(rate * 3)).map { i in
            let t = Double(i) / rate
            return Float(0.5 * sin(2 * .pi * 220 * t) + 0.25 * sin(2 * .pi * 1760 * t))
        }, sampleRate: rate)
        let analyzer = SpectrumAnalyzer()
        analyzer.pcm = pcm
        return CardPlayback(time: { 1.5 }, duration: { 10 }, analyzer: analyzer, isPlaying: true)
    }

    private func render<V: View>(_ view: V, name: String, style: UIUserInterfaceStyle, size: CGSize,
                                 type: DynamicTypeSize = .large) throws -> UIImage {
        let scheme: ColorScheme = style == .dark ? .dark : .light
        let host = UIHostingController(rootView: view
            .environmentObject(AuthStore.shared)
            .environment(\.colorScheme, scheme)
            .dynamicTypeSize(type)
            .preferredColorScheme(scheme))
        host.overrideUserInterfaceStyle = style
        let window: UIWindow
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            window = UIWindow(windowScene: scene); window.frame = CGRect(origin: .zero, size: size)
        } else { window = UIWindow(frame: CGRect(origin: .zero, size: size)) }
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        let png = try XCTUnwrap(image.pngData())
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png"); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], !dir.isEmpty {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
        return image
    }

    /// RGBA bytes of the whole image.
    private func bytes(_ image: UIImage) -> [UInt8] {
        let cg = image.cgImage!
        let w = cg.width, h = cg.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return px
    }

    private func changedPixels(_ x: UIImage, _ y: UIImage) -> Int {
        let a = bytes(x), b = bytes(y)
        var n = 0
        var i = 0
        while i + 2 < min(a.count, b.count) {
            var d = 0
            for k in 0..<3 { d += abs(Int(a[i + k]) - Int(b[i + k])) }
            if d > 30 { n += 1 }
            i += 4
        }
        return n
    }

    private func card(_ song: Song, _ playback: CardPlayback?) -> some View {
        ZStack { Theme.background.ignoresSafeArea(); FeedCardView(song: song, playback: playback) }
    }

    func testTagsNeverBreakMidWord() throws {
        // Smallest iPhone width (SE 1st gen / mini zoomed: 320 pt) and large Dynamic Type sizes.
        for (type, tag) in [(DynamicTypeSize.large, "default"), (.xxxLarge, "xxxl"), (.accessibility3, "ax3")] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                _ = try render(card(Self.song(), nil), name: "feed-tags-320-\(tag)-\(style == .dark ? "dark" : "light")",
                               style: style, size: CGSize(width: 320, height: 760), type: type)
            }
        }
        // Break opportunities exist only at the spaces between words: no ASCII hyphen or space inside a tag.
        let text = String(TagChips.paragraph(labels: ["classical"], tags: Self.longTags).characters)
        for word in text.split(separator: " ") { XCTAssertFalse(word.contains("-"), String(word)) }
        XCTAssertTrue(text.contains("#film\u{2011}score"))
        XCTAssertTrue(text.hasPrefix("classical · #cinematic"))
        // The card never grows past the 320 pt screen at AX3.
        let card320 = UIHostingController(rootView: FeedCardView(song: Self.song(), playback: nil)
            .environmentObject(AuthStore.shared).dynamicTypeSize(.accessibility3))
        XCTAssertLessThanOrEqual(card320.sizeThatFits(in: CGSize(width: 320, height: 2000)).width, 320.5, "card")
    }

    func testSpectrumAndWaveformRenderWhilePlaying() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let name = style == .dark ? "dark" : "light"
            let idle = try render(card(Self.song(), nil), name: "feed-viz-idle-\(name)", style: style, size: CGSize(width: 393, height: 760))
            let live = try render(card(Self.song(), Self.playingBack()), name: "feed-viz-playing-\(name)", style: style,
                                  size: CGSize(width: 393, height: 760))
            // Same card, same size: playing must paint bars + waveform, so many pixels differ from the idle frame.
            let changed = changedPixels(idle, live)
            XCTAssertGreaterThan(changed, 20_000, "\(name): playing card must draw spectrum + waveform")
        }
    }

    func testPCMFallbackFeedsAnalyzerWithoutTap() {
        let back = Self.playingBack()
        let f = back.analyzer!.frame(now: 0, mediaTime: 1.5)
        XCTAssertNotNil(f.samples)
        XCTAssertEqual(f.samples?.count, FeedVisuals.fftSize)
        XCTAssertGreaterThan(f.levels.max() ?? 0, 0.5, "220 Hz tone lights its bar")
        XCTAssertNil(SpectrumAnalyzer().frame(now: 0, mediaTime: 1).samples, "no source → idle look")
    }

    func testDecodesBundledAudioFile() throws {
        // Round-trip a short generated WAV through DecodedPCM.decode (the path used for downloaded mp3s).
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("viz-test.caf")
        let fmt = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
        let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 4410)!
        buf.frameLength = 4410
        for c in 0..<2 { for i in 0..<4410 { buf.floatChannelData![c][i] = Float(sin(Double(i) * 0.1)) } }
        do { let f = try AVAudioFile(forWriting: url, settings: fmt.settings); try f.write(from: buf) }
        let pcm = try XCTUnwrap(DecodedPCM.decode(url))
        XCTAssertEqual(pcm.samples.count, 4410)
        XCTAssertEqual(pcm.sampleRate, 44_100)
        XCTAssertNotNil(pcm.window(endingAt: 0.05, count: 2048))
    }
}
