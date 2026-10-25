import Foundation

/// Loads bundled tokenizer / vocabulary assets.
///
/// Asset layout (copied from upstream, not invented):
/// - `Resources/Vocab/vocabulary.json` — `Vocabulary()` export used by `ScoreDecoder`
/// - `Resources/Tokenizers/tokenizer_{rhythm,lift,pitch,note}.json` — upstream HF WordLevel JSONs
public enum TokenizerLoader {
    public static let vocabularyResourceName = "vocabulary"
    public static let tokenizerNames = [
        "tokenizer_rhythm",
        "tokenizer_lift",
        "tokenizer_pitch",
        "tokenizer_note",
    ]

    /// Load authoritative decode vocab from package resources.
    public static func loadVocabulary(
        bundle: Bundle? = nil
    ) throws -> HomrVocabulary {
        // `Bundle.module` is internal, so it cannot be a public default argument value.
        let bundle = bundle ?? Bundle.module
        guard let url = bundle.url(
            forResource: vocabularyResourceName,
            withExtension: "json",
            subdirectory: "Vocab"
        ) else {
            throw OMRError.tokenizerMissing(
                "Missing Resources/Vocab/vocabulary.json in OMRHomrIOS bundle"
            )
        }
        return try loadVocabulary(from: url)
    }

    public static func loadVocabulary(from url: URL) throws -> HomrVocabulary {
        let data = try Data(contentsOf: url)
        let dto = try JSONDecoder().decode(VocabularyDTO.self, from: data)
        guard !dto.rhythm.isEmpty, !dto.pitch.isEmpty else {
            throw OMRError.invalidVocabulary("Empty rhythm/pitch maps in \(url.lastPathComponent)")
        }
        guard dto.rhythm["PAD"] == dto.padToken,
              dto.rhythm["BOS"] == dto.bosToken,
              dto.rhythm["EOS"] == dto.eosToken
        else {
            throw OMRError.invalidVocabulary(
                "PAD/BOS/EOS indices must match pad/bos/eos fields (homr Config)"
            )
        }
        return HomrVocabulary(
            padToken: dto.padToken,
            bosToken: dto.bosToken,
            eosToken: dto.eosToken,
            nonoteToken: dto.nonoteToken,
            maxSeqLen: dto.maxSeqLen,
            rhythm: dto.rhythm,
            lift: dto.lift,
            articulation: dto.articulation,
            pitch: dto.pitch,
            slur: dto.slur,
            position: dto.position
        )
    }

    /// Ensure upstream HF tokenizer JSONs are present (mirrors staff2score existence check).
    public static func requireHFTokenizerAssets(
        bundle: Bundle? = nil
    ) throws -> [HFWordLevelTokenizer] {
        // `Bundle.module` is internal, so it cannot be a public default argument value.
        let bundle = bundle ?? Bundle.module
        var loaded: [HFWordLevelTokenizer] = []
        for name in tokenizerNames {
            guard let url = bundle.url(
                forResource: name,
                withExtension: "json",
                subdirectory: "Tokenizers"
            ) else {
                throw OMRError.tokenizerMissing(
                    "Missing Resources/Tokenizers/\(name).json (upstream liebharc/homr asset)"
                )
            }
            loaded.append(try loadHFWordLevel(name: name, from: url))
        }
        return loaded
    }

    public static func loadHFWordLevel(name: String, from url: URL) throws -> HFWordLevelTokenizer {
        let data = try Data(contentsOf: url)
        let dto = try JSONDecoder().decode(HFTokenizerDTO.self, from: data)
        guard let vocab = dto.model.vocab, !vocab.isEmpty else {
            throw OMRError.invalidVocabulary("No model.vocab in \(url.lastPathComponent)")
        }
        return HFWordLevelTokenizer(name: name, vocab: vocab)
    }
}

// MARK: - DTOs (fileprivate)

private struct VocabularyDTO: Decodable {
    let padToken: Int
    let bosToken: Int
    let eosToken: Int
    let nonoteToken: Int
    let maxSeqLen: Int
    let rhythm: [String: Int]
    let lift: [String: Int]
    let articulation: [String: Int]
    let pitch: [String: Int]
    let slur: [String: Int]
    let position: [String: Int]

    enum CodingKeys: String, CodingKey {
        case padToken = "pad_token"
        case bosToken = "bos_token"
        case eosToken = "eos_token"
        case nonoteToken = "nonote_token"
        case maxSeqLen = "max_seq_len"
        case rhythm, lift, articulation, pitch, slur, position
    }
}

private struct HFTokenizerDTO: Decodable {
    let model: HFModelDTO
}

private struct HFModelDTO: Decodable {
    let type: String?
    let vocab: [String: Int]?
}
