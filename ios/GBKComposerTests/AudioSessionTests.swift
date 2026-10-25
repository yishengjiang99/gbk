import AVFoundation
import XCTest
@testable import GBKComposer

/// "Playback is really quiet even at max volume" (TestFlight 0.1.0 (4)): the session must be loud `.playback`
/// normally and playAndRecord + defaultToSpeaker (mode .default, never measurement/voiceChat) only while recording.
@MainActor
final class AudioSessionTests: XCTestCase {
    func testPlaybackConfig() {
        let c = AudioSessionController.config(for: .playback)
        XCTAssertEqual(c.category, .playback)
        XCTAssertEqual(c.mode, .default)
        XCTAssertEqual(c.options, [])
    }

    func testRecordingConfig() {
        let c = AudioSessionController.config(for: .recording)
        XCTAssertEqual(c.category, .playAndRecord)
        XCTAssertEqual(c.mode, .default)
        XCTAssertTrue(c.options.contains(.defaultToSpeaker))
        XCTAssertTrue(c.options.contains(.allowBluetoothA2DP))
        XCTAssertTrue(c.options.contains(.allowBluetooth))
        XCTAssertFalse(c.options.contains(.duckOthers))
        for quiet in [AVAudioSession.Mode.measurement, .voiceChat, .videoChat] { XCTAssertNotEqual(c.mode, quiet) }
    }

    func testSessionFollowsRecordersAndRestoresPlayback() throws {
        let audio = AudioSessionController.shared
        let session = AVAudioSession.sharedInstance()
        audio.start()
        XCTAssertEqual(audio.mode, .playback)
        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .default)

        do { try audio.beginRecording("hum") } catch {
            audio.endRecording("hum")
            throw XCTSkip("playAndRecord unavailable here: \(error)")
        }
        XCTAssertEqual(audio.mode, .recording)
        XCTAssertEqual(session.category, .playAndRecord)
        XCTAssertEqual(session.mode, .default)
        XCTAssertTrue(session.categoryOptions.contains(.defaultToSpeaker))

        try audio.beginRecording("web-mic")
        audio.endRecording("hum")
        XCTAssertEqual(session.category, .playAndRecord, "still recording while the web mic is live")
        audio.endRecording("web-mic")

        XCTAssertEqual(audio.mode, .playback)
        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .default)
        XCTAssertFalse(AudioSessionController.isReceiver(session.currentRoute), "output on the earpiece after Hum stops")
    }

    func testEnforceUndoesForeignCategory() throws {
        let audio = AudioSessionController.shared
        let session = AVAudioSession.sharedInstance()
        audio.start()
        // What WebKit / an old Hum build could leave behind.
        try? session.setCategory(.playAndRecord, mode: .measurement, options: [])
        audio.enforce()
        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .default)
        XCTAssertFalse(AudioSessionController.isReceiver(session.currentRoute))
    }
}
