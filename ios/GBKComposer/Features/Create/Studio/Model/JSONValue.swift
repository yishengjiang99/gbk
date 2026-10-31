import Foundation

/// Ordered, exact JSON value used across the native Studio: project wire format, bridge frames,
/// tool arguments/results. Integers stay integers (ticks and MIDI values must never round-trip
/// through a Double), mirroring the web model's plain-object JSON.
enum JSONValue: Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([(String, JSONValue)])

    static func number(_ d: Double) -> JSONValue {
        if d.isFinite, d.rounded() == d, abs(d) < 9.0e15 { return .int(Int64(d)) }
        return .double(d)
    }

    subscript(key: String) -> JSONValue? {
        guard case .object(let pairs) = self else { return nil }
        return pairs.first { $0.0 == key }?.1
    }

    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var objectValue: [(String, JSONValue)]? { if case .object(let o) = self { return o }; return nil }
    /// Any numeric value as Double (nil for non-numbers).
    var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }
    /// Any numeric value as Int when it is integral.
    var intValue: Int? {
        switch self {
        case .int(let i): return Int(i)
        case .double(let d): return d.rounded() == d && abs(d) < 9.0e15 ? Int(d) : nil
        default: return nil
        }
    }
    var isNull: Bool { if case .null = self { return true }; return false }

    // MARK: Parsing (Foundation JSONSerialization, then exact re-typing)

    static func parse(_ data: Data) throws -> JSONValue {
        let raw = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return from(raw)
    }

    static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    static func from(_ raw: Any) -> JSONValue {
        switch raw {
        case is NSNull: return .null
        case let n as NSNumber:
            // JSONSerialization tags booleans as NSNumber with objCType "c".
            if String(cString: n.objCType) == "c" { return .bool(n.boolValue) }
            let d = n.doubleValue
            if d.rounded() == d, abs(d) < 9.0e15 { return .int(n.int64Value) }
            return .double(d)
        case let s as String: return .string(s)
        case let a as [Any]: return .array(a.map(from))
        case let o as [String: Any]:
            return .object(o.keys.sorted().map { ($0, from(o[$0]!)) })
        default: return .null
        }
    }

    // MARK: Serialization

    /// Compact JSON text (object keys in stored order).
    var serialized: String {
        var out = ""
        write(into: &out)
        return out
    }

    var data: Data { Data(serialized.utf8) }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d): out += Self.formatDouble(d)
        case .string(let s): out += Self.escape(s)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() { if i > 0 { out += "," }; v.write(into: &out) }
            out += "]"
        case .object(let pairs):
            out += "{"
            for (i, kv) in pairs.enumerated() {
                if i > 0 { out += "," }
                out += Self.escape(kv.0); out += ":"; kv.1.write(into: &out)
            }
            out += "}"
        }
    }

    /// Matches JS `JSON.stringify` number formatting for the values this app produces:
    /// integral doubles print as integers, others use the shortest round-trip form.
    static func formatDouble(_ d: Double) -> String {
        if !d.isFinite { return "null" }
        if d.rounded() == d, abs(d) < 1e21 { return String(Int64(d)) }
        return String(d)
    }

    static func escape(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    /// Canonical form for the manifest hash: object keys sorted recursively (the TS `canon`).
    var canonical: String {
        switch self {
        case .array(let a): return "[" + a.map { $0.canonical }.joined(separator: ",") + "]"
        case .object(let pairs):
            let sorted = pairs.sorted { $0.0 < $1.0 }
            return "{" + sorted.map { "\(Self.escape($0.0)):\($0.1.canonical)" }.joined(separator: ",") + "}"
        default: return serialized
        }
    }
}

extension JSONValue: Equatable {
    // Manual conformance: [(String, JSONValue)] cannot synthesize == (tuples are not Equatable).
    // Strictly case-wise — .int(1) != .double(1.0) — matching this type's exactness contract.
    static func == (a: JSONValue, b: JSONValue) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.bool(let x), .bool(let y)): return x == y
        case (.int(let x), .int(let y)): return x == y
        case (.double(let x), .double(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.array(let x), .array(let y)): return x == y
        case (.object(let x), .object(let y)):
            guard x.count == y.count else { return false }
            return zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }
}

/// FNV-1a 32-bit over UTF-16 code units, matching the TS `manifestHash` (JS charCodeAt semantics).
func fnv1aHex(_ s: String) -> String {
    var h: UInt32 = 0x811c9dc5
    for u in s.utf16 {
        h ^= UInt32(u)
        h = h &* 0x01000193
    }
    return String(format: "%08x", h)
}

/// mulberry32 seeded PRNG, bit-exact with the TS `rng` in src/music/theory.ts.
struct Mulberry32: Sendable {
    private var a: UInt32
    init(seed: Int) { a = UInt32(truncatingIfNeeded: seed) }
    mutating func next() -> Double {
        a = a &+ 0x6d2b79f5
        var t = a
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double((t ^ (t >> 14)) & 0xffffffff) / 4294967296.0
    }
}
