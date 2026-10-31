import Foundation

/// Native port of src/workstation/persistence.ts + the local parts of studio-api.ts.
/// Projects persist as JSON records in Application Support (the IndexedDB "projects"
/// store's equivalent), in the exact wire shape: {id, schemaVersion, savedAt, project}.

func migrateProject(_ raw: JSONValue) -> Project? {
    guard let obj = raw.objectValue else { return nil }
    var pairs = obj
    func get(_ k: String) -> JSONValue? { pairs.first { $0.0 == k }?.1 }
    func set(_ k: String, _ v: JSONValue) {
        if let i = pairs.firstIndex(where: { $0.0 == k }) { pairs[i].1 = v } else { pairs.append((k, v)) }
    }
    let v = get("schemaVersion")?.intValue ?? 0
    if v > projectSchemaVersion { return nil } // from a newer build: don't guess
    if v < 1 {
        if get("channelPressure") == nil { set("channelPressure", .array([])) }
        if get("polyPressure") == nil { set("polyPressure", .array([])) }
        if get("raw") == nil { set("raw", .array([])) }
        if get("pitchBends") == nil { set("pitchBends", .array([])) }
        if get("loop") == nil { set("loop", .object([("enabled", .bool(false)), ("startTick", .int(0)), ("endTick", .int(0))])) }
        if get("selection") == nil { set("selection", .object([("trackIds", .array([])), ("startTick", .int(0)), ("endTick", .int(0)), ("noteIds", .array([]))])) }
        set("schemaVersion", .int(Int64(projectSchemaVersion)))
    }
    for k in ["tracks", "notes", "ccs", "programs", "tempos", "timeSigs"] {
        if get(k)?.arrayValue == nil { return nil }
    }
    if let snd = get("sound"), !snd.isNull {
        let ok = snd.objectValue != nil && snd["tracks"]?.objectValue != nil
        if !ok { pairs.removeAll { $0.0 == "sound" } }
    }
    guard let id = get("id")?.stringValue, !id.isEmpty,
          let ppq = get("ppq")?.intValue, ppq > 0 else { return nil }
    return Project(json: .object(pairs))
}

private let legacyDemoName = "60884_Beethoven-Symphony-No51"

/// A project the user owns: not an open read-only share, not the legacy auto-loaded demo.
func isOwnProject(_ p: Project) -> Bool {
    if p.meta?.sharedFrom != nil { return false }
    if p.revision == 0 && p.name == legacyDemoName { return false }
    return true
}

struct StoredProjectRecord {
    var id: String; var schemaVersion: Int; var savedAt: Double; var project: Project
}

/// File-backed record store (one JSON file per project id).
final class ProjectFileStore: @unchecked Sendable {
    static let shared = ProjectFileStore()
    let directory: URL
    private let queue = DispatchQueue(label: "gbk.studio.projectstore")

    init(directory: URL? = nil) {
        if let directory { self.directory = directory }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.directory = base.appendingPathComponent("GBKStudio/Projects", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    private func fileURL(_ id: String) -> URL {
        directory.appendingPathComponent(id.replacingOccurrences(of: "/", with: "_") + ".json")
    }

    func putProject(_ rec: StoredProjectRecord) {
        queue.sync {
            let obj: JSONValue = .object([
                ("id", .string(rec.id)), ("schemaVersion", .int(Int64(rec.schemaVersion))),
                ("savedAt", .number(rec.savedAt)), ("project", rec.project.json),
            ])
            try? obj.data.write(to: fileURL(rec.id), options: [.atomic])
        }
    }

    func listProjects() -> [StoredProjectRecord] {
        queue.sync {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            var out: [StoredProjectRecord] = []
            for f in files where f.pathExtension == "json" {
                guard let data = try? Data(contentsOf: f), let v = try? JSONValue.parse(data),
                      let id = v["id"]?.stringValue, let savedAt = v["savedAt"]?.doubleValue,
                      let raw = v["project"], let p = migrateProject(raw) else { continue }
                out.append(StoredProjectRecord(id: id, schemaVersion: v["schemaVersion"]?.intValue ?? 1, savedAt: savedAt, project: p))
            }
            return out
        }
    }

    func getLatestProject(where pred: (StoredProjectRecord) -> Bool) -> StoredProjectRecord? {
        listProjects().filter(pred).max { $0.savedAt < $1.savedAt }
    }

    func deleteProject(_ id: String) {
        queue.sync { try? FileManager.default.removeItem(at: fileURL(id)) }
    }
}

/// Debounced autosave (800 ms) keyed by project id:revision, own projects only.
final class StudioAutosaver: @unchecked Sendable {
    private var pending: Task<Void, Never>? = nil
    private var lastKey = ""
    private let files: ProjectFileStore
    init(files: ProjectFileStore = .shared) { self.files = files }

    func attach(to store: WorkstationStore) {
        store.projectChangeHook = { [weak self, weak store] in
            guard let self, let store else { return }
            self.schedule(store: store)
        }
    }

    private func schedule(store: WorkstationStore) {
        let p = store.project
        let key = "\(p.id):\(p.revision)"
        if key == lastKey || p.tracks.isEmpty { return }
        if !isOwnProject(p) || store.readOnlyReason != nil { return }
        lastKey = key
        pending?.cancel()
        let snapshot = p
        pending = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            if Task.isCancelled { return }
            self?.files.putProject(StoredProjectRecord(id: snapshot.id, schemaVersion: projectSchemaVersion, savedAt: nowMs(), project: snapshot))
        }
    }

    /// Persist the current project now (flushSave in studio-api.ts).
    func flush(store: WorkstationStore) {
        let p = store.project
        if !p.tracks.isEmpty && isOwnProject(p) && store.readOnlyReason == nil {
            files.putProject(StoredProjectRecord(id: p.id, schemaVersion: projectSchemaVersion, savedAt: nowMs(), project: p))
        }
    }
}

/// restoreLatest from persistence.ts: the newest own project replaces only an empty or
/// untouched same-song current project; a shared song open in the Studio always wins.
@discardableResult
func restoreLatestProject(into store: WorkstationStore, files: ProjectFileStore = .shared) -> Bool {
    guard let rec = files.getLatestProject(where: { isOwnProject($0.project) }) else { return false }
    let p = rec.project
    let cur = store.project
    if cur.meta?.sharedFrom != nil { return false }
    let agentOwned = p.meta?.owner == "agent"
    if cur.tracks.isEmpty || (cur.revision == 0 && (cur.name == p.name || agentOwned)) {
        store.load(p)
        return true
    }
    return false
}

// MARK: - Published marks + draft/resume state (studio-api.ts, local half)

final class PublishedMarks: @unchecked Sendable {
    static let shared = PublishedMarks()
    private let defaults: UserDefaults
    private let key = "gbk.publishedRevs.v1"
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func marks() -> [(String, Int)] {
        guard let s = defaults.string(forKey: key), let v = try? JSONValue.parse(s), let obj = v.objectValue else { return [] }
        return obj.compactMap { kv in kv.1.intValue.map { (kv.0, $0) } }
    }
    func markPublished(projectId: String, revision: Int) {
        var m = marks().filter { $0.0 != projectId }
        m.append((projectId, revision))
        if m.count > 200 { m.removeFirst(m.count - 200) }
        let obj = JSONValue.object(m.map { ($0.0, .int(Int64($0.1))) })
        defaults.set(obj.serialized, forKey: key)
    }
    func publishedRevision(_ projectId: String) -> Int? { marks().first { $0.0 == projectId }?.1 }
}

struct CurrentProjectState {
    var id: String; var title: String; var published: Bool; var dirtySincePublish: Bool
    var hasContent: Bool; var updatedAt: Double?
}

/// currentProject() with local marks; Phase 6 may widen `published` with the server's
/// public-song list exactly as the web does (by projectId, then by title + recency).
func currentProjectState(_ store: WorkstationStore, marks: PublishedMarks = .shared, files: ProjectFileStore = .shared) -> CurrentProjectState {
    let p = store.project
    let hasContent = !p.notes.isEmpty && store.readOnlyReason == nil && isOwnProject(p)
    let updatedAt = files.listProjects().first { $0.id == p.id }?.savedAt
    var published = false, dirty = false
    if let rev = marks.publishedRevision(p.id) {
        published = true
        dirty = p.revision > rev
    }
    return CurrentProjectState(id: p.id, title: p.name, published: published, dirtySincePublish: dirty,
                               hasContent: hasContent, updatedAt: updatedAt)
}

/// Create resumes the current project only when hasContent && (!published || dirtySincePublish).
func shouldResume(_ c: CurrentProjectState) -> Bool { c.hasContent && (!c.published || c.dirtySincePublish) }

/// Saved local projects with notes, newest first (the Recent list).
func recentProjects(files: ProjectFileStore = .shared, limit: Int = 8) -> [(id: String, title: String, savedAt: Double)] {
    files.listProjects()
        .filter { !$0.project.notes.isEmpty }
        .sorted { $0.savedAt > $1.savedAt }
        .prefix(limit)
        .map { (id: $0.id, title: $0.project.name, savedAt: $0.savedAt) }
}

/// Open a Recent project (checkpointing the current one first, like the web).
@discardableResult
func openRecentProject(_ id: String, into store: WorkstationStore, files: ProjectFileStore = .shared) -> Bool {
    guard let rec = files.listProjects().first(where: { $0.id == id }) else { return false }
    let q = rec.project
    let cur = store.project
    if cur.id == q.id { return true }
    if !cur.tracks.isEmpty && isOwnProject(cur) && store.readOnlyReason == nil {
        files.putProject(StoredProjectRecord(id: cur.id, schemaVersion: projectSchemaVersion, savedAt: nowMs(), project: cur))
    }
    store.load(q)
    return true
}

/// Start a blank project now (the current one is saved first).
func startNewProject(in store: WorkstationStore, autosaver: StudioAutosaver) {
    autosaver.flush(store: store)
    store.stop()
    store.load(emptyProject())
}
