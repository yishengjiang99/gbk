import Foundation

/// Mirrors `homr.transformer.vocabulary.EncodedSymbol` (decode branches only).
public struct EncodedSymbol: Equatable, Sendable, CustomStringConvertible {
    public var rhythm: String
    public var pitch: String
    public var lift: String
    public var articulation: String
    public var slur: String
    public var position: String
    /// Raw decoder `attention` output for this step: 2 x float32 `(x, y)` on the staff canvas
    /// (`attentionCenter`); imprecise.
    public var attentionPayload: Data?
    /// Page path only: `attentionCenter` mapped to the preprocessed page (homr `staff_to_page`). Not
    /// part of `==` (derived data).
    public var pagePoint: PagePoint?
    /// Page path only: the same point in the caller's input image pixels (homr `image_coordinates`).
    /// Not part of `==`.
    public var imageCoordinates: PagePoint?

    public static func == (a: EncodedSymbol, b: EncodedSymbol) -> Bool {
        a.rhythm == b.rhythm && a.pitch == b.pitch && a.lift == b.lift && a.articulation == b.articulation
            && a.slur == b.slur && a.position == b.position && a.attentionPayload == b.attentionPayload
    }

    public init(
        rhythm: String,
        pitch: String = EncodedSymbol.nonote,
        lift: String = EncodedSymbol.nonote,
        articulation: String = EncodedSymbol.nonote,
        slur: String = EncodedSymbol.nonote,
        position: String = EncodedSymbol.nonote,
        attentionPayload: Data? = nil
    ) {
        self.rhythm = rhythm
        self.pitch = pitch
        self.lift = lift
        self.articulation = articulation
        self.slur = slur
        self.position = position
        self.attentionPayload = attentionPayload
    }

    /// Build from fixture / oracle fields (e.g. `expected.tokens.json` symbols).
    public init(oracleFields f: OracleSymbolFields, attentionPayload: Data? = nil) {
        self.init(
            rhythm: f.rhythm,
            pitch: f.pitch,
            lift: f.lift,
            articulation: f.articulation,
            slur: f.slur,
            position: f.position,
            attentionPayload: attentionPayload
        )
    }

    /// Upstream `nonote = "."`
    public static let nonote = "."
    /// Upstream `empty = "_"`
    public static let empty = "_"

    public var isControlSymbol: Bool {
        rhythm == "BOS" || rhythm == "EOS" || rhythm == "PAD"
    }

    public var description: String {
        [rhythm, pitch, lift, articulation, slur, position].joined(separator: " ")
    }

    /// Field tuple used by Gate-1 oracle string-equal compares.
    /// Does not invent vocabulary — only exposes decoded tokenizer strings.
    public var oracleFields: OracleSymbolFields {
        OracleSymbolFields(
            rhythm: rhythm,
            pitch: pitch,
            lift: lift,
            articulation: articulation,
            slur: slur,
            position: position
        )
    }
}

/// Public, vocab-neutral view of one decoded symbol for oracle / fixture compare.
/// App / test targets can assert field equality without depending on private decode guts.
public struct OracleSymbolFields: Equatable, Sendable, Codable {
    public var rhythm: String
    public var pitch: String
    public var lift: String
    public var articulation: String
    public var slur: String
    public var position: String

    public init(
        rhythm: String,
        pitch: String,
        lift: String,
        articulation: String,
        slur: String,
        position: String
    ) {
        self.rhythm = rhythm
        self.pitch = pitch
        self.lift = lift
        self.articulation = articulation
        self.slur = slur
        self.position = position
    }
}

/// Ordered symbol sequence helper for Gate-1 oracle compare (no invented tokens).
public struct OracleSymbolSequence: Equatable, Sendable {
    public var symbols: [OracleSymbolFields]

    public init(symbols: [OracleSymbolFields]) {
        self.symbols = symbols
    }

    public init(encoded: [EncodedSymbol]) {
        self.symbols = encoded.map(\.oracleFields)
    }

    /// String-equal per-field compare against another sequence (Gate-1 stop condition).
    public func mismatches(vs other: OracleSymbolSequence) -> [String] {
        var out: [String] = []
        if symbols.count != other.symbols.count {
            out.append("count \(symbols.count) != \(other.symbols.count)")
        }
        let n = min(symbols.count, other.symbols.count)
        for i in 0..<n {
            let a = symbols[i]
            let b = other.symbols[i]
            if a.rhythm != b.rhythm { out.append("rhythm @\(i): \(a.rhythm) != \(b.rhythm)") }
            if a.pitch != b.pitch { out.append("pitch @\(i): \(a.pitch) != \(b.pitch)") }
            if a.lift != b.lift { out.append("lift @\(i): \(a.lift) != \(b.lift)") }
            if a.articulation != b.articulation {
                out.append("articulation @\(i): \(a.articulation) != \(b.articulation)")
            }
            if a.slur != b.slur { out.append("slur @\(i): \(a.slur) != \(b.slur)") }
            if a.position != b.position {
                out.append("position @\(i): \(a.position) != \(b.position)")
            }
        }
        return out
    }
}
