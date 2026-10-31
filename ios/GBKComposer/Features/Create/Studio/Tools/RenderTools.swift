import Foundation
import CryptoKit

// Port of src/webmcp/render-tools.ts + the render job / artifact machinery of
// src/audio/render-job.ts and src/audio/artifact-store.ts. Rendering itself is the
// host's job (WorkstationHost.renderWav — the native SF2 engine, Phase 5); this layer
// owns jobs, WAV analysis/validation, and the persisted artifact store.

let maxChunkBytes = 256 * 1024
let inlineAudioMax = 4 * 1024 * 1024

struct RenderErrorT: Error, Sendable { var code: String; var message: String }

func safeFilename(_ name: String, _ ext: String) -> String {
    var s = String(name.unicodeScalars.map { scalar -> Character in
        let v = scalar.value
        let ok = (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 95 || v == 45 || v == 32 || v == 46
        return ok ? Character(scalar) : "_"
    })
    s = s.components(separatedBy: .whitespaces).filter { !$0.isEmpty }.joined(separator: "-")
    return "\(String(s.prefix(80)).isEmpty ? "gbk" : String(s.prefix(80))).\(ext)"
}

func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

// MARK: - WAV analysis

struct WavAnalysis {
    var sampleRate: Int; var channels: Int; var format: String; var frames: Int
    var durationSeconds: Double; var peak: Double; var rms: Double; var clippedSamples: Int
    var peakDbFS: Double { peak > 0 ? 20 * log10(peak) : -.infinity }
    var rmsDbFS: Double { rms > 0 ? 20 * log10(rms) : -.infinity }
}

func analyzeWav(_ data: Data) -> WavAnalysis? {
    guard data.count > 44 else { return nil }
    let b = [UInt8](data) // byte assembly only: chunk/sample offsets are not alignment-safe for load()
    func u16(_ off: Int) -> Int { Int(b[off]) | Int(b[off + 1]) << 8 }
    func u32(_ off: Int) -> Int { Int(b[off]) | Int(b[off + 1]) << 8 | Int(b[off + 2]) << 16 | Int(b[off + 3]) << 24 }
    guard b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46 else { return nil } // RIFF
    var fmt: (format: Int, channels: Int, rate: Int, bits: Int)? = nil
    var dataRange: Range<Int>? = nil
    var off = 12
    while off + 8 <= data.count {
        let id = String(bytes: data[off..<off + 4], encoding: .ascii) ?? ""
        let size = u32(off + 4)
        let body = off + 8
        if id == "fmt ", size >= 16 {
            fmt = (u16(body), u16(body + 2), u32(body + 4), u16(body + 14))
        } else if id == "data" {
            dataRange = body..<min(data.count, body + size)
        }
        off = body + size + (size % 2)
    }
    guard let f = fmt, let range = dataRange else { return nil }
    let bytesPerSample = max(1, f.bits / 8)
    let frameSize = max(1, bytesPerSample * f.channels)
    let frames = range.count / frameSize
    var peak = 0.0, sumSq = 0.0, clipped = 0, count = 0
    for i in 0..<(frames * f.channels) {
        let p = range.lowerBound + i * bytesPerSample
        let x: Double
        if f.format == 3 && f.bits == 32 {
            x = Double(Float32(bitPattern: UInt32(u32(p))))
        } else if f.format == 1 && f.bits == 16 {
            x = Double(Int16(bitPattern: UInt16(u16(p)))) / 32768.0
        } else if f.format == 1 && f.bits == 32 {
            x = Double(Int32(bitPattern: UInt32(u32(p)))) / 2147483648.0
        } else { continue }
        let ax = abs(x)
        peak = max(peak, ax); sumSq += x * x; count += 1
        if ax >= 0.9999 { clipped += 1 }
    }
    return WavAnalysis(sampleRate: f.rate, channels: f.channels,
                       format: f.format == 3 ? "float32" : "pcm16", frames: frames,
                       durationSeconds: f.rate > 0 ? Double(frames) / Double(f.rate) : 0,
                       peak: peak, rms: count > 0 ? sqrt(sumSq / Double(count)) : 0, clippedSamples: clipped)
}

// MARK: - Artifact store (Application Support/GBKStudio/Artifacts)

struct ArtifactMeta {
    var id: String; var kind: String; var filename: String; var mimeType: String; var bytes: Int
    var sha256: String; var createdAt: Double; var projectId: String; var projectName: String
    var revision: Int; var jobId: String?; var wav: JSONValue?

    var json: JSONValue {
        jsonObj([
            ("id", .string(id)), ("kind", .string(kind)), ("filename", .string(filename)), ("mimeType", .string(mimeType)),
            ("bytes", .int(Int64(bytes))), ("sha256", .string(sha256)), ("createdAt", .number(createdAt)),
            ("projectId", .string(projectId)), ("projectName", .string(projectName)), ("revision", .int(Int64(revision))),
            ("jobId", jobId.map { .string($0) }), ("wav", wav),
        ])
    }
    init(json: JSONValue) {
        id = json["id"]?.stringValue ?? ""; kind = json["kind"]?.stringValue ?? ""; filename = json["filename"]?.stringValue ?? ""
        mimeType = json["mimeType"]?.stringValue ?? ""; bytes = json["bytes"]?.intValue ?? 0
        sha256 = json["sha256"]?.stringValue ?? ""; createdAt = json["createdAt"]?.doubleValue ?? 0
        projectId = json["projectId"]?.stringValue ?? ""; projectName = json["projectName"]?.stringValue ?? ""
        revision = json["revision"]?.intValue ?? 0; jobId = json["jobId"]?.stringValue; wav = json["wav"]
    }
    init(id: String, kind: String, filename: String, mimeType: String, bytes: Int, sha256: String, createdAt: Double,
         projectId: String, projectName: String, revision: Int, jobId: String?, wav: JSONValue?) {
        self.id = id; self.kind = kind; self.filename = filename; self.mimeType = mimeType; self.bytes = bytes
        self.sha256 = sha256; self.createdAt = createdAt; self.projectId = projectId; self.projectName = projectName
        self.revision = revision; self.jobId = jobId; self.wav = wav
    }
}

final class ArtifactStore: @unchecked Sendable {
    static let shared = ArtifactStore()
    private let lock = NSLock()
    private let dir: URL
    private var metas: [ArtifactMeta] = []

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("GBKStudio/Artifacts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
           let parsed = try? JSONValue.parse(data), let arr = parsed.arrayValue {
            metas = arr.map(ArtifactMeta.init)
        }
    }

    private func persist() {
        let data = JSONValue.array(metas.map { $0.json }).data
        try? data.write(to: dir.appendingPathComponent("index.json"), options: .atomic)
    }

    @discardableResult
    func save(kind: String, filename: String, mimeType: String, sha256: String, projectId: String, projectName: String,
              revision: Int, jobId: String?, wav: JSONValue?, data: Data) throws -> ArtifactMeta {
        lock.lock(); defer { lock.unlock() }
        let meta = ArtifactMeta(id: "art_\(newStudioId("x"))", kind: kind, filename: filename, mimeType: mimeType,
                                bytes: data.count, sha256: sha256, createdAt: nowMs(), projectId: projectId,
                                projectName: projectName, revision: revision, jobId: jobId, wav: wav)
        do { try data.write(to: dir.appendingPathComponent(meta.id), options: .atomic) }
        catch { throw RenderErrorT(code: "STORAGE_UNAVAILABLE", message: "artifact was not persisted") }
        metas.append(meta); persist()
        return meta
    }

    func list() -> [ArtifactMeta] { lock.lock(); defer { lock.unlock() }; return metas.sorted { $0.createdAt > $1.createdAt } }
    func meta(_ id: String) throws -> ArtifactMeta {
        lock.lock(); defer { lock.unlock() }
        guard let m = metas.first(where: { $0.id == id }) else { throw RenderErrorT(code: "ARTIFACT_NOT_FOUND", message: "unknown artifact \(id)") }
        return m
    }
    func data(_ id: String) throws -> Data {
        _ = try meta(id)
        guard let d = try? Data(contentsOf: dir.appendingPathComponent(id)) else {
            throw RenderErrorT(code: "ARTIFACT_NOT_FOUND", message: "unknown artifact \(id)")
        }
        return d
    }
    func readRange(_ id: String, offset: Int, length: Int) throws -> (bytes: Data, offset: Int, total: Int, eof: Bool) {
        let b = try data(id)
        if offset < 0 { throw RenderErrorT(code: "INVALID_ARGUMENT", message: "offset must be a non-negative integer") }
        if length <= 0 || length > maxChunkBytes { throw RenderErrorT(code: "INVALID_ARGUMENT", message: "length must be in [1, \(maxChunkBytes)]") }
        if offset > b.count { throw RenderErrorT(code: "INVALID_ARGUMENT", message: "offset \(offset) beyond end (\(b.count))") }
        let slice = b.subdata(in: offset..<min(b.count, offset + length))
        return (slice, offset, b.count, offset + slice.count >= b.count)
    }
    func delete(_ id: String) throws {
        _ = try meta(id)
        lock.lock(); defer { lock.unlock() }
        metas.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(id))
        persist()
    }
}

// MARK: - Render jobs

struct RenderOptions {
    var sampleRate: Int = 44100; var channels: Int = 2; var format: String = "pcm16"
    var tailSeconds: Double = 3; var normalize: String = "loudness"; var targetLufs: Double? = nil
    var autoPan: Bool = false; var allowSilence: Bool = false; var silenceThresholdDbFS: Double? = nil
}

final class RenderJob: @unchecked Sendable {
    let id: String; let projectId: String; let projectName: String; let revision: Int
    let options: RenderOptions
    var status: String = "queued" // queued | rendering | validating | saving | completed | failed | cancelled
    var progress: Double = 0
    var artifactId: String? = nil
    var error: (code: String, message: String)? = nil
    var result: WavAnalysis? = nil
    var resultData: Data? = nil
    var resultSha256: String? = nil
    var renderMs: Double = 0
    var warnings: [String] = []
    var instruments: [JSONValue] = []
    var task: Task<Void, Never>? = nil
    init(id: String, project: Project, options: RenderOptions) {
        self.id = id; projectId = project.id; projectName = project.name; revision = project.revision; self.options = options
    }
    var isDone: Bool { status == "completed" || status == "failed" || status == "cancelled" }
}

final class RenderJobStore: @unchecked Sendable {
    static let shared = RenderJobStore()
    private let lock = NSLock()
    private var jobs: [String: RenderJob] = [:]

    func submit(_ store: WorkstationStore, _ project: Project, _ options: RenderOptions, saveArtifact: Bool) -> RenderJob {
        let job = RenderJob(id: "job_\(newStudioId("x"))", project: project, options: options)
        lock.lock()
        jobs[job.id] = job
        if jobs.count > 200 { // bound memory like the bridge's seen-result cap; finished jobs go first
            for (id, j) in jobs where j.isDone && jobs.count > 200 { jobs.removeValue(forKey: id) }
        }
        lock.unlock()
        job.task = Task { [weak self] in
            let started = nowMs()
            job.status = "rendering"; job.progress = 0.2
            do {
                guard let renderWav = store.host.renderWav else {
                    throw RenderErrorT(code: "UNSUPPORTED", message: "no renderer in this runtime")
                }
                let data = try await renderWav(project, options.normalize)
                if Task.isCancelled { job.status = "cancelled"; return }
                job.progress = 0.8; job.status = "validating"
                guard let analysis = analyzeWav(data) else {
                    throw RenderErrorT(code: "RENDER_FAILED", message: "renderer produced an unreadable WAV")
                }
                let threshold = options.silenceThresholdDbFS ?? -60
                if !options.allowSilence && analysis.peakDbFS < threshold {
                    throw RenderErrorT(code: "RENDER_FAILED", message: "render is silent (peak \(String(format: "%.1f", analysis.peakDbFS)) dBFS); pass allowSilence to keep it")
                }
                job.result = analysis; job.resultData = data
                job.resultSha256 = sha256Hex(data)
                job.renderMs = nowMs() - started
                job.instruments = instrumentReport(store, project)
                if saveArtifact {
                    job.status = "saving"; job.progress = 0.95
                    let meta = try ArtifactStore.shared.save(
                        kind: "wav", filename: safeFilename(project.name, "wav"), mimeType: "audio/wav",
                        sha256: job.resultSha256!, projectId: project.id, projectName: project.name,
                        revision: project.revision, jobId: job.id,
                        wav: .object([("sampleRate", .int(Int64(analysis.sampleRate))), ("channels", .int(Int64(analysis.channels))),
                                      ("format", .string(analysis.format)), ("frames", .int(Int64(analysis.frames))),
                                      ("durationSeconds", .number(analysis.durationSeconds))]),
                        data: data)
                    job.artifactId = meta.id
                }
                job.progress = 1; job.status = "completed"
            } catch let e as RenderErrorT {
                if Task.isCancelled { job.status = "cancelled" } else { job.error = (e.code, e.message); job.status = "failed" }
            } catch {
                if Task.isCancelled { job.status = "cancelled" } else { job.error = ("RENDER_FAILED", String(describing: error)); job.status = "failed" }
            }
            _ = self
        }
        return job
    }

    func get(_ id: String) throws -> RenderJob {
        lock.lock(); defer { lock.unlock() }
        guard let j = jobs[id] else { throw RenderErrorT(code: "INVALID_ARGUMENT", message: "unknown render job \(id)") }
        return j
    }

    /// Newest still-running job for a project (bridge render-progress reporting).
    func latestActive(projectId: String) -> RenderJob? {
        lock.lock(); defer { lock.unlock() }
        return jobs.values.filter { $0.projectId == projectId && !$0.isDone }.max { $0.id < $1.id }
    }

    func wait(_ id: String, timeoutMs: Double) async -> RenderJob {
        let job = try! get(id)
        let deadline = nowMs() + timeoutMs
        while !job.isDone && nowMs() < deadline && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return job
    }

    @discardableResult
    func cancel(_ id: String) throws -> Bool {
        let job = try get(id)
        if job.isDone { return false }
        job.task?.cancel()
        job.status = "cancelled"
        return true
    }
}

/// Best-effort instrument report (the TS shape) from the project + host preset names.
func instrumentReport(_ store: WorkstationStore, _ p: Project) -> [JSONValue] {
    let presets = store.host.listPresets?() ?? []
    return p.tracks.map { t in
        let prog = p.programs.first { $0.trackId == t.id }
        let bank = t.channel == 9 ? 128 : (prog?.bankMsb ?? 0)
        let preset = presets.first { $0["bank"]?.intValue == bank && $0["program"]?.intValue == (prog?.program ?? 0) }
        let pan = max(-1, min(1, Double(t.mix.pan - 64) / 63))
        let fader = pow(Double(t.mix.volume) / 100, 2)
        return jsonObj([
            ("trackId", .string(t.id)), ("trackName", .string(t.name)), ("channel", .int(Int64(t.channel))),
            ("presetName", .string(preset?["name"]?.stringValue ?? "")), ("bank", .int(Int64(bank))),
            ("program", .int(Int64(prog?.program ?? 0))), ("substituted", .bool(false)),
            ("muted", .bool(t.mix.mute)), ("pan", .number((pan * 1000).rounded() / 1000)),
            ("panSource", .string(t.mix.pan != 64 ? "mix" : "centre")), ("volume", .int(Int64(t.mix.volume))),
            ("faderDb", fader > 0 ? .number((20 * log10(fader) * 100).rounded() / 100) : .null),
            ("presetOverride", .bool(p.sound?.tracks[t.id]?.isEmpty == false)),
        ])
    }
}

func jobViewJSON(_ j: RenderJob) -> JSONValue {
    var pairs: [(String, JSONValue?)] = [
        ("jobId", .string(j.id)), ("projectId", .string(j.projectId)), ("revision", .int(Int64(j.revision))),
        ("status", .string(j.status)), ("progress", .int(Int64((j.progress * 100).rounded()))),
        ("artifactId", j.artifactId.map { .string($0) } ?? .null),
        ("error", j.error.map { .object([("code", .string($0.code)), ("message", .string($0.message))]) } ?? .null),
    ]
    if let r = j.result, let data = j.resultData {
        pairs += [
            ("filename", .string(safeFilename(j.projectName, "wav"))),
            ("durationSeconds", jsonFixed3(r.durationSeconds)),
            ("musicSeconds", jsonFixed3(max(0, r.durationSeconds - j.options.tailSeconds))),
            ("tailSeconds", .number(j.options.tailSeconds)),
            ("sampleRate", .int(Int64(r.sampleRate))), ("channels", .int(Int64(r.channels))), ("format", .string(r.format)),
            ("frames", .int(Int64(r.frames))), ("bytes", .int(Int64(data.count))),
            ("sha256", .string(j.resultSha256 ?? "")),
            ("peakDbFS", r.peakDbFS.isFinite ? .number(r.peakDbFS) : nil),
            ("rmsDbFS", r.rmsDbFS.isFinite ? .number(r.rmsDbFS) : nil),
            ("clippedSamples", .int(Int64(r.clippedSamples))), ("validated", .bool(true)),
            ("instruments", .array(j.instruments)), ("soundFont", .string("")),
            ("renderMs", .number(j.renderMs)), ("loudness", nil), ("warnings", .array(j.warnings.map { .string($0) })),
        ]
    }
    return jsonObj(pairs)
}

func artifactViewJSON(_ m: ArtifactMeta) -> JSONValue {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    fmt.timeZone = TimeZone(secondsFromGMT: 0)
    return jsonObj([
        ("artifactId", .string(m.id)), ("kind", .string(m.kind)), ("filename", .string(m.filename)),
        ("mimeType", .string(m.mimeType)), ("bytes", .int(Int64(m.bytes))), ("sha256", .string(m.sha256)),
        ("createdAt", .string(fmt.string(from: Date(timeIntervalSince1970: m.createdAt / 1000)))),
        ("projectId", .string(m.projectId)), ("projectName", .string(m.projectName)),
        ("revision", .int(Int64(m.revision))), ("jobId", m.jobId.map { .string($0) } ?? .null), ("wav", m.wav),
    ])
}

// MARK: - Tools

func buildRenderTools(_ store: WorkstationStore) -> [GBKTool] {
    func toolError(_ e: RenderErrorT) -> ToolArgError { ToolArgError(e.code, e.message) }
    return [
        GBKTool(name: "gbk_render_wav", description: "Render the committed project to a validated WAV with the SF2 engine, fully headless (no click, no audio unlock, no Player, no pre-loaded SoundFont; GeneralUser GS loads automatically). Snapshot semantics: later edits do not affect the render. output: artifact (default; saved in browser storage, read bytes with gbk_read_wav_bytes), audio (MCP audio content when small and supported, else artifact reference), bytes (inline base64 only if <= 256 KiB, else artifact reference). download defaults to false and never happens unless true. Returns ok only after render + validation; if it takes longer than waitSeconds you get a real jobId to poll with gbk_get_render_status.", inputSchema: schemaObj([
            ("sampleRate", .object([("type", .string("integer")), ("enum", .array([.int(44100), .int(48000)]))])),
            ("channels", .object([("type", .string("integer")), ("enum", .array([.int(1), .int(2)]))])),
            ("format", schemaEnum(["pcm16", "float32"])),
            ("tailSeconds", schemaNum(0, 30)),
            ("normalize", .object([
                ("anyOf", .array([
                    schemaEnum(["loudness", "peak", "off"]),
                    .object([("type", .string("boolean"))]),
                ])),
                ("description", .string("whole-file level (true = peak, false = off), one gain for the entire file (dynamics preserved): loudness (default) = -16 LUFS integrated capped at -1 dBTP; peak = -1 dBTP; off = raw engine output")),
            ])),
            ("targetLufs", schemaNum(-40, -5, "integrated loudness target for normalize=loudness (default -16)")),
            ("autoPan", schemaBool("orchestra-seating auto-pan, only for tracks without an explicit pan (mix pan or CC10); default false")),
            ("saveArtifact", schemaBool()), ("download", schemaBool()),
            ("output", schemaEnum(["artifact", "audio", "bytes"])),
            ("waitSeconds", schemaNum(0, 600, "how long this call waits for completion (default 300)")),
            ("allowSilence", schemaBool()),
            ("silenceThresholdDbFS", schemaNum(-140, 0)),
            ("includeMidi", schemaBool("also save the MIDI export as an artifact (default true)")),
        ]), readOnly: false) { a in
            let p = store.project
            let output = a.argStr("output") ?? "artifact"
            let save = output == "bytes" ? (a.argBool("saveArtifact") ?? true) : true
            let normalizeMode: String
            if let b = a.argBool("normalize") { normalizeMode = b ? "peak" : "off" }
            else { normalizeMode = a.argStr("normalize") ?? "loudness" }
            let options = RenderOptions(sampleRate: a.argInt("sampleRate") ?? 44100, channels: a.argInt("channels") ?? 2,
                                        format: a.argStr("format") ?? "pcm16", tailSeconds: a.argDbl("tailSeconds") ?? 3,
                                        normalize: normalizeMode, targetLufs: a.argDbl("targetLufs"),
                                        autoPan: a.argBool("autoPan") ?? false, allowSilence: a.argBool("allowSilence") ?? false,
                                        silenceThresholdDbFS: a.argDbl("silenceThresholdDbFS"))
            let job = RenderJobStore.shared.submit(store, p, options, saveArtifact: save)
            var midiArtifactId: String? = nil
            var warnings: [String] = []
            if a.argBool("includeMidi") != false {
                do {
                    let (bytes, filename) = store.prepareMidiExport()
                    midiArtifactId = try ArtifactStore.shared.save(kind: "midi", filename: filename, mimeType: "audio/midi",
                                                                   sha256: sha256Hex(bytes), projectId: p.id, projectName: p.name,
                                                                   revision: p.revision, jobId: nil, wav: nil, data: bytes).id
                } catch { warnings.append("MIDI artifact not saved: \(String(describing: error))") }
            }
            let j = await RenderJobStore.shared.wait(job.id, timeoutMs: (a.argDbl("waitSeconds") ?? 300) * 1000)
            if Task.isCancelled {
                _ = try? RenderJobStore.shared.cancel(job.id)
                throw ToolArgError("OPERATION_CANCELLED", "render cancelled")
            }
            if j.status == "failed" || j.status == "cancelled" {
                throw ToolArgError(j.error?.code ?? "INTERNAL_ERROR", j.error?.message ?? "render \(j.status)",
                                   details: .object([("jobId", .string(j.id))]))
            }
            if j.status != "completed" {
                var data = jobViewJSON(j)
                if case .object(var pairs) = data {
                    pairs.append(("midiArtifactId", midiArtifactId.map { .string($0) } ?? .null))
                    pairs.append(("next", .string("Render still running: poll gbk_get_render_status with this jobId.")))
                    data = .object(pairs)
                }
                return ToolRunOut(data: data, warnings: warnings)
            }
            warnings.append(contentsOf: j.warnings)
            var downloaded: JSONValue? = nil
            if a.argBool("download") == true {
                if let data = j.resultData, let download = store.host.download {
                    let ok = download(data, safeFilename(j.projectName, "wav"))
                    downloaded = .object([("requested", .bool(ok)), ("confirmed", .bool(false)),
                                          ("note", .string("browsers do not report whether a download was allowed; the artifact stays available either way"))])
                } else {
                    downloaded = .object([("requested", .bool(false)), ("reason", .string("no browser download handler"))])
                }
            }
            var viewPairs: [(String, JSONValue?)] = []
            if case .object(let vp) = jobViewJSON(j) { viewPairs = vp.map { ($0.0, $0.1 as JSONValue?) } }
            viewPairs.append(("midiArtifactId", midiArtifactId.map { .string($0) } ?? .null))
            let resData = j.resultData
            if output == "audio" {
                if let resData, resData.count <= inlineAudioMax {
                    viewPairs.append(("output", .string("audio"))); viewPairs.append(("downloaded", downloaded))
                    return ToolRunOut(data: jsonObj(viewPairs), warnings: warnings,
                                      content: [ToolContent(type: "audio", mimeType: "audio/wav", data: resData.base64EncodedString())])
                }
                viewPairs.append(("output", .string("artifact"))); viewPairs.append(("downloaded", downloaded))
                viewPairs.append(("audioInline", .bool(false)))
                viewPairs.append(("reason", .string("WAV is \(j.resultData?.count ?? 0) bytes, over the \(inlineAudioMax)-byte inline audio limit; read it with gbk_read_wav_bytes")))
                return ToolRunOut(data: jsonObj(viewPairs), warnings: warnings)
            }
            if output == "bytes" {
                if let resData, resData.count <= maxChunkBytes {
                    viewPairs.append(("output", .string("bytes"))); viewPairs.append(("downloaded", downloaded))
                    viewPairs.append(("encoding", .string("base64"))); viewPairs.append(("base64", .string(resData.base64EncodedString())))
                    return ToolRunOut(data: jsonObj(viewPairs), warnings: warnings)
                }
                viewPairs.append(("output", .string("artifact"))); viewPairs.append(("downloaded", downloaded))
                viewPairs.append(("bytesInline", .bool(false)))
                viewPairs.append(("reason", .string("WAV is \(j.resultData?.count ?? 0) bytes (> \(maxChunkBytes)); read it in chunks with gbk_read_wav_bytes (offset/length) and verify sha256")))
                return ToolRunOut(data: jsonObj(viewPairs), warnings: warnings)
            }
            viewPairs.append(("output", .string("artifact"))); viewPairs.append(("downloaded", downloaded))
            viewPairs.append(("read", .object([("tool", .string("gbk_read_wav_bytes")), ("maxChunkBytes", .int(Int64(maxChunkBytes)))])))
            return ToolRunOut(data: jsonObj(viewPairs), warnings: warnings)
        },
        GBKTool(name: "gbk_get_render_status", description: "Status of a render job (queued, loading, rendering, encoding, validating, saving, completed, failed, cancelled), progress %, errors and artifact id. Jobs live in this page only (not durable across reloads; artifacts are).", inputSchema: schemaObj([("jobId", schemaStr())], required: ["jobId"]), readOnly: true) { a in
            do { return ToolRunOut(data: jobViewJSON(try RenderJobStore.shared.get(a.argStr("jobId")!))) }
            catch let e as RenderErrorT { throw toolError(e) }
        },
        GBKTool(name: "gbk_cancel_render", description: "Cancel a queued or running render job (no partial artifact is saved).", inputSchema: schemaObj([("jobId", schemaStr())], required: ["jobId"]), readOnly: false) { a in
            do { return ToolRunOut(data: .object([("cancelled", .bool(try RenderJobStore.shared.cancel(a.argStr("jobId")!)))])) }
            catch let e as RenderErrorT { throw toolError(e) }
        },
        GBKTool(name: "gbk_list_render_artifacts", description: "Saved WAV / MIDI artifacts (persisted in browser storage) with metadata, timestamps and project ids, newest first.", inputSchema: schemaObj([
            ("projectId", schemaStr()), ("kind", schemaEnum(["wav", "midi"])), ("limit", schemaInt(1, 200)),
        ]), readOnly: true) { a in
            let all = ArtifactStore.shared.list().filter {
                (a.argStr("projectId") == nil || $0.projectId == a.argStr("projectId")) && (a.argStr("kind") == nil || $0.kind == a.argStr("kind"))
            }
            return ToolRunOut(data: .object([
                ("total", .int(Int64(all.count))),
                ("artifacts", .array(all.prefix(a.argInt("limit") ?? 50).map(artifactViewJSON))),
            ]))
        },
        GBKTool(name: "gbk_get_render_artifact", description: "Metadata of one artifact plus a same-origin object URL usable inside this page, and how to transfer the bytes (gbk_read_wav_bytes). Never returns the audio itself.", inputSchema: schemaObj([("artifactId", schemaStr())], required: ["artifactId"]), readOnly: true) { a in
            do {
                let m = try ArtifactStore.shared.meta(a.argStr("artifactId")!)
                var data = artifactViewJSON(m)
                if case .object(var pairs) = data {
                    pairs.append(("objectUrl", .null))
                    pairs.append(("objectUrlScope", .string("same-origin, this page only; not reachable from other processes")))
                    pairs.append(("read", .object([("tool", .string("gbk_read_wav_bytes")), ("maxChunkBytes", .int(Int64(maxChunkBytes))),
                                                    ("chunks", .int(Int64(Int(ceil(Double(m.bytes) / Double(maxChunkBytes))))))])))
                    data = .object(pairs)
                }
                return ToolRunOut(data: data)
            } catch let e as RenderErrorT { throw toolError(e) }
        },
        GBKTool(name: "gbk_read_wav_bytes", description: "Bounded byte transfer of a saved artifact: base64 of [offset, offset+length) with length <= \(maxChunkBytes). Repeat with nextOffset until eof, concatenate, and compare SHA-256 with the artifact's sha256. Never truncates silently: returned length is exact except at end of file.", inputSchema: schemaObj([
            ("artifactId", schemaStr()),
            ("offset", schemaInt(0, 9007199254740991)), ("length", schemaInt(1, Int64(maxChunkBytes))),
        ], required: ["artifactId"]), readOnly: true) { a in
            do {
                let m = try ArtifactStore.shared.meta(a.argStr("artifactId")!)
                let r = try ArtifactStore.shared.readRange(m.id, offset: a.argInt("offset") ?? 0, length: a.argInt("length") ?? maxChunkBytes)
                return ToolRunOut(data: .object([
                    ("artifactId", .string(m.id)), ("offset", .int(Int64(r.offset))), ("length", .int(Int64(r.bytes.count))),
                    ("total", .int(Int64(r.total))), ("eof", .bool(r.eof)),
                    ("nextOffset", r.eof ? .null : .int(Int64(r.offset + r.bytes.count))),
                    ("sha256", .string(m.sha256)), ("mimeType", .string(m.mimeType)),
                    ("encoding", .string("base64")), ("base64", .string(r.bytes.base64EncodedString())),
                ]))
            } catch let e as RenderErrorT { throw toolError(e) }
        },
        GBKTool(name: "gbk_download_render_artifact", description: "Start a browser download of a saved artifact. Reports requested=true when the download was initiated; browsers do not confirm whether it was allowed, so this never claims the file reached disk. The artifact stays in the workstation's artifact panel either way.", inputSchema: schemaObj([("artifactId", schemaStr())], required: ["artifactId"]), readOnly: false) { a in
            do {
                let m = try ArtifactStore.shared.meta(a.argStr("artifactId")!)
                let b = try ArtifactStore.shared.data(m.id)
                guard let download = store.host.download else {
                    throw ToolArgError("DOWNLOAD_BLOCKED", "no download mechanism in this runtime; use gbk_read_wav_bytes")
                }
                if download(b, m.filename) == false {
                    throw ToolArgError("DOWNLOAD_BLOCKED", "the browser refused to start the download; use the artifact panel link or gbk_read_wav_bytes")
                }
                return ToolRunOut(data: .object([("artifactId", .string(m.id)), ("filename", .string(m.filename)),
                                                ("requested", .bool(true)), ("confirmed", .bool(false))]))
            } catch let e as RenderErrorT { throw toolError(e) }
        },
        GBKTool(name: "gbk_delete_render_artifact", description: "Delete a saved artifact from browser storage.", inputSchema: schemaObj([("artifactId", schemaStr())], required: ["artifactId"]), readOnly: false) { a in
            do {
                try ArtifactStore.shared.delete(a.argStr("artifactId")!)
                return ToolRunOut(data: .object([("deleted", .string(a.argStr("artifactId")!))]))
            } catch let e as RenderErrorT { throw toolError(e) }
        },
    ]
}
