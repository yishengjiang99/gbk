import Foundation

// Port of the schema layer of src/webmcp/tools.ts: ToolDef input schemas are plain JSON values
// (they ship verbatim in the bridge manifest, whose hash must match the web build), plus the
// strict-ish runtime validator and argument accessors.

/// A non-coded error: TS `throw new Error(msg)` — runTool maps it to INTERNAL_ERROR.
struct PlainToolError: Error, Sendable { var message: String }

func checkCancelled() throws {
    if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "cancelled") }
}

// MARK: - Schema builders (mirror the TS obj/int/str/num helpers byte-for-byte in canonical form)

/// TS `obj(...)`: always carries properties, required (possibly empty) and additionalProperties: false.
func schemaObj(_ properties: [(String, JSONValue)], required: [String] = []) -> JSONValue {
    .object([
        ("type", .string("object")),
        ("properties", .object(properties)),
        ("required", .array(required.map { .string($0) })),
        ("additionalProperties", .bool(false)),
    ])
}

func schemaInt(_ minimum: Int64, _ maximum: Int64, _ description: String? = nil) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("type", .string("integer")), ("minimum", .int(minimum)), ("maximum", .int(maximum))]
    if let description { pairs.append(("description", .string(description))) }
    return .object(pairs)
}

func schemaNum(_ minimum: Double, _ maximum: Double, _ description: String? = nil) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("type", .string("number")), ("minimum", .number(minimum)), ("maximum", .number(maximum))]
    if let description { pairs.append(("description", .string(description))) }
    return .object(pairs)
}

func schemaStr(_ description: String? = nil, maxLength: Int64 = 200, extra: [(String, JSONValue)] = []) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("type", .string("string")), ("maxLength", .int(maxLength))]
    if let description { pairs.append(("description", .string(description))) }
    pairs.append(contentsOf: extra)
    return .object(pairs)
}

func schemaEnum(_ values: [String], _ description: String? = nil) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("type", .string("string")), ("enum", .array(values.map { .string($0) }))]
    if let description { pairs.append(("description", .string(description))) }
    return .object(pairs)
}

func schemaBool(_ description: String? = nil) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("type", .string("boolean"))]
    if let description { pairs.append(("description", .string(description))) }
    return .object(pairs)
}

func schemaArray(items: JSONValue, maxItems: Int64? = nil, minItems: Int64? = nil, description: String? = nil) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("type", .string("array"))]
    if let maxItems { pairs.append(("maxItems", .int(maxItems))) }
    if let minItems { pairs.append(("minItems", .int(minItems))) }
    pairs.append(("items", items))
    if let description { pairs.append(("description", .string(description))) }
    return .object(pairs)
}

/// TS `BASE_REV` (tools.ts / sound-tools.ts).
let baseRevSchema = schemaInt(0, 9007199254740991, "Optimistic concurrency: the revision your edit is based on. Returns STALE_REVISION if the project changed.")
/// sound-tools.ts BASE_REV has a shorter description.
let baseRevSchemaShort = schemaInt(0, 9007199254740991, "Optimistic concurrency: the revision your edit is based on.")

let unitSchema = schemaEnum(["bars", "beats", "ticks", "seconds"], "Coordinate unit. bars are 1-based (bar 9 = start of bar 9); beats are 0-based quarter-of-meter beats from song start; ticks use the file PPQ; seconds follow the tempo map.")
let rangeSchema = schemaObj([
    ("unit", unitSchema),
    ("start", .object([("type", .string("number")), ("minimum", .int(0))])),
    ("end", .object([("type", .string("number")), ("minimum", .int(0)), ("description", .string("For bars the end bar is inclusive (bars 9..16 covers through the end of bar 16)."))])),
], required: ["unit", "start", "end"])
/// music/arrangement tools use a bare RANGE (no descriptions).
let rangeSchemaBare = schemaObj([
    ("unit", schemaEnum(["bars", "beats", "ticks", "seconds"])),
    ("start", .object([("type", .string("number")), ("minimum", .int(0))])),
    ("end", .object([("type", .string("number")), ("minimum", .int(0))])),
], required: ["unit", "start", "end"])

// MARK: - Validator (port of `validate` in tools.ts)

func validateToolArgs(schema: JSONValue, _ v: JSONValue, path: String = "input") throws {
    func bad(_ m: String) -> ToolArgError { ToolArgError("INVALID_ARGUMENT", "\(path): \(m)") }
    if let alts = schema["anyOf"]?.arrayValue {
        var errs: [String] = []
        for alt in alts {
            do { try validateToolArgs(schema: alt, v, path: path); return }
            catch let e as ToolArgError { errs.append(e.message.replacingOccurrences(of: "\(path): ", with: "")) }
        }
        throw bad(errs.joined(separator: " or "))
    }
    switch schema["type"]?.stringValue {
    case "object":
        guard case .object(let pairs) = v else { throw bad("expected object") }
        let props = schema["properties"]?.objectValue ?? []
        let propNames = Set(props.map { $0.0 })
        for r in schema["required"]?.arrayValue?.compactMap({ $0.stringValue }) ?? [] {
            if v[r] == nil { throw bad("missing \(r)") }
        }
        for (k, val) in pairs {
            if !propNames.contains(k) {
                if schema["additionalProperties"]?.boolValue == false { throw bad("unexpected property \(k)") }
                continue
            }
            try validateToolArgs(schema: props.first { $0.0 == k }!.1, val, path: "\(path).\(k)")
        }
    case "array":
        guard case .array(let arr) = v else { throw bad("expected array") }
        if let maxItems = schema["maxItems"]?.intValue, arr.count > maxItems { throw bad("at most \(maxItems) items") }
        if let items = schema["items"] {
            for (i, x) in arr.enumerated() { try validateToolArgs(schema: items, x, path: "\(path)[\(i)]") }
        }
    case "integer", "number":
        let isInteger = schema["type"]?.stringValue == "integer"
        guard let d = v.doubleValue, d.isFinite, !isInteger || v.intValue != nil else { throw bad("expected \(isInteger ? "integer" : "number")") }
        if let min = schema["minimum"]?.doubleValue, d < min { throw bad("must be >= \(jsNum(min))") }
        if let max = schema["maximum"]?.doubleValue, d > max { throw bad("must be <= \(jsNum(max))") }
    case "string":
        guard case .string(let s) = v else { throw bad("expected string") }
        if let maxLength = schema["maxLength"]?.intValue, s.count > maxLength { throw bad("too long") }
        if let enumVals = schema["enum"]?.arrayValue?.compactMap({ $0.stringValue }), !enumVals.contains(s) {
            throw bad("must be one of \(enumVals.joined(separator: ", "))")
        }
    case "boolean":
        if v.boolValue == nil { throw bad("expected boolean") }
    default:
        break
    }
}

// MARK: - Argument accessors (args are validated JSONValue objects)

extension JSONValue {
    func argStr(_ k: String) -> String? { self[k]?.stringValue }
    func argInt(_ k: String) -> Int? { self[k]?.intValue }
    func argDbl(_ k: String) -> Double? { self[k]?.doubleValue }
    func argBool(_ k: String) -> Bool? { self[k]?.boolValue }
    func argArr(_ k: String) -> [JSONValue]? { self[k]?.arrayValue }
    func argObj(_ k: String) -> JSONValue? { self[k] }
    /// TS `a.x as string[]` after validation.
    func argStrs(_ k: String) -> [String]? { self[k]?.arrayValue?.compactMap { $0.stringValue } }
    func argInts(_ k: String) -> [Int]? { self[k]?.arrayValue?.compactMap { $0.intValue } }
}

/// Build a JSON object from ordered pairs, skipping nil values (TS optional-spread semantics).
func jsonObj(_ pairs: [(String, JSONValue?)]) -> JSONValue {
    .object(pairs.compactMap { pair in pair.1.map { (pair.0, $0) } })
}

func jsonNum(_ d: Double) -> JSONValue { .number(d) }
/// TS `+x.toFixed(3)` — a JS number after rounding to 3 decimals.
func jsonFixed3(_ d: Double) -> JSONValue { .number((d * 1000).rounded() / 1000) }
