import SwiftUI

/// Native publish sheet for the studio (bright theme): title, labels (≤3), tags (≤10, plain-text chips),
/// share-prompt toggle. Guests publish as the device's two-word username; no sign-in.
struct NativePublishSheet: View {
    @State var draft: PublishDraft
    var username: String = AnonymousIdentity.username
    var service: GuestPublishing = GuestPublishServices.current
    var onClose: () -> Void

    @State private var tagText = ""
    @State private var busy = false
    @State private var error: String?
    @State private var result: PublishResult?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let result { done(result) } else { form }
                }
                .padding(20)
            }
            .background(Color.white)
            .navigationTitle("Publish")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(result == nil ? "Cancel" : "Done", action: onClose).accessibilityIdentifier("publish-cancel") } }
            .safeAreaInset(edge: .bottom) {
                if result == nil {
                    Button { Task { await publish() } } label: {
                        Text(busy ? "Publishing…" : "Publish").font(.headline).frame(maxWidth: .infinity, minHeight: 48)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.accent)
                    .disabled(!draft.canPublish || busy)
                    .padding(.horizontal, 20).padding(.vertical, 10)
                    .background(Color.white)
                    .accessibilityIdentifier("publish-submit")
                }
            }
        }
        .preferredColorScheme(.light)
        .accessibilityIdentifier("publish-sheet")
    }

    @ViewBuilder private var form: some View {
        Text("Publishing makes your song visible to everyone in the Feed with a shareable link. You publish as **\(username)**.")
            .font(.subheadline).foregroundStyle(.secondary)
        section("Title") {
            TextField("Song title", text: $draft.title)
                .textFieldStyle(.roundedBorder).accessibilityIdentifier("publish-title")
        }
        section("Labels (up to \(PublishDraft.maxLabels))") {
            FlowLayout(spacing: 8) {
                ForEach(PublishDraft.labelOptions, id: \.self) { l in
                    let on = draft.labels.contains(l)
                    Button(l) { draft.toggleLabel(l) }
                        .font(.subheadline)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .background(on ? Theme.accent : Color(white: 0.95), in: Capsule())
                        .accessibilityIdentifier("publish-label-\(l)")
                        .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        section("Tags (\(draft.tags.count)/\(PublishDraft.maxTags))") {
            HStack {
                TextField("add a tag", text: $tagText)
                    .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(addTag).accessibilityIdentifier("publish-tag-input")
                Button("Add", action: addTag).disabled(draft.tags.count >= PublishDraft.maxTags).accessibilityIdentifier("publish-tag-add")
            }
            FlowLayout(spacing: 8) {
                ForEach(draft.tags, id: \.self) { t in
                    Button { draft.tags.removeAll { $0 == t } } label: { Text("#\(t)  ✕").font(.subheadline) }
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Color(white: 0.95), in: Capsule())
                        .accessibilityIdentifier("publish-tag-\(t)")
                }
            }
        }
        Toggle("Share the prompt I used (others can remix it)", isOn: $draft.sharePrompt)
            .tint(Theme.accent).accessibilityIdentifier("publish-share-prompt")
        if let error { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("publish-error") }
    }

    private func done(_ r: PublishResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Published!").font(.title2.bold()).accessibilityIdentifier("publish-done")
            Text("Your song is on the Feed as \(r.author).").foregroundStyle(.secondary)
            ShareLink(item: r.url) { Label("Share link", systemImage: "square.and.arrow.up") }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) { Text(title).font(.subheadline.weight(.semibold)); content() }
    }

    private func addTag() { draft.addTags(tagText); tagText = "" }

    private func publish() async {
        busy = true; error = nil
        defer { busy = false }
        do { result = try await service.publish(draft, as: username) }
        catch { self.error = "Couldn't publish. Check your connection and try again." }
    }
}

/// Wrapping row layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        rows(proposal.width ?? .infinity, subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, p) in rows(bounds.width, subviews).points.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }
    private func rows(_ width: CGFloat, _ subviews: Subviews) -> (points: [CGPoint], size: CGSize) {
        var pts: [CGPoint] = [], x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            pts.append(CGPoint(x: x, y: y)); x += sz.width + spacing; rowH = max(rowH, sz.height); maxX = max(maxX, x)
        }
        return (pts, CGSize(width: max(0, maxX - spacing), height: y + rowH))
    }
}

#Preview("Publish") { NativePublishSheet(draft: PublishDraft(title: "Gentle Piano Hum in C"), username: "MellowFox", onClose: {}) }
