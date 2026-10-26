import XCTest
@testable import GBKComposer

/// TestFlight build 4: tags wrapped mid-word. Tags are one paragraph that may break only between words.
final class FeedTagsTests: XCTestCase {
    func testParagraphBreaksOnlyBetweenWords() {
        let text = String(TagChips.paragraph(labels: ["rnb"], tags: ["groove", "key-change", "late-night", "neo soul"]).characters)
        XCTAssertEqual(text, "rnb · #groove #key\u{2011}change #late\u{2011}night #neo\u{00A0}soul")
        for word in text.split(separator: " ") where word != "·" { XCTAssertFalse(word.contains("-"), String(word)) }
        XCTAssertEqual(String(TagChips.paragraph(labels: [], tags: ["a"]).characters), "#a")
    }
}
