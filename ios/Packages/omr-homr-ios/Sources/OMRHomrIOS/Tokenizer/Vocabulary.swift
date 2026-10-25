import Foundation

/// Decode-time vocabulary loaded from bundled `vocabulary.json`.
///
/// Source of truth: `liebharc/homr` `homr/transformer/vocabulary.py` `Vocabulary()`,
/// exported verbatim — do not invent or edit token strings.
public struct HomrVocabulary: Equatable, Sendable {
    public let padToken: Int
    public let bosToken: Int
    public let eosToken: Int
    public let nonoteToken: Int
    public let maxSeqLen: Int

    public let rhythm: [String: Int]
    public let lift: [String: Int]
    public let articulation: [String: Int]
    public let pitch: [String: Int]
    public let slur: [String: Int]
    public let position: [String: Int]

    public var invRhythm: [Int: String] { Self.invert(rhythm) }
    public var invLift: [Int: String] { Self.invert(lift) }
    public var invArticulation: [Int: String] { Self.invert(articulation) }
    public var invPitch: [Int: String] { Self.invert(pitch) }
    public var invSlur: [Int: String] { Self.invert(slur) }
    public var invPosition: [Int: String] { Self.invert(position) }

    public init(
        padToken: Int,
        bosToken: Int,
        eosToken: Int,
        nonoteToken: Int,
        maxSeqLen: Int,
        rhythm: [String: Int],
        lift: [String: Int],
        articulation: [String: Int],
        pitch: [String: Int],
        slur: [String: Int],
        position: [String: Int]
    ) {
        self.padToken = padToken
        self.bosToken = bosToken
        self.eosToken = eosToken
        self.nonoteToken = nonoteToken
        self.maxSeqLen = maxSeqLen
        self.rhythm = rhythm
        self.lift = lift
        self.articulation = articulation
        self.pitch = pitch
        self.slur = slur
        self.position = position
    }

    private static func invert(_ map: [String: Int]) -> [Int: String] {
        var out: [Int: String] = [:]
        out.reserveCapacity(map.count)
        for (k, v) in map {
            out[v] = k
        }
        return out
    }
}

/// Decoded HF WordLevel tokenizer asset (legacy TrOMR JSON shipped upstream).
/// Presence is checked like `staff2score.py`; decode uses `HomrVocabulary`.
public struct HFWordLevelTokenizer: Equatable, Sendable {
    public let name: String
    public let vocab: [String: Int]

    public init(name: String, vocab: [String: Int]) {
        self.name = name
        self.vocab = vocab
    }
}
