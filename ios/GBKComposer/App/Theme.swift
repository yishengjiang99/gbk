import SwiftUI
import UIKit

/// All colours come from asset-catalog colour sets with light and dark variants
/// (Resources/Assets.xcassets). Light values follow GBK Social web (src/components/social/social.css);
/// web has no dark palette yet, so the dark variants are defined here (see docs/social/STATUS.md).
enum Theme {
    static let accent = Color("AccentColor")
    static let onAccent = Color("OnAccent")
    static let backgroundTop = Color("BackgroundTop")
    static let backgroundBottom = Color("BackgroundBottom")
    static let surface = Color("Surface")
    static let surfaceRaised = Color("SurfaceRaised")
    static let cardTop = Color("CardTop")
    static let cardBottom = Color("CardBottom")
    static let text = Color("TextPrimary")
    static let textSecondary = Color("TextSecondary")
    static let border = Color("Border")
    static let chip = Color("Chip")
    static let rollRow = Color("RollRow")
    static let playhead = Color("Playhead")
    static let waveform = Color("Waveform")
    static let barStart = Color("BarStart")
    static let barEnd = Color("BarEnd")
    static let trackFallback = Color("TrackFallback")
    static let destructive = Color("Destructive")

    static var background: LinearGradient {
        LinearGradient(colors: [backgroundTop, backgroundBottom], startPoint: .top, endPoint: .bottom)
    }
    static var cardGradient: LinearGradient {
        LinearGradient(colors: [cardTop, cardBottom], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// Colour for bar `i` of `count`: interpolated between BarStart and BarEnd for the current appearance.
    static func barColor(_ i: Int, of count: Int, scheme: ColorScheme) -> Color {
        let t = count > 1 ? CGFloat(i) / CGFloat(count - 1) : 0
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        let a = UIColor(named: "BarStart")?.resolvedColor(with: traits) ?? .systemBlue
        let b = UIColor(named: "BarEnd")?.resolvedColor(with: traits) ?? .systemPink
        var (h1, s1, v1, a1, h2, s2, v2, a2): (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0, 0, 0, 0, 0)
        a.getHue(&h1, saturation: &s1, brightness: &v1, alpha: &a1)
        b.getHue(&h2, saturation: &s2, brightness: &v2, alpha: &a2)
        if h2 < h1 { h2 += 1 } // sweep 200° → 340° through violet, like web hsl()
        let h = (h1 + (h2 - h1) * t).truncatingRemainder(dividingBy: 1)
        return Color(hue: Double(h), saturation: Double(s1 + (s2 - s1) * t), brightness: Double(v1 + (v2 - v1) * t))
    }

    /// Server track colour (`#rrggbb`), falling back to TrackFallback.
    static func track(_ hex: String?) -> Color {
        guard let rgb = rgb(hex) else { return trackFallback }
        return Color(red: rgb.r, green: rgb.g, blue: rgb.b)
    }

    /// Track colour brightened toward full intensity by `k` (web `brighten`, k = 0.45).
    static func trackLit(_ hex: String?, k: Double = FeedVisuals.activeBrighten) -> Color {
        guard let c = rgb(hex) else { return trackFallback }
        return Color(red: c.r + (1 - c.r) * k, green: c.g + (1 - c.g) * k, blue: c.b + (1 - c.b) * k)
    }

    static func rgb(_ hex: String?) -> (r: Double, g: Double, b: Double)? {
        guard var s = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count >= 6, let v = UInt32(s.prefix(6), radix: 16) else { return nil }
        return (Double((v >> 16) & 0xff) / 255, Double((v >> 8) & 0xff) / 255, Double(v & 0xff) / 255)
    }
}
