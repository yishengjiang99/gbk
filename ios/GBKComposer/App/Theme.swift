import SwiftUI
import UIKit

/// All colours come from asset-catalog colour sets with light and dark variants
/// (Resources/Assets.xcassets). Light values follow GBK Social web (src/components/social/social.css);
/// feed viz colours are web LiveRoll's light/dark palette.
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
    /// Tag chips: web `.so-chip` (bg --so-roll-bg, border --so-border-hover, text --so-accent); labels are `.so-chip.lab`.
    static let tagChipBorder = Color("TagChipBorder")
    static let tagChipText = Color("TagChipText")
    static let tagLabelText = Color("TagLabelText")
    /// Feed viz palette: the shipped web values, i.e. social.css `--viz-*` (which override LiveRoll `DEF`, gbk #108).
    static let vizBg = Color("VizBg")
    static let vizGrid = Color("VizGrid")
    static let vizRow = Color("VizRow")
    static let vizHead = Color("VizHead")
    static let vizBar = Color("VizBar")
    static let vizWave = Color("VizWave")
    static let vizDim = Color("VizDim")
    static let trackFallback = Color("TrackFallback")
    static let destructive = Color("Destructive")

    static var background: LinearGradient {
        LinearGradient(colors: [backgroundTop, backgroundBottom], startPoint: .top, endPoint: .bottom)
    }
    static var cardGradient: LinearGradient {
        LinearGradient(colors: [cardTop, cardBottom], startPoint: .topLeading, endPoint: .bottomTrailing)
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
