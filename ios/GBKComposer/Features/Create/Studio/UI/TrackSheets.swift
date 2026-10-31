import SwiftUI

/// Palette for new tracks (cycled by track count).
private let newTrackPalette = ["#4f8cff", "#ff7a59", "#3ecf8e", "#c678dd", "#f5c542", "#38bdf8", "#ef5da8", "#9aa5b1"]

/// Track controls: rename, mute/solo, instrument picker.
struct TrackSheet: View {
    @ObservedObject var store: WorkstationStore
    let trackId: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var picking = false

    private var track: GTrack? { store.project.tracks.first { $0.id == trackId } }
    private var program: ProgramEvent? { store.project.programs.filter { $0.trackId == trackId && $0.tick <= 0 }.max { $0.tick < $1.tick } }

    var body: some View {
        NavigationStack {
            if let t = track {
                Form {
                    Section("Name") {
                        TextField("Track name", text: $name).onSubmit { apply(TrackPatch(name: name.isEmpty ? nil : name)) }
                    }
                    Section("Instrument") {
                        Button { picking = true } label: {
                            HStack { Text(t.channel == 9 ? "Drums (channel 10)" : "Program \(program?.program ?? 0)"); Spacer(); Image(systemName: "chevron.right") }
                        }
                    }
                    Section("Mix") {
                        Toggle("Mute", isOn: Binding(get: { t.mix.mute }, set: { apply(TrackPatch(mute: $0)) }))
                        Toggle("Solo", isOn: Binding(get: { t.mix.solo }, set: { apply(TrackPatch(solo: $0)) }))
                        Stepper("Volume \(t.mix.volume)", value: Binding(get: { t.mix.volume }, set: { apply(TrackPatch(volume: $0)) }), in: 0...127, step: 8)
                    }
                }
                .navigationTitle(t.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { commitName(); dismiss() } } }
                .onAppear { name = t.name }
                .sheet(isPresented: $picking) { InstrumentPicker(store: store, trackId: trackId) }
            }
        }
    }

    private func commitName() { if !name.isEmpty, name != track?.name { apply(TrackPatch(name: name)) } }
    private func apply(_ patch: TrackPatch) { _ = try? store.userEdit([.updateTrack(id: trackId, patch: patch)]) }
}

/// Searchable list of the loaded SoundFont's presets; selecting one writes a program change at tick 0.
struct InstrumentPicker: View {
    @ObservedObject var store: WorkstationStore
    let trackId: String
    @Environment(\.dismiss) private var dismiss
    @State private var presets: [JSONValue] = []
    @State private var query = ""
    @State private var loading = true

    private var shown: [JSONValue] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        // Drums (bank 128) belong to channel 10; melodic tracks list the rest.
        let isDrums = store.project.tracks.first { $0.id == trackId }?.channel == 9
        return presets.filter { p in
            let bank = p["bank"]?.intValue ?? 0
            return (bank == 128) == isDrums && (q.isEmpty || (p["name"]?.stringValue ?? "").lowercased().contains(q))
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if loading { ProgressView("Loading SoundFont…") }
                ForEach(Array(shown.enumerated()), id: \.offset) { _, p in
                    Button {
                        let program = p["program"]?.intValue ?? 0, bank = p["bank"]?.intValue ?? 0
                        _ = try? store.userEdit([.setProgram(trackId: trackId, program: program, bankMsb: bank == 128 ? 0 : bank, bankLsb: 0, tick: 0)])
                        dismiss()
                    } label: {
                        HStack { Text(p["name"]?.stringValue ?? "—"); Spacer(); Text("\(p["program"]?.intValue ?? 0)").foregroundStyle(.secondary).font(.caption) }
                    }
                }
            }
            .searchable(text: $query)
            .navigationTitle("Instrument").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task {
                await store.host.ensureSoundFont?()
                presets = store.host.listPresets?() ?? []
                loading = false
            }
        }
    }
}

enum TrackActions {
    /// Adds a melodic track on the lowest free channel (skipping 10, which is drums).
    static func addTrack(_ store: WorkstationStore, drums: Bool = false) -> String? {
        let p = store.project
        let used = Set(p.tracks.map { $0.channel })
        guard let ch = drums ? 9 : (0..<16).first(where: { $0 != 9 && !used.contains($0) }) else { return nil }
        let t = GTrack(id: newStudioId("trk"), name: drums ? "Drums" : "Track \(p.tracks.count + 1)", channel: ch,
                       color: newTrackPalette[p.tracks.count % newTrackPalette.count], mix: .default, visible: true, role: nil)
        return (try? store.userEdit([.addTrack(t, index: nil)])) != nil ? t.id : nil
    }
}
