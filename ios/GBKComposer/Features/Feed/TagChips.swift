import SwiftUI

/// Card labels + tags, a port of web `.so-chips` / `.so-chip` (src/components/social/social.css):
/// flex-wrap with 4 pt gaps; each chip is one unbroken line (white-space: nowrap) and wraps as a whole.
struct TagChips: View {
    let labels: [String]
    let tags: [String]
    var onTag: (String) -> Void = { _ in }

    var body: some View {
        ChipFlowLayout(spacing: 4) {
            ForEach(labels, id: \.self) { TagChip(text: $0, isLabel: true) }
            ForEach(tags, id: \.self) { tag in
                Button { onTag(tag) } label: { TagChip(text: "#\(tag)", isLabel: false) }
                    .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("card-tags")
    }
}

struct TagChip: View {
    let text: String
    let isLabel: Bool
    @ScaledMetric(relativeTo: .caption) private var hPad: CGFloat = 10
    @ScaledMetric(relativeTo: .caption) private var vPad: CGFloat = 4

    var body: some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .lineLimit(1)
            .truncationMode(.middle)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(isLabel ? Theme.tagLabelText : Theme.tagChipText)
            .padding(.horizontal, hPad).padding(.vertical, vPad)
            .background(Capsule().fill(isLabel ? Theme.accent : Theme.vizBg))
            .overlay(Capsule().stroke(isLabel ? Theme.accent : Theme.tagChipBorder, lineWidth: 1))
    }
}

/// Wraps whole subviews onto new rows (never splits one). Never breaks a chip's text; a single chip wider than the whole row gets its own row, middle-truncated.
struct ChipFlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let w = rows.map { $0.width }.max() ?? 0
        let h = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for (i, size) in zip(row.indices, row.sizes) {
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: size.width, height: nil))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    struct Row { var indices: [Int] = []; var sizes: [CGSize] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    func arrange(width maxW: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [], row = Row()
        for i in subviews.indices {
            var s = subviews[i].sizeThatFits(.unspecified)
            s.width = min(s.width, maxW)
            if !row.indices.isEmpty && row.width + spacing + s.width > maxW { rows.append(row); row = Row() }
            row.width += (row.indices.isEmpty ? 0 : spacing) + s.width
            row.height = max(row.height, s.height)
            row.indices.append(i); row.sizes.append(s)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}
