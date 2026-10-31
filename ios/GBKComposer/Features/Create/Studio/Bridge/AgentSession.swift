import Foundation
import Combine

// Port of src/agent/useAgentSession.ts: conversation state for the native Studio chat.
// Music state is NOT copied here — WorkstationStore stays the single source of truth;
// this object tracks only the conversation, tool activity, usage and artifacts.

struct ArtifactRef: Equatable, Sendable {
    var artifactId: String
    var kind: String
    var filename: String? = nil
    var bytes: Int? = nil
    var durationSeconds: Double? = nil
    var sha256: String? = nil
    var mimeType: String? = nil

    init(_ v: JSONValue) {
        artifactId = v["artifactId"]?.stringValue ?? ""
        kind = v["kind"]?.stringValue ?? ""
        filename = v["filename"]?.stringValue
        bytes = v["bytes"]?.intValue
        durationSeconds = v["durationSeconds"]?.doubleValue
        sha256 = v["sha256"]?.stringValue
        mimeType = v["mimeType"]?.stringValue
    }
}

struct ToolStep: Equatable, Sendable {
    var callId: String
    var tool: String
    var task: String
    var status: String // pending | running | done | failed
    var summary: String? = nil
    var error: String? = nil
    var progress: String? = nil
}

struct ChatItem: Equatable, Sendable {
    var id: String
    var role: String // user | assistant | error
    var text: String
    var artifacts: [ArtifactRef]? = nil
    var steps: [ToolStep]? = nil
    var runId: String? = nil
    var retryText: String? = nil
}

struct AgentRunState: Equatable, Sendable {
    var runId: String
    var task: String
    var step: Int
    var maxSteps: Int
}

struct UsageInfo: Equatable, Sendable {
    var promptTokens: Int
    var completionTokens: Int
    var totalTokens: Int
    var costUsd: Double
    var dayTokens: Int
    var dayCostUsd: Double

    init(_ v: JSONValue) {
        promptTokens = v["promptTokens"]?.intValue ?? 0
        completionTokens = v["completionTokens"]?.intValue ?? 0
        totalTokens = v["totalTokens"]?.intValue ?? 0
        costUsd = v["costUsd"]?.doubleValue ?? 0
        dayTokens = v["dayTokens"]?.intValue ?? 0
        dayCostUsd = v["dayCostUsd"]?.doubleValue ?? 0
    }
}

struct SessionInfo: Equatable, Sendable {
    var model: String
    var models: [String]
    var provider: String
    var llmConfigured: Bool
    var rejectedTools: [String]
}

final class AgentSession: ObservableObject {
    let client: BridgeClient
    var store: WorkstationStore { client.store }

    @Published private(set) var items: [ChatItem] = []
    @Published private(set) var run: AgentRunState? = nil
    @Published private(set) var usage: UsageInfo? = nil
    @Published private(set) var info: SessionInfo? = nil
    @Published var model: String = ""
    @Published private(set) var connState: ConnState = .idle
    @Published private(set) var connDetail: String? = nil

    /// Native equivalents of the web's gbk:run-completed / gbk:run-failed window events.
    var onRunCompleted: ((_ runId: String, _ steps: Int) -> Void)? = nil
    var onRunFailed: ((_ runId: String, _ code: String, _ message: String) -> Void)? = nil

    private var pendingReset = false
    private var cancellables: Set<AnyCancellable> = []

    init(store: WorkstationStore) {
        client = BridgeClient(store: store)
        client.onEvent = { [weak self] frame in
            DispatchQueue.main.async { self?.handleEvent(frame) }
        }
        client.$connState.receive(on: DispatchQueue.main).sink { [weak self] in self?.connState = $0 }.store(in: &cancellables)
        client.$connDetail.receive(on: DispatchQueue.main).sink { [weak self] in self?.connDetail = $0 }.store(in: &cancellables)
    }

    /// Connect when signed in (the web hook creates the client only once authenticated).
    func start() {
        guard AuthStore.currentAccessToken() != nil else { return }
        client.connect()
        // A reset requested before this client existed is queued by the bridge ahead of
        // hello, so the session it opens already starts from the fresh conversation.
        if pendingReset, client.sendFrame(.object([("type", .string("reset_conversation"))])) { pendingReset = false }
    }

    /// App-foreground hook.
    func resume() { client.resume() }

    // MARK: - Event state machine (port of the hook's onEvent switch)

    func handleEvent(_ m: JSONValue) {
        switch m["type"]?.stringValue {
        case "session_ready":
            info = SessionInfo(
                model: m["model"]?.stringValue ?? "",
                models: m["models"]?.arrayValue?.compactMap { $0.stringValue } ?? [],
                provider: m["provider"]?.stringValue ?? "",
                llmConfigured: m["llmConfigured"]?.boolValue ?? false,
                rejectedTools: m["rejectedTools"]?.arrayValue?.compactMap { $0.stringValue } ?? [])
            if model.isEmpty { model = info?.model ?? "" }
            if pendingReset {
                // This frame's history predates an undelivered reset: deliver the reset now
                // (the socket is live) and keep the chat empty instead of adopting it.
                pendingReset = false
                _ = client.sendFrame(.object([("type", .string("reset_conversation"))]))
                break
            }
            if items.isEmpty {
                let history = m["history"]?.arrayValue ?? []
                items = history.enumerated().map { i, h in
                    ChatItem(id: "h\(i)", role: h["role"]?.stringValue ?? "assistant",
                             text: h["text"]?.stringValue ?? "",
                             artifacts: h["artifacts"]?.arrayValue?.map { ArtifactRef($0) })
                }
            }
        case "run_started":
            guard let runId = m["runId"]?.stringValue else { break }
            run = AgentRunState(runId: runId, task: "Thinking", step: 0, maxSteps: 0)
            patchLastAssistant(runId) { $0 }
        case "assistant_delta":
            guard let runId = m["runId"]?.stringValue else { break }
            let text = m["text"]?.stringValue ?? ""
            patchLastAssistant(runId) { var x = $0; x.text += text; return x }
        case "assistant_message":
            guard let runId = m["runId"]?.stringValue else { break }
            let text = m["text"]?.stringValue ?? ""
            patchLastAssistant(runId) { var x = $0; x.text = text; return x }
        case "tool_intent":
            guard let runId = m["runId"]?.stringValue, let callId = m["callId"]?.stringValue else { break }
            let step = ToolStep(callId: callId, tool: m["tool"]?.stringValue ?? "", task: m["task"]?.stringValue ?? "", status: "pending")
            patchLastAssistant(runId) { var x = $0; x.steps = (x.steps ?? []) + [step]; return x }
            if run != nil { run?.task = m["task"]?.stringValue ?? run?.task ?? "" }
        case "tool_started":
            guard let runId = m["runId"]?.stringValue, let callId = m["callId"]?.stringValue else { break }
            patchLastAssistant(runId) { var x = $0; x.steps = (x.steps ?? []).map { var s = $0; if s.callId == callId { s.status = "running" }; return s }; return x }
        case "tool_progress":
            guard let runId = m["runId"]?.stringValue, let callId = m["callId"]?.stringValue else { break }
            let detail = m["detail"]?.stringValue
            patchLastAssistant(runId) { var x = $0; x.steps = (x.steps ?? []).map { var s = $0; if s.callId == callId { s.progress = detail }; return s }; return x }
        case "tool_completed":
            guard let runId = m["runId"]?.stringValue, let callId = m["callId"]?.stringValue else { break }
            let ok = m["ok"]?.boolValue ?? false
            let summary = m["summary"]?.stringValue
            let errObj = m["error"]
            let errText: String? = errObj?.objectValue != nil ? friendlyError(errObj?["code"]?.stringValue, errObj?["message"]?.stringValue) : nil
            let artifact: ArtifactRef? = m["artifact"]?.objectValue != nil ? ArtifactRef(m["artifact"]!) : nil
            patchLastAssistant(runId) { var x = $0
                x.steps = (x.steps ?? []).map { var s = $0; if s.callId == callId { s.status = ok ? "done" : "failed"; s.summary = summary; s.error = errText }; return s }
                if let artifact { x.artifacts = (x.artifacts ?? []) + [artifact] }
                return x }
        case "progress":
            if run != nil {
                run?.step = m["step"]?.intValue ?? 0
                run?.maxSteps = m["maxSteps"]?.intValue ?? 0
                run?.task = m["task"]?.stringValue ?? run?.task ?? ""
            }
        case "usage":
            if let u = m["usage"], u.objectValue != nil { usage = UsageInfo(u) }
        case "run_completed":
            guard let runId = m["runId"]?.stringValue else { break }
            run = nil
            let text = m["text"]?.stringValue ?? ""
            let newArtifacts = (m["artifacts"]?.arrayValue ?? []).map { ArtifactRef($0) }
            patchLastAssistant(runId) { var x = $0
                if !text.isEmpty { x.text = text }
                if !newArtifacts.isEmpty { x.artifacts = Self.dedupeArtifacts((x.artifacts ?? []) + newArtifacts) }
                return x }
            onRunCompleted?(runId, m["steps"]?.intValue ?? 0)
        case "run_failed":
            guard let runId = m["runId"]?.stringValue else { break }
            run = nil
            let code = m["code"]?.stringValue ?? ""
            let message = m["message"]?.stringValue ?? ""
            let retryable = m["retryable"]?.boolValue ?? false
            items.append(ChatItem(id: "e_\(runId)_\(Int(nowMs()))", role: "error",
                                  text: friendlyError(code, message), runId: runId,
                                  retryText: retryable ? items.last(where: { $0.role == "user" })?.text : nil))
            onRunFailed?(runId, code, message)
        case "error":
            items.append(ChatItem(id: "e_\(Int(nowMs()))", role: "error",
                                  text: friendlyError(m["code"]?.stringValue, m["message"]?.stringValue)))
        case "session_reconnected":
            if m["resumed"]?.boolValue == false, m["runId"]?.stringValue != nil { run = nil }
        default:
            break
        }
    }

    private func patchLastAssistant(_ runId: String, _ fn: (ChatItem) -> ChatItem) {
        if let i = items.lastIndex(where: { $0.runId == runId && $0.role == "assistant" }) {
            items[i] = fn(items[i])
        } else {
            items.append(fn(ChatItem(id: "a_\(runId)", role: "assistant", text: "", steps: [], runId: runId)))
        }
    }

    private static func dedupeArtifacts(_ a: [ArtifactRef]) -> [ArtifactRef] {
        var seen = Set<String>()
        return a.filter { seen.insert($0.artifactId).inserted }
    }

    // MARK: - Actions

    @discardableResult
    func send(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return false }
        let id = "u_\(Int(nowMs()))"
        var pairs: [(String, JSONValue)] = [
            ("type", .string("user_message")), ("clientMessageId", .string(id)), ("text", .string(t)),
        ]
        if !model.isEmpty { pairs.append(("model", .string(model))) }
        if !client.sendFrame(.object(pairs)) { return false }
        items.append(ChatItem(id: id, role: "user", text: t))
        return true
    }

    func stop() {
        if let r = run?.runId ?? client.activeRunId {
            _ = client.sendFrame(.object([("type", .string("cancel_run")), ("runId", .string(r))]))
        }
        client.cancelLocal()
    }

    func reset() {
        // With a live or connecting socket the bridge delivers this (queued ahead of hello
        // if need be). Anything else owes the reset: pendingReset makes the next
        // session_ready deliver it instead of restoring the old conversation.
        if !client.sendFrame(.object([("type", .string("reset_conversation"))])) { pendingReset = true }
        items = []
    }

    func reconnect() {
        client.close()
        client.maxReconnects = 8
        client.connect()
    }
}
