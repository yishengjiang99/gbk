import Foundation

// Port of src/agent/browser-bridge.ts (BrowserToolBridge): executes ONE gbk_* tool per server
// request through the native registry + runTool — same dedupe, policy, consent, project-binding,
// deadline and result-size semantics as the browser bridge. Plus the server-issued MCP render
// job (gbk_mcp_render_job), which renders a stored snapshot and uploads the WAV.

let mcpRenderTool = "gbk_mcp_render_job"
private let maxFrameBytes = 512 * 1024

final class ToolExecutor: @unchecked Sendable {
    let store: WorkstationStore
    let toolsByName: [String: GBKTool]
    let manifest: ComposerManifest
    private var seen: [String: Task<JSONValue, Never>] = [:]
    private var seenOrder: [String] = []
    private var inflight: [String: Task<JSONValue, Never>] = [:]
    private var mutationTail: Task<JSONValue, Never>? = nil
    private(set) var boundProjectId: String? = nil
    private let lock = NSLock()

    init(store: WorkstationStore) {
        self.store = store
        let tools = buildAllTools(store)
        toolsByName = Dictionary(uniqueKeysWithValues: tools.map { ($0.name, $0) })
        manifest = composerManifest(tools)
    }

    var busyCount: Int { lock.lock(); defer { lock.unlock() }; return inflight.count }

    private func fail(_ code: String, _ message: String, revision: Int? = nil) -> JSONValue {
        .object([
            ("ok", .bool(false)), ("projectId", .string(store.project.id)),
            ("revision", .int(Int64(revision ?? store.project.revision))),
            ("warnings", .array([])),
            ("error", .object([("code", .string(code)), ("message", .string(message))])),
        ])
    }

    /// A stored result for a duplicate tool_call (never re-executed), if this call was seen before.
    func seenResult(_ key: String) async -> JSONValue? {
        lock.lock(); let t = seen[key]; lock.unlock()
        return await t?.value
    }

    /// Execute a server tool_call. Returns the task producing the envelope to send back.
    func execute(sessionId msgSessionId: String, currentSessionId: String, runId: String, callId: String, tool name: String,
                 arguments: JSONValue, expectProjectId: String?, consentNewProject: Bool, deadlineMs: Int,
                 onProgress: (@Sendable (Double, String?) -> Void)?) -> Task<JSONValue, Never> {
        let key = "\(runId):\(callId)"
        lock.lock()
        if let dup = seen[key] { lock.unlock(); return dup }
        lock.unlock()
        let task = run(msgSessionId: msgSessionId, currentSessionId: currentSessionId, runId: runId, callId: callId, tool: name,
                       arguments: arguments, expectProjectId: expectProjectId, consentNewProject: consentNewProject,
                       deadlineMs: deadlineMs, onProgress: onProgress)
        lock.lock()
        seen[key] = task; seenOrder.append(key)
        if seen.count > 500, let oldest = seenOrder.first { seenOrder.removeFirst(); seen.removeValue(forKey: oldest) }
        lock.unlock()
        return task
    }

    private func run(msgSessionId: String, currentSessionId: String, runId: String, callId: String, tool name: String,
                     arguments: JSONValue, expectProjectId: String?, consentNewProject: Bool, deadlineMs: Int,
                     onProgress: (@Sendable (Double, String?) -> Void)?) -> Task<JSONValue, Never> {
        if msgSessionId != currentSessionId {
            return Task { self.fail("SESSION_MISMATCH", "tool call for another session") }
        }
        if name == mcpRenderTool {
            let t = Task { await self.mcpRender(arguments: arguments, callId: callId, deadlineMs: deadlineMs) }
            lock.lock(); inflight[callId] = t; lock.unlock()
            return t
        }
        guard let pol = policyFor(name), let tool = toolsByName[name] else {
            return Task { self.fail("TOOL_NOT_ALLOWED", "\(name) is not available to the Composer agent") }
        }
        if pol.createsProject && !consentNewProject {
            return Task { self.fail("CONSENT_REQUIRED", "creating a project needs a user prompt in this conversation") }
        }
        var argsPairs = arguments.objectValue ?? []
        if let force = pol.force?.objectValue {
            for (k, v) in force {
                if let i = argsPairs.firstIndex(where: { $0.0 == k }) { argsPairs[i].1 = v } else { argsPairs.append((k, v)) }
            }
        }
        let args = JSONValue.object(argsPairs)
        let exec: @Sendable () async -> JSONValue = {
            if let expect = expectProjectId, self.store.project.id != expect, !pol.createsProject {
                return self.fail("PROJECT_CHANGED", "the open project changed (expected \(expect), now \(self.store.project.id)); re-read the project before editing")
            }
            let toolTask = Task { await runTool(self.store, tool, args) }
            self.lock.lock(); self.inflight[callId] = toolTask; self.lock.unlock()
            defer { self.lock.lock(); self.inflight.removeValue(forKey: callId); self.lock.unlock() }
            let deadline = max(1000, (deadlineMs == 0 ? 120_000 : deadlineMs) - (pol.cls == "render" ? 5000 : 0))
            var progressTask: Task<Void, Never>? = nil
            if pol.cls == "render", let onProgress {
                progressTask = Task {
                    var last = "rendering"; var lastSent = -2.0; var ticks = 0
                    while !Task.isCancelled {
                        ticks += 1
                        if let job = RenderJobStore.shared.latestActive(projectId: self.store.project.id) {
                            last = "\(job.status) \(Int((job.progress * 100).rounded()))%"
                            if job.progress != lastSent { lastSent = job.progress; onProgress(job.progress, last) }
                        }
                        if ticks % 5 == 0 { onProgress(-1, last) } // heartbeat while nothing changes
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    }
                }
            }
            defer { progressTask?.cancel() }
            let timedOut = FlagBox()
            let watchdog = Task { try? await Task.sleep(nanoseconds: UInt64(deadline) * 1_000_000); if !toolTask.isCancelled { timedOut.value = true; toolTask.cancel() } }
            let r = await toolTask.value
            watchdog.cancel()
            let ok = r["ok"]?.boolValue == true
            if !ok && timedOut.value {
                let code = pol.cls == "render" ? "RENDER_TIMEOUT" : "TOOL_TIMEOUT"
                let suffix = pol.cls == "render" ? " (the render runs on this device; try a shorter range or mono)" : ""
                return self.fail(code, "\(name) did not finish within \(deadline / 1000) s on this device and was cancelled\(suffix)",
                                 revision: r["revision"]?.intValue)
            }
            if ok && pol.createsProject { self.boundProjectId = r["projectId"]?.stringValue }
            var env = r
            if case .object(var pairs) = env, pairs.contains(where: { $0.0 == "content" }) {
                pairs.removeAll { $0.0 == "content" } // binary content never leaves the device through the bridge
                env = .object(pairs)
            }
            let size = env.serialized.utf16.count
            if size > maxFrameBytes - 4096 {
                return self.fail("RESULT_TOO_LARGE", "result is \(size) bytes; use pagination (offset/limit) or a narrower range",
                                 revision: r["revision"]?.intValue)
            }
            return env
        }
        if pol.cls == "read" {
            return Task { await exec() }
        }
        // one mutation sequence per project: serialize all mutations
        lock.lock()
        let prev = mutationTail
        let chained = Task<JSONValue, Never> { _ = await prev?.value; return await exec() }
        mutationTail = chained
        lock.unlock()
        return chained
    }

    func cancel(_ callId: String? = nil) {
        lock.lock()
        if let callId { inflight[callId]?.cancel() }
        else { for t in inflight.values { t.cancel() } }
        lock.unlock()
    }

    // MARK: - Server-issued MCP render job (snapshot render + chunked upload; never touches the open project)

    private func mcpRender(arguments: JSONValue, callId: String, deadlineMs: Int) async -> JSONValue {
        let a = arguments
        guard let jobId = a.argStr("jobId"), let token = a.argStr("token"),
              let snapshotUrl = a.argStr("snapshotUrl"), let uploadUrl = a.argStr("uploadUrl"),
              a.argObj("options") != nil,
              BridgeHTTP.sameOrigin(snapshotUrl), BridgeHTTP.sameOrigin(uploadUrl) else {
            return fail("INVALID_ARGUMENT", "malformed render job")
        }
        let work = Task<JSONValue, Never> {
            let started = nowMs()
            do {
                var snapReq = URLRequest(url: URL(string: snapshotUrl)!)
                snapReq.setValue(token, forHTTPHeaderField: "x-gbk-render-token")
                let (snapData, snapResp) = try await BridgeHTTP.session.data(for: snapReq)
                let status = (snapResp as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else { return self.fail("NOT_FOUND", "render snapshot unavailable (HTTP \(status))") }
                guard let snapJSON = try? JSONValue.parse(snapData), let projectJSON = snapJSON["project"],
                      let project = migrateProject(projectJSON) else {
                    return self.fail("NOT_FOUND", "render snapshot unavailable (HTTP \(status))")
                }
                guard let renderWav = self.store.host.renderWav else {
                    return self.fail("UNSUPPORTED", "no renderer in this runtime")
                }
                let normalize = a.argObj("options")?.argStr("normalize") ?? "loudness"
                let data = try await renderWav(project, normalize)
                guard let analysis = analyzeWav(data) else { return self.fail("RENDER_FAILED", "renderer produced an unreadable WAV") }
                let step = max(64 * 1024, min(a.argInt("chunkBytes") ?? (8 << 20), 8 << 20))
                var off = 0
                while off < data.count {
                    try Task.checkCancellation()
                    let part = data.subdata(in: off..<min(off + step, data.count))
                    var upReq = URLRequest(url: URL(string: "\(uploadUrl)?offset=\(off)")!)
                    upReq.httpMethod = "PUT"
                    upReq.setValue(token, forHTTPHeaderField: "x-gbk-render-token")
                    upReq.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
                    upReq.httpBody = part
                    let (_, upResp) = try await BridgeHTTP.session.data(for: upReq)
                    let upStatus = (upResp as? HTTPURLResponse)?.statusCode ?? 0
                    guard (200..<300).contains(upStatus) else { return self.fail("RENDER_FAILED", "upload failed at byte \(off) (HTTP \(upStatus))") }
                    off += step
                }
                let meta: JSONValue = .object([
                    ("sha256", .string(sha256Hex(data))), ("durationSeconds", .number(analysis.durationSeconds)),
                    ("musicSeconds", .number(analysis.durationSeconds)), ("tailSeconds", .int(0)),
                    ("sampleRate", .int(Int64(analysis.sampleRate))), ("channels", .int(Int64(analysis.channels))),
                    ("format", .string(analysis.format)), ("framesRendered", .int(Int64(analysis.frames))),
                    ("byteLength", .int(Int64(data.count))),
                    ("peakDbFS", analysis.peakDbFS.isFinite ? .number(analysis.peakDbFS) : .null),
                    ("rmsDbFS", analysis.rmsDbFS.isFinite ? .number(analysis.rmsDbFS) : .null),
                    ("clippedSamples", .int(Int64(analysis.clippedSamples))), ("gain", .int(1)), ("validated", .bool(true)),
                    ("loudness", .null), ("instruments", .array(instrumentReport(self.store, project))),
                    ("warnings", .array([])), ("soundFont", .string("")), ("noteCount", .int(Int64(project.notes.count))),
                    ("renderMs", .number(nowMs() - started)),
                ])
                _ = jobId
                return .object([("ok", .bool(true)), ("projectId", .string(self.store.project.id)),
                                ("revision", .int(Int64(self.store.project.revision))),
                                ("data", meta), ("warnings", .array([]))])
            } catch is CancellationError {
                return self.fail("RENDER_TIMEOUT", "render job cancelled or timed out")
            } catch {
                return self.fail("RENDER_FAILED", String(describing: error))
            }
        }
        let watchdog = Task { try? await Task.sleep(nanoseconds: UInt64(max(1000, deadlineMs == 0 ? 300_000 : deadlineMs)) * 1_000_000); work.cancel() }
        let result = await work.value
        watchdog.cancel()
        lock.lock(); inflight.removeValue(forKey: callId); lock.unlock()
        return result
    }
}

final class FlagBox: @unchecked Sendable { var value = false }

/// Shared HTTP session for bridge-adjacent calls (web-code redeem, MCP render fetches/uploads):
/// default configuration, so the gbk_cs session cookie lands in the shared cookie storage the
/// WebSocket upgrade then presents.
enum BridgeHTTP {
    static let session = URLSession(configuration: .default)
    static var baseURL: URL { APIClient.defaultBaseURL }
    static func sameOrigin(_ urlString: String) -> Bool {
        guard let u = URL(string: urlString) else { return false }
        return u.host == baseURL.host && (u.scheme == "https" || u.scheme == baseURL.scheme)
    }
}
