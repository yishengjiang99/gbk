import SwiftUI

/// Card labels + tags as ONE text paragraph (Yisheng, 2026-10-25): "rnb · #groove #key‑change #late‑night".
/// Wraps only at the spaces between words; hyphens are U+2011 (non-breaking) so a tag never splits.
/// Footnote, secondary colour, labels semibold, max 3 lines. Tapping a tag filters by it (gbktag:// link).
struct TagChips: View {
    let labels: [String]
    let tags: [String]
    var onTag: (String) -> Void = { _ in }

    static let scheme = "gbktag"

    /// Unbreakable form of one word: hyphens → U+2011, any internal whitespace → U+00A0.
    static func unbreakable(_ s: String) -> String {
        s.replacingOccurrences(of: "-", with: "\u{2011}")
            .replacingOccurrences(of: " ", with: "\u{00A0}")
    }

    static func paragraph(labels: [String], tags: [String]) -> AttributedString {
        var out = AttributedString()
        for (i, l) in labels.enumerated() {
            var a = AttributedString((i > 0 ? " " : "") + unbreakable(l))
            a.font = .footnote.weight(.semibold)
            a.foregroundColor = Theme.text
            out += a
        }
        if !labels.isEmpty && !tags.isEmpty { out += AttributedString(" ·") }
        for (i, t) in tags.enumerated() {
            if i > 0 || !labels.isEmpty { out += AttributedString(" ") }
            var a = AttributedString("#" + unbreakable(t))
            a.link = URL(string: "\(scheme)://tag?t=\(t.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? t)")
            out += a
        }
        return out
    }

    var body: some View {
        Text(Self.paragraph(labels: labels, tags: tags))
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .tint(Theme.textSecondary)
            .lineLimit(3)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == Self.scheme,
                      let t = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
                else { return .systemAction }
                onTag(t)
                return .handled
            })
            .accessibilityIdentifier("card-tags")
    }
}
