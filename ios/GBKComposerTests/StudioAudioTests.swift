import XCTest
@testable import GBKComposer

/// Phase 5: the native audio host — WAV encoding (round-tripped through the Phase 3
/// analyzeWav parser), normalize gains, and the no-SoundFont host behavior the tool
/// layer already knows how to warn about.
final class StudioAudioTests: XCTestCase {

    func testWavEncodeRoundTrip() {
        let left: [Float] = [0, 0.5, -0.5, 0.25]
        let right: [Float] = [0, -0.25, 0.25, -0.125]
        let data = encodeWavPCM16(left: left, right: right, sampleRate: 44100, normalize: "off")
        XCTAssertEqual(data.count, 44 + 4 * 4)
        let a = analyzeWav(data)
        XCTAssertNotNil(a)
        XCTAssertEqual(a?.sampleRate, 44100)
        XCTAssertEqual(a?.channels, 2)
        XCTAssertEqual(a?.frames, 4)
        XCTAssertEqual(a?.format, "pcm16")
        XCTAssertEqual(a?.peak ?? 0, 0.5, accuracy: 0.001)
    }
}
