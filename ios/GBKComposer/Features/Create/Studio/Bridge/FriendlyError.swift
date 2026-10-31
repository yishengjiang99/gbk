import Foundation

// Port of src/agent/friendly-error.ts: Composer errors in plain language — no internal
// codes or ids reach the chat (bridge/runtime codes stay in logs).

private let friendlyPlain: [String: String] = [
    "BROWSER_DISCONNECTED": "This page reloaded or closed, so the run stopped. Finished changes are saved; send your message again to continue.",
    "PROJECT_CHANGED": "A different song was opened while this was running, so that step was skipped.",
    "STALE_REVISION": "The song changed while this step was running, so it was skipped.",
    "TOOL_TIMEOUT": "That step took too long and was stopped.",
    "OPERATION_CANCELLED": "Stopped.",
    "MAX_STEPS": "Stopped after the maximum number of steps; everything finished so far is kept.",
    "MAX_TOOL_CALLS": "Stopped after too many steps in one run; everything finished so far is kept.",
    "PROVIDER_RATE_LIMITED": "The AI service is busy right now. Try again in a moment.",
    "PROVIDER_ERROR": "The AI service had a problem. Try again in a moment.",
    "QUOTA_EXCEEDED": "You've reached today's Composer limit.",
    "RATE_LIMITED": "Too many requests. Try again in a moment.",
    "NO_TOOLS": "The studio isn't ready yet. Reload the page and try again.",
    "LLM_NOT_CONFIGURED": "The Composer isn't available on this server right now.",
    "USER_APPROVAL_REQUIRED": "Waiting for your approval.",
]

private let friendlyCodePrefix = try! NSRegularExpression(pattern: #"^\(?[A-Z][A-Z0-9_]{3,}\)?:?\s*"#)
private let friendlyParenDetail = try! NSRegularExpression(pattern: #"\s*\((expected|was|now)[^)]*\)"#, options: [.caseInsensitive])
private let friendlyIdToken = try! NSRegularExpression(pattern: #"\b(prj|shr|run|call|art|usr|sess)_[a-z0-9]{6,}\b"#, options: [.caseInsensitive])

func friendlyError(_ code: String?, _ message: String?) -> String {
    if let code, let plain = friendlyPlain[code] { return plain }
    if let code, code.hasSuffix("BUDGET_EXHAUSTED") {
        if let message, message.contains("You've hit today's AI limit") { return message.trimmingCharacters(in: .whitespacesAndNewlines) }
        return "You've hit today's AI limit. It resets at 5 PM PT."
    }
    var m = message ?? ""
    m = friendlyCodePrefix.stringByReplacingMatches(in: m, range: NSRange(m.startIndex..., in: m), withTemplate: "")
    m = friendlyParenDetail.stringByReplacingMatches(in: m, range: NSRange(m.startIndex..., in: m), withTemplate: "")
    m = friendlyIdToken.stringByReplacingMatches(in: m, range: NSRange(m.startIndex..., in: m), withTemplate: "this song")
    m = m.trimmingCharacters(in: .whitespacesAndNewlines)
    if m.isEmpty { return "Something went wrong. Try again." }
    return m.prefix(1).uppercased() + m.dropFirst()
}
