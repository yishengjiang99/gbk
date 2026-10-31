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

    func testWavPeakNormalize() {
        // Peak 0.25 with "peak" -> gained to ~0.891 (-1 dBFS).
        let data = encodeWavPCM16(left: [0.25, -0.1], right: [0.1, 0.05], sampleRate: 22050, normalize: "peak")
        let a = analyzeWav(data)
        XCTAssertEqual(a?.peak ?? 0, 0.891, accuracy: 0.002)
    }

    func testWavLoudnessNormalizeCapsAtPeak() {
        // A loud transient over a quiet body: RMS gain would clip, so the peak cap wins.
        var left = [Float](repeating: 0.01, count: 200)
        left[0] = 0.9
        let data = encodeWavPCM16(left: left, right: left, sampleRate: 44100, normalize: "loudness")
        let a = analyzeWav(data)
        XCTAssertNotNil(a)
        XCTAssertLessThanOrEqual(a?.peak ?? 1, 0.99 + 0.001)
        XCTAssertEqual(a?.clippedSamples, 0)
    }

    func testWavSilenceStaysSilent() {
        let data = encodeWavPCM16(left: [0, 0, 0], right: [0, 0, 0], sampleRate: 44100, normalize: "loudness")
        let a = analyzeWav(data)
        XCTAssertEqual(a?.peak, 0)
        XCTAssertEqual(a?.peakDbFS, -Double.infinity)
    }

    func testHostWithoutSoundFont() async {
        // No font loaded in the test process: the host degrades exactly like the web
        // host before its SoundFont arrives (empty presets, no regions).
        let driver = StudioAudioDriver()
        XCTAssertEqual(driver.presetsJSON().count, 0)
        let store = WorkstationStore()
        XCTAssertNil(driver.trackRegionsJSON(store.project, store.project.tracks.first?.id ?? "none"))
        XCTAssertFalse(driver.isAudioReady())
    }

    func testDownloadsSave() {
        let name = "studio-audio-test-\(UUID().uuidString).wav"
        XCTAssertTrue(StudioDownloads.save(Data([1, 2, 3]), name))
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let url = docs.appendingPathComponent("GBK Downloads").appendingPathComponent(name)
        XCTAssertEqual(try? Data(contentsOf: url), Data([1, 2, 3]))
        try? FileManager.default.removeItem(at: url)
    }
}
