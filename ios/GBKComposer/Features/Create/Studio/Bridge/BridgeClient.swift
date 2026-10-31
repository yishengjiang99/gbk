import Foundation
import Combine

// Port of src/agent/bridge-client.ts (BridgeClient): the WebSocket transport between the
// native Studio and the Composer agent server. Same wire protocol (protocol.ts v1), same
// outbox-before-hello flush, ping cadence, reconnect backoff, stale-socket resume and
// tool_result replay semantics. Auth: the gbk_cs session cookie, obtained through the
// native web-code redeem (no webview — a plain URLSession fetch plants the cookie in the
// shared storage the WS upgrade then presents).

enum ConnState: String, Sendable { case idle, connecting, connected, reconnecting, offline, unauthorized }

private final class WSDelegate: NSObject, URLSessionWebSocketDelegate {
    var onOpen: (() -> Void)?
    var onClose: ((Int) -> Void)?
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) { onOpen?() }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { onClose?(closeCode.rawValue) }
}

final class BridgeClient: ObservableObject {
    @Published private(set) var connState: ConnState = .idle
    @Published private(set) var connDetail: String? = nil
    let executor: ToolExecutor
    var store: WorkstationStore { executor.store }
    /// Every inbound server frame (the AgentSession consumes chat-relevant ones).
    var onEvent: ((JSONValue) -> Void)? = nil

    private(set) var sessionId: String? = nil
    private(set) var activeRunId: String? = nil
    var maxReconnects = 8

    private var task: URLSessionWebSocketTask? = nil
    private var session: URLSession? = nil
    private let delegate = WSDelegate()
    private var outbox: [JSONValue] = []
    private var socketOpen = false
    private var intentionalClose = false
    private var attempts = 0
    private var lastSeen: Double = 0
    private var pingTask: Task<Void, Never>? = nil
    private var reconnectTask: Task<Void, Never>? = nil
    private var projectSub: AnyCancellable? = nil
    private var lastProjectState: (String, Int)? = nil
    private let tabId: String = {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<8).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
    }()

    init(store: WorkstationStore) {
        executor = ToolExecutor(store: store)
        delegate.onOpen = { [weak self] in self?.handleOpen() }
        projectSub = store.$project
            .map { ($0.id, $0.revision) }
            .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
            .sink { [weak self] pair in
                guard let self, self.socketOpen else { return }
                if self.lastProjectState?.0 == pair.0 && self.lastProjectState?.1 == pair.1 { return }
                self.lastProjectState = pair
                self.sendFrame(.object([("type", .string("project_state")), ("projectId", .string(pair.0)), ("revision", .int(Int64(pair.1)))]))
            }
    }

    private func setState(_ s: ConnState, _ detail: String? = nil) {
        DispatchQueue.main.async { [weak self] in self?.connState = s; self?.connDetail = detail }
    }

    // MARK: - Lifecycle

    func connect() {
        if task != nil { return }
        intentionalClose = false
        reconnectTask?.cancel()
        setState(attempts > 0 ? .reconnecting : .connecting)
        Task { await self.openSocket() }
    }

    private func openSocket() async {
        await ensureWebCookie()
        guard task == nil, !intentionalClose else { return }
        if session == nil { session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil) }
        var comps = URLComponents(url: BridgeHTTP.baseURL, resolvingAgainstBaseURL: false)!
        comps.scheme = BridgeHTTP.baseURL.scheme == "https" ? "wss" : "ws"
        comps.path = "/api/agent/ws"
        var req = URLRequest(url: comps.url!)
        req.setValue(BridgeHTTP.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        let t = session!.webSocketTask(with: req)
        task = t
        t.resume()
        receiveLoop(t)
    }

    /// Plant the gbk_cs cookie via the one-time web-code redeem (the WKWebView handoff,
    /// done with a plain fetch instead — the cookie lands in shared storage either way).
    private func ensureWebCookie() async {
        let existing = HTTPCookieStorage.shared.cookies(for: BridgeHTTP.baseURL) ?? []
        if existing.contains(where: { $0.name == "gbk_cs" }) { return }
        guard AuthStore.currentAccessToken() != nil else { return }
        if let url = (try? await AuthServices.current.webSessionURL(returnPath: "/studio")) ?? nil {
            _ = try? await BridgeHTTP.session.data(for: URLRequest(url: url))
        }
    }

    private func handleOpen() {
        socketOpen = true
        attempts = 0
        lastSeen = nowMs()
        let queued = outbox; outbox = []
        for frame in queued { rawSend(frame) } // outbox flushes FIFO BEFORE hello
        var hello: [(String, JSONValue)] = [
            ("type", .string("hello")), ("protocol", .int(1)), ("tabId", .string(tabId)),
            ("manifest", .object([("hash", .string(executor.manifest.hash)), ("tools", .array(executor.manifest.tools))])),
            ("projectId", .string(store.project.id)), ("revision", .int(Int64(store.project.revision))),
        ]
        if let activeRunId { hello.append(("resumeRunId", .string(activeRunId))) }
        rawSend(.object(hello))
        lastProjectState = (store.project.id, store.project.revision)
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, self.socketOpen else { continue }
                self.sendFrame(.object([("type", .string("ping")), ("t", .int(Int64(nowMs())))]))
            }
        }
    }

    func close() {
        intentionalClose = true
        reconnectTask?.cancel(); pingTask?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil; socketOpen = false
        setState(.offline)
    }

    /// App-foreground hook (TS resume on visibility/pageshow/online/focus).
    func resume() {
        if socketOpen {
            if executor.busyCount > 0 || nowMs() - lastSeen < 45_000 {
                sendFrame(.object([("type", .string("ping")), ("t", .int(Int64(nowMs())))]))
                return
            }
            task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: 4000) ?? .abnormalClosure, reason: Data("stale".utf8))
            task = nil; socketOpen = false
            attempts = min(attempts, 1)
            connect()
            return
        }
        if task != nil { return } // connecting: nothing to do
        attempts = min(attempts, 1)
        connect()
    }

    private func handleSocketDown(code: Int) {
        guard task != nil else { return }
        task = nil; socketOpen = false
        pingTask?.cancel()
        if activeRunId == nil { executor.cancel() }
        if code == 4401 { setState(.unauthorized); return }
        if intentionalClose { setState(.offline); return }
        if attempts >= maxReconnects { setState(.offline, "could not reconnect"); return }
        let delayMs = min(15000, 500 * (1 << attempts))
        attempts += 1
        setState(.reconnecting)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            guard let self, !self.intentionalClose else { return }
            self.connect()
        }
    }

    // MARK: - Send / receive

    @discardableResult
    func sendFrame(_ frame: JSONValue) -> Bool {
        if socketOpen, task != nil { rawSend(frame); return true }
        if task != nil { // connecting: queue (flushed ahead of hello on open)
            if outbox.count < 50 { outbox.append(frame) }
            return true
        }
        return false
    }

    private func rawSend(_ frame: JSONValue) {
        task?.send(.string(frame.serialized)) { _ in }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, self.task === t else { return }
            switch result {
            case .success(let msg):
                self.lastSeen = nowMs()
                if case .string(let text) = msg, let frame = try? JSONValue.parse(text) { self.handleFrame(frame) }
                self.receiveLoop(t)
            case .failure:
                self.handleSocketDown(code: t.closeCode.rawValue)
            }
        }
    }

    private func handleFrame(_ frame: JSONValue) {
        switch frame["type"]?.stringValue {
        case "session_ready":
            sessionId = frame["sessionId"]?.stringValue
            setState(.connected)
        case "session_reconnected":
            if frame["resumed"]?.boolValue == false, let runId = frame["runId"]?.stringValue, runId == activeRunId {
                activeRunId = nil
                executor.cancel()
            }
        case "ping":
            sendFrame(.object([("type", .string("pong")), ("t", frame["t"] ?? .int(0))]))
        case "run_started":
            activeRunId = frame["runId"]?.stringValue
            store.supersedePendingProposals()
        case "run_completed", "run_failed":
            if activeRunId == nil || frame["runId"]?.stringValue == activeRunId {
                activeRunId = nil
                executor.cancel()
            }
        case "cancel_call":
            if let callId = frame["callId"]?.stringValue { executor.cancel(callId) }
        case "tool_call":
            handleToolCall(frame)
        default:
            break
        }
        onEvent?(frame)
    }

    private func handleToolCall(_ frame: JSONValue) {
        guard let runId = frame["runId"]?.stringValue, let callId = frame["callId"]?.stringValue,
              let toolName = frame["tool"]?.stringValue, let msgSession = frame["sessionId"]?.stringValue,
              let currentSession = sessionId else { return }
        let key = "\(runId):\(callId)"
        Task { [weak self] in
            guard let self else { return }
            if let prev = await self.executor.seenResult(key) {
                self.sendFrame(.object([("type", .string("tool_result")), ("sessionId", .string(currentSession)),
                                        ("runId", .string(runId)), ("callId", .string(callId)), ("result", prev)]))
                return
            }
            let task = self.executor.execute(
                sessionId: msgSession, currentSessionId: currentSession, runId: runId, callId: callId, tool: toolName,
                arguments: frame["arguments"] ?? .object([]),
                expectProjectId: frame["expectProjectId"]?.stringValue,
                consentNewProject: frame["consent"]?["newProject"]?.boolValue ?? false,
                deadlineMs: frame["deadlineMs"]?.intValue ?? 0,
                onProgress: { [weak self] progress, detail in
                    var pairs: [(String, JSONValue)] = [
                        ("type", .string("tool_progress")), ("sessionId", .string(currentSession)),
                        ("runId", .string(runId)), ("callId", .string(callId)), ("progress", .number(progress)),
                    ]
                    if let detail { pairs.append(("detail", .string(detail))) }
                    self?.sendFrame(.object(pairs))
                })
            let env = await task.value
            self.sendFrame(.object([("type", .string("tool_result")), ("sessionId", .string(currentSession)),
                                    ("runId", .string(runId)), ("callId", .string(callId)), ("result", env)]))
        }
    }

    /// Stop local tool execution (the session's stop button; the run itself is cancelled via cancel_run).
    func cancelLocal() { executor.cancel() }
}
