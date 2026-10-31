import XCTest
@testable import GBKComposer

/// iPad feed card tiers mirror web 19d0d66 (social.css): <768 phone, >=768 full-bleed, >=1200 side panel.
final class FeedCardLayoutTests: XCTestCase {
    func testWidthTiers() {
        XCTAssertEqual(FeedCardLayout(width: 390), .phone)
        XCTAssertEqual(FeedCardLayout(width: 767.5), .phone)
        XCTAssertEqual(FeedCardLayout(width: 768), .wide)
        XCTAssertEqual(FeedCardLayout(width: 1199), .wide)
        XCTAssertEqual(FeedCardLayout(width: 1200), .side)
        XCTAssertEqual(FeedCardLayout(width: 1366), .side)
    }

    func testRailInsetsAndRollScale() {
        // Wide: 32 from the card's right edge and 24 from its top, with card padding 16/12.
        XCTAssertEqual(FeedCardLayout.wide.railTrailingInRoll + FeedCardLayout.padH, 32)
        XCTAssertEqual(FeedCardLayout.wide.railTopInRoll + FeedCardLayout.padV, 24)
        // Side: 20 from the roll's right edge.
        XCTAssertEqual(FeedCardLayout.side.railTrailingInRoll, 20)
        XCTAssertEqual(FeedCardLayout.rollScale(2), 2)
        XCTAssertEqual(FeedCardLayout.rollScale(4), 3)
    }
}
