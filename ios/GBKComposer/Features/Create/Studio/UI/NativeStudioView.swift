import SwiftUI
import Combine

/// Owns the native Studio's long-lived objects: the project store, the audio driver and the agent chat session.
@MainActor
final class NativeStudioModel: ObservableObject {
    let store: WorkstationStore
    let session: AgentSession
    private let driver: StudioAudioDriver
    private var bag: Set<AnyCancellable> = []

    init() {
        let s = WorkstationStore()
        store = s
        driver = StudioAudioDriver.install(store: s)
        session = AgentSession(store: s)
        // Forward nested changes so views observing only this model refresh with the store/session.
        s.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
        session.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
    }

    func start() { session.start() }
}

struct NativeStudioView: View {
    @StateObject private var model = NativeStudioModel()
    @State private var draft = ""
    @State private var errorText: String?
    @State private var showRoll = false

    var body: some View {
        VStack(spacing: 0) {
            TransportBar(store: model.store)
            Divider()
            TrackList(store: model.store)
            ProposalPanel(store: model.store, errorText: $errorText)
            Divider()
            Picker("View", selection: $showRoll) {
                Text("Chat").tag(false); Text("Piano roll").tag(true)
            }.pickerStyle(.segmented).padding(.horizontal).padding(.vertical, 6)
            if showRoll { PianoRollView(store: model.store) } else { ChatTranscript(session: model.session) }
            Composer(draft: $draft, running: model.session.run != nil,
                     send: { if model.session.send(draft) { draft = "" } },
                     stop: { model.session.stop() })
        }
        .task { model.start() }
        .accessibilityIdentifier("native-studio")
    }
}

private struct TransportBar: View {
    @ObservedObject var store: WorkstationStore
    var body: some View {
        HStack(spacing: 16) {
            Button { store.transport.playing ? store.pause() : store.play() } label: {
                Image(systemName: store.transport.playing ? "pause.fill" : "play.fill")
            }.accessibilityIdentifier("studio-play")
            Button { store.stop() } label: { Image(systemName: "stop.fill") }
            Text(store.project.name).font(.headline).lineLimit(1)
            Spacer()
            Button { _ = store.undo() } label: { Image(systemName: "arrow.uturn.backward") }
            Button { _ = store.redo() } label: { Image(systemName: "arrow.uturn.forward") }
        }
        .padding(.horizontal).padding(.vertical, 10)
    }
}

private struct TrackList: View {
    @ObservedObject var store: WorkstationStore
    @State private var editing: String?
    var body: some View {
        let project = store.project
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(project.tracks, id: \.id) { t in
                    let n = project.notes.filter { $0.trackId == t.id }.count
                    Button { editing = t.id } label: {
                        Text("\(t.name) · \(n)")
                            .font(.caption).padding(.horizontal, 10).padding(.vertical, 6)
                            .background(.thinMaterial, in: Capsule())
                            .opacity(t.mix.mute ? 0.45 : 1)
                    }.buttonStyle(.plain)
                }
                Menu {
                    Button("Add instrument track") { _ = TrackActions.addTrack(store) }
                    Button("Add drum track") { _ = TrackActions.addTrack(store, drums: true) }
                } label: { Image(systemName: "plus.circle").font(.title3) }
                    .accessibilityIdentifier("studio-add-track")
            }.padding(.horizontal)
        }
        .padding(.vertical, 6)
        .sheet(item: Binding(get: { editing.map(TrackSelection.init) }, set: { editing = $0?.id })) { sel in
            TrackSheet(store: store, trackId: sel.id).presentationDetents([.medium, .large])
        }
    }
}

private struct TrackSelection: Identifiable { let id: String }

private struct ProposalPanel: View {
    @ObservedObject var store: WorkstationStore
    @Binding var errorText: String?
    var body: some View {
        let pending = store.proposals.filter { $0.status == "pending" }
        if !pending.isEmpty || errorText != nil {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(pending) { p in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(p.summary).font(.subheadline).lineLimit(2)
                            Text(p.source == "agent" ? "Proposed by assistant" : "Proposed edit").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Reject") { try? store.discardProposal(p.id) }.buttonStyle(.bordered)
                        Button("Accept") {
                            Task { do { _ = try await store.commitProposal(p.id, source: "user") } catch { errorText = error.localizedDescription } }
                        }.buttonStyle(.borderedProminent)
                    }
                }
                if let e = errorText { Text(e).font(.caption).foregroundStyle(.red) }
            }
            .padding().background(.thinMaterial)
        }
    }
}

private struct ChatTranscript: View {
    @ObservedObject var session: AgentSession
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(session.items, id: \.id) { item in
                        ChatBubble(item: item).id(item.id)
                    }
                    if let r = session.run {
                        Text("Working… step \(r.step)/\(r.maxSteps)").font(.caption).foregroundStyle(.secondary)
                    }
                }.padding()
            }
            .onChange(of: session.items.last?.text) { _, _ in
                if let id = session.items.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }
}

private struct ChatBubble: View {
    let item: ChatItem
    var body: some View {
        VStack(alignment: item.role == "user" ? .trailing : .leading, spacing: 4) {
            if !item.text.isEmpty {
                Text(item.text)
                    .padding(10)
                    .background(item.role == "user" ? Color.accentColor.opacity(0.18) : item.role == "error" ? Color.red.opacity(0.15) : Color.secondary.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 12))
            }
            ForEach(item.steps ?? [], id: \.callId) { s in
                Label(s.summary ?? s.task, systemImage: s.status == "done" ? "checkmark.circle" : s.status == "failed" ? "xmark.circle" : "ellipsis.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: item.role == "user" ? .trailing : .leading)
    }
}

private struct Composer: View {
    @Binding var draft: String
    let running: Bool
    let send: () -> Void
    let stop: () -> Void
    var body: some View {
        HStack {
            TextField("Describe the music you want…", text: $draft, axis: .vertical)
                .lineLimit(1...4).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("studio-composer")
            if running {
                Button(action: stop) { Image(systemName: "stop.circle.fill").font(.title2) }
            } else {
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding()
    }
}
