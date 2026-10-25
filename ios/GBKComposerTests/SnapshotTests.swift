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
        let scheme: ColorScheme = style == .dark ? .dark : .light
        let host = UIHostingController(rootView: view
            .environmentObject(AuthStore.shared)
            .environment(\.colorScheme, scheme)
            .preferredColorScheme(scheme))
        host.overrideUserInterfaceStyle = style
        let window: UIWindow
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            window = UIWindow(windowScene: scene)
            window.frame = CGRect(origin: .zero, size: size)
        } else {
            window = UIWindow(frame: CGRect(origin: .zero, size: size))
        }
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

    override func setUp() async throws { AuthStore.shared.clearLocal() }

    func testFeedCardLightAndDark() throws {
        let card = ZStack { Theme.background.ignoresSafeArea(); FeedCardView(song: PreviewFixtures.song, playback: nil) }
        let light = try render(card, name: "feed-card-light", style: .light)
        let dark = try render(card, name: "feed-card-dark", style: .dark)
        XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2, "dark appearance should be clearly darker")
    }

    func testSignInLightAndDark() throws {
        let view = ZStack { Theme.background.ignoresSafeArea(); SignInView(reason: "Sign in to rate songs.") }
        let light = try render(view, name: "sign-in-light", style: .light)
        let dark = try render(view, name: "sign-in-dark", style: .dark)
        XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2)
    }

    func testPaywallLightAndDark() throws {
        let view = PaywallView(store: PurchaseStore(verifier: MockIAPVerifier(), accountId: { nil }))
        let size = CGSize(width: 393, height: 852)
        let light = try render(view, name: "paywall-light", style: .light, size: size)
        let dark = try render(view, name: "paywall-dark", style: .dark, size: size)
        XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2, "paywall must follow Dark Mode")
    }

    func testSignedOutProfileAndInbox() throws {
        AuthStore.shared.clearLocal()
        XCTAssertFalse(AuthStore.shared.isSignedIn)
        for (name, view) in [("profile-signed-out", AnyView(ProfileView())), ("inbox-signed-out", AnyView(InboxView()))] {
            let light = try render(view, name: "\(name)-light", style: .light)
            let dark = try render(view, name: "\(name)-dark", style: .dark)
            XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2, name)
        }
    }

    func testAllThemeColorsResolveInBothAppearances() {
        let names = ["AccentColor", "OnAccent", "BackgroundTop", "BackgroundBottom", "Surface", "SurfaceRaised", "CardTop", "CardBottom",
                     "TextPrimary", "TextSecondary", "Border", "Chip", "VizBg", "VizGrid", "VizRow", "VizHead", "VizBar", "VizWave", "VizDim",
                     "TrackFallback", "Destructive"]
        for name in names {
            let c = UIColor(named: name, in: Bundle(for: AppDelegate.self), compatibleWith: nil)
            XCTAssertNotNil(c, name)
        }
        let light = UIColor(named: "TextPrimary")!.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        let dark = UIColor(named: "TextPrimary")!.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        XCTAssertNotEqual(light, dark)
    }

    func testScanEntryAndErrorLightAndDark() throws {
        let fixture = FixtureSheetRecognizer(result: .failure(.nothingRecognized))
        let entry = ScanController(recognizer: fixture)
        let failed = ScanController(recognizer: fixture)
        failed.phase = .error(.nothingRecognized)
        let readOnly = ScanController(recognizer: fixture)
        readOnly.phase = .error(.readOnlyProject)
        for (name, c) in [("scan-entry", entry), ("scan-error", failed), ("scan-read-only", readOnly)] {
            let light = try render(ScanSheetView(controller: c), name: "\(name)-light", style: .light)
            let dark = try render(ScanSheetView(controller: c), name: "\(name)-dark", style: .dark)
            XCTAssertGreaterThan(averageLuminance(light), averageLuminance(dark) + 0.2, name)
        }
    }
}
