import SwiftUI

enum Theme {
    /// #2d6a93
    static let accent = Color(red: 0x2d / 255.0, green: 0x6a / 255.0, blue: 0x93 / 255.0)
    static let skyTop = Color(red: 0.88, green: 0.95, blue: 1.0)
    static let skyBottom = Color(red: 0.70, green: 0.86, blue: 0.97)
    static let card = Color.white.opacity(0.85)

    static var background: LinearGradient {
        LinearGradient(colors: [skyTop, skyBottom], startPoint: .top, endPoint: .bottom)
    }
    static var cardGradient: LinearGradient {
        LinearGradient(colors: [Color(red: 0.80, green: 0.91, blue: 0.99), Color(red: 0.62, green: 0.80, blue: 0.95)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
