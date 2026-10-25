import XCTest
@testable import OMRHomrIOS

final class TokenizerTests: XCTestCase {
    func testVocabularyLoadsFromBundle() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        XCTAssertEqual(vocab.padToken, 0)
        XCTAssertEqual(vocab.bosToken, 1)
        XCTAssertEqual(vocab.eosToken, 2)
        XCTAssertEqual(vocab.rhythm["PAD"], 0)
        XCTAssertEqual(vocab.rhythm["BOS"], 1)
        XCTAssertEqual(vocab.rhythm["EOS"], 2)
        // Exported from upstream Vocabulary() — sizes must stay stable.
        XCTAssertEqual(vocab.rhythm.count, 260)
        XCTAssertEqual(vocab.pitch.count, 72)
        XCTAssertEqual(vocab.lift.count, 7)
        XCTAssertEqual(vocab.articulation.count, 62)
        XCTAssertEqual(vocab.slur.count, 5)
        XCTAssertEqual(vocab.position.count, 5)
        XCTAssertEqual(vocab.maxSeqLen, 608)
    }

    func testHFTokenizerAssetsPresent() throws {
        let assets = try TokenizerLoader.requireHFTokenizerAssets()
        XCTAssertEqual(assets.count, 4)
        let names = Set(assets.map(\.name))
        XCTAssertEqual(
            names,
            Set([
                "tokenizer_rhythm",
                "tokenizer_lift",
                "tokenizer_pitch",
                "tokenizer_note",
            ])
        )
        // Upstream HF WordLevel sizes (legacy assets; decode uses vocabulary.json).
        let byName = Dictionary(uniqueKeysWithValues: assets.map { ($0.name, $0.vocab.count) })
        XCTAssertEqual(byName["tokenizer_rhythm"], 93)
        XCTAssertEqual(byName["tokenizer_pitch"], 71)
        XCTAssertEqual(byName["tokenizer_lift"], 5)
        XCTAssertEqual(byName["tokenizer_note"], 2)
    }

    func testDetokenizeSkipsControlTokens() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        XCTAssertNil(DecoderLoop.detokenize(vocab.bosToken, vocab.invRhythm))
        XCTAssertNil(DecoderLoop.detokenize(vocab.eosToken, vocab.invRhythm))
        XCTAssertNil(DecoderLoop.detokenize(vocab.padToken, vocab.invRhythm))
        let bar = vocab.rhythm["barline"]
        XCTAssertNotNil(bar)
        XCTAssertEqual(DecoderLoop.detokenize(bar!, vocab.invRhythm), "barline")
    }
}
