import SwiftUI
import UIKit
import CoreImage
import XCTest
@testable import GBKComposer

/// Renders the feed card and sign-in in light and dark. PNGs are attached to the test result and, when
/// SNAPSHOT_DIR is set (CI passes TEST_RUNNER_SNAPSHOT_DIR), written there for upload as a CI artifact.
@MainActor
final class SnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, name: String, style: UIUserInterfaceStyle,
                                 size: CGSize = CGSize(width: 393, height: 760)) throws -> UIImage {
        let host = UIHostingController(rootView: view.environmentObject(AuthStore.shared))
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        let png = try XCTUnwrap(image.pngData())
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], !dir.isEmpty {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
        return image
    }

    private func averageLuminance(_ image: UIImage) -> CGFloat {
        let ctx = CIContext()
        guard let ci = CIImage(image: image),
              let filter = CIFilter(name: "CIAreaAverage", parameters: [kCIInputImageKey: ci, kCIInputExtentKey: CIVector(cgRect: ci.extent)]),
              let out = filter.outputImage else { return -1 }
        var px = [UInt8](repeating: 0, count: 4)
        ctx.render(out, toBitmap: &px, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        return (0.2126 * CGFloat(px[0]) + 0.7152 * CGFloat(px[1]) + 0.0722 * CGFloat(px[2])) / 255
    }

    func testFeedCardLightAndDark() throws {
        let card = ZStack { Theme.background.ignoresSafeArea(); FeedCardView(song: PreviewFixtures.song, playback: nil) }
        let light = try render(card, name: "feed-card-light", style: .light)
        let dark = try render(card, name: "feed-card-dark", style: .dark)
        XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2, "dark appearance should be clearly darker")
    }

    func testSignInLightAndDark() throws {
        let view = ZStack { Theme.background.ignoresSafeArea(); SignInView(reason: "Sign in to see your profile and songs.") }
        let light = try render(view, name: "sign-in-light", style: .light)
        let dark = try render(view, name: "sign-in-dark", style: .dark)
        XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2)
    }

    func testAllThemeColorsResolveInBothAppearances() {
        let names = ["AccentColor", "OnAccent", "BackgroundTop", "BackgroundBottom", "Surface", "SurfaceRaised", "CardTop", "CardBottom",
                     "TextPrimary", "TextSecondary", "Border", "Chip", "RollRow", "Playhead", "Waveform", "BarStart", "BarEnd",
                     "TrackFallback", "Destructive"]
        for name in names {
            let c = UIColor(named: name, in: Bundle(for: AppDelegate.self), compatibleWith: nil)
            XCTAssertNotNil(c, name)
        }
        let light = UIColor(named: "TextPrimary")!.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        let dark = UIColor(named: "TextPrimary")!.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        XCTAssertNotEqual(light, dark)
    }
}
