import SwiftUI

/// Touch piano roll over WorkstationStore: tap empty space to add a note on the active track, tap a note to select it,
/// drag a note to move it (snapped to a 16th / semitone), and use the toolbar to resize, delete or change velocity.
struct PianoRollView: View {
    @ObservedObject var store: WorkstationStore
    @State private var activeTrackId: String?
    @State private var selectedId: String?
    @State private var pxPerBeat: CGFloat = 48
    @State private var dragId: String?
    @State private var dragDelta: (ticks: Int, semis: Int) = (0, 0)

    private let rowH: CGFloat = 16
    private let lowPitch = 24, highPitch = 108
    private var project: Project { store.project }
    private var grid: Int { max(1, project.ppq / 4) }
    private var pxPerTick: CGFloat { pxPerBeat / CGFloat(project.ppq) }
    private var totalTicks: Int { max(project.endTick, project.ppq * 4 * 8) + project.ppq * 4 }
    private var contentSize: CGSize { CGSize(width: CGFloat(totalTicks) * pxPerTick, height: CGFloat(highPitch - lowPitch + 1) * rowH) }
    private var activeTrack: GTrack? { project.tracks.first { $0.id == activeTrackId } ?? project.tracks.first }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if project.tracks.isEmpty {
                ContentUnavailableView("No tracks yet", systemImage: "pianokeys", description: Text("Ask the assistant to create a track, then edit its notes here."))
            } else {
                ScrollView([.horizontal, .vertical]) { roll.frame(width: contentSize.width, height: contentSize.height) }
            }
            if let n = project.notes.first(where: { $0.id == selectedId }) { noteBar(n) }
        }
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(project.tracks, id: \.id) { t in
                        Button(t.name) { activeTrackId = t.id }
                            .font(.caption).buttonStyle(.bordered)
                            .tint(t.id == activeTrack?.id ? .accentColor : .gray)
                    }
                }
            }
            Stepper("", value: $pxPerBeat, in: 16...160, step: 16).labelsHidden().fixedSize()
        }.padding(.horizontal).padding(.vertical, 6)
    }

    private func noteBar(_ n: GNote) -> some View {
        HStack(spacing: 14) {
            Text(pitchName(n.pitch)).font(.subheadline.monospaced())
            Button { edit(n.id, NotePatch(duration: max(grid, n.duration - grid))) } label: { Image(systemName: "minus") }
            Text("\(n.duration / grid) × 16th").font(.caption)
            Button { edit(n.id, NotePatch(duration: n.duration + grid)) } label: { Image(systemName: "plus") }
            Stepper("vel \(n.velocity)", value: Binding(get: { n.velocity }, set: { edit(n.id, NotePatch(velocity: min(127, max(1, $0)))) }), in: 1...127, step: 8)
                .font(.caption)
            Spacer()
            Button(role: .destructive) {
                _ = try? store.userEdit([.removeNotes([n.id])]); selectedId = nil
            } label: { Image(systemName: "trash") }
        }.padding().background(.thinMaterial)
    }

    // MARK: Roll

    private var roll: some View {
        Canvas { ctx, size in
            for p in lowPitch...highPitch {
                let y = yFor(pitch: p)
                let black = [1, 3, 6, 8, 10].contains(p % 12)
                ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: rowH)), with: .color(black ? Color.secondary.opacity(0.10) : Color.clear))
                if p % 12 == 0 { ctx.fill(Path(CGRect(x: 0, y: y + rowH - 1, width: size.width, height: 1)), with: .color(.secondary.opacity(0.4))) }
            }
            var t = 0
            while t <= totalTicks {
                let isBar = (t / project.ppq) % 4 == 0
                ctx.fill(Path(CGRect(x: CGFloat(t) * pxPerTick, y: 0, width: isBar ? 1.5 : 0.5, height: size.height)), with: .color(.secondary.opacity(isBar ? 0.5 : 0.25)))
                t += project.ppq
            }
            let colors = Dictionary(uniqueKeysWithValues: project.tracks.map { ($0.id, Color(hex: $0.color)) })
            for n in project.notes where n.pitch >= lowPitch && n.pitch <= highPitch {
                let r = rect(for: n)
                let active = n.trackId == activeTrack?.id
                let c = (colors[n.trackId] ?? .accentColor).opacity(active ? 0.95 : 0.3)
                ctx.fill(Path(roundedRect: r, cornerRadius: 3), with: .color(c))
                if n.id == selectedId { ctx.stroke(Path(roundedRect: r, cornerRadius: 3), with: .color(.primary), lineWidth: 2) }
            }
            let x = CGFloat(store.transport.positionTick) * pxPerTick
            ctx.fill(Path(CGRect(x: x, y: 0, width: 2, height: size.height)), with: .color(.red))
        }
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 8)
            .onChanged { v in
                if dragId == nil, let n = hitNote(v.startLocation) { dragId = n.id; selectedId = n.id }
                guard dragId != nil else { return }
                dragDelta = (snapTicks(Int(v.translation.width / pxPerTick)), -Int((v.translation.height / rowH).rounded()))
            }
            .onEnded { _ in
                defer { dragId = nil; dragDelta = (0, 0) }
                guard let id = dragId, let n = project.notes.first(where: { $0.id == id }) else { return }
                let patch = NotePatch(tick: max(0, n.tick + dragDelta.ticks), pitch: min(127, max(0, n.pitch + dragDelta.semis)))
                edit(id, patch)
            })
        .simultaneousGesture(SpatialTapGesture().onEnded { v in tap(v.location) })
    }

    // MARK: Geometry & editing

    private func yFor(pitch: Int) -> CGFloat { CGFloat(highPitch - pitch) * rowH }

    private func rect(for n: GNote) -> CGRect {
        let moving = n.id == dragId
        let tick = moving ? max(0, n.tick + dragDelta.ticks) : n.tick
        let pitch = moving ? n.pitch + dragDelta.semis : n.pitch
        return CGRect(x: CGFloat(tick) * pxPerTick, y: yFor(pitch: pitch) + 1, width: max(4, CGFloat(n.duration) * pxPerTick), height: rowH - 2)
    }

    private func hitNote(_ p: CGPoint) -> GNote? {
        project.notes.reversed().first { n in
            n.trackId == activeTrack?.id && rect(for: n).insetBy(dx: -2, dy: -2).contains(p)
        } ?? project.notes.reversed().first { rect(for: $0).contains(p) }
    }

    private func snapTicks(_ t: Int) -> Int { Int((Double(t) / Double(grid)).rounded()) * grid }

    private func tap(_ p: CGPoint) {
        if let n = hitNote(p) { selectedId = n.id; return }
        guard let track = activeTrack else { return }
        let tick = max(0, Int(p.x / pxPerTick) / grid * grid)
        let pitch = highPitch - Int(p.y / rowH)
        guard pitch >= lowPitch, pitch <= highPitch else { return }
        let note = GNote(id: newStudioId("n"), trackId: track.id, channel: track.channel, tick: tick, duration: project.ppq / 2, pitch: pitch, velocity: 90, offVelocity: nil)
        if (try? store.userEdit([.addNotes([note])])) != nil { selectedId = note.id }
    }

    private func edit(_ id: String, _ patch: NotePatch) { _ = try? store.userEdit([.updateNotes([(id: id, patch: patch)])]) }

    private func pitchName(_ p: Int) -> String {
        ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][p % 12] + "\(p / 12 - 1)"
    }
}

private extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var v: UInt64 = 0
        guard s.count == 6, Scanner(string: s).scanHexInt64(&v) else { self = .accentColor; return }
        self.init(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
    }
}
