import CoreMIDI
import UniformTypeIdentifiers
import XCTest
@testable import GBKComposer

final class MIDIParserTests: XCTestCase {
    func testRunningStatusRealtimeAndSysEx() {
        var p = MIDIMessageParser()
        let out = p.feed([0x90, 60, 100, 62, 90, 0xF8, 64, 0, 0xF0, 1, 2, 3, 0xF7, 0xB0, 64, 127, 0xE0, 0x00, 0x40, 0xC0, 5])
        XCTAssertEqual(out, [[0x90, 60, 100], [0x90, 62, 90], [0xF8], [0x90, 64, 0], [0xB0, 64, 127], [0xE0, 0, 0x40], [0xC0, 5]])
    }

    func testSplitAcrossFeeds() {
        var p = MIDIMessageParser()
        XCTAssertEqual(p.feed([0x91, 60]), [])
        XCTAssertEqual(p.feed([10]), [[0x91, 60, 10]])
    }

    func testSemanticEventsMatchWeb() {
        XCTAssertEqual(MIDIEvent([0x93, 60, 100]), .noteOn(channel: 3, note: 60, velocity: 100))
        XCTAssertEqual(MIDIEvent([0x90, 60, 0]), .noteOff(channel: 0, note: 60))     // vel 0 = off
        XCTAssertEqual(MIDIEvent([0x80, 60, 40]), .noteOff(channel: 0, note: 60))
        XCTAssertEqual(MIDIEvent([0xB0, 64, 127]), .sustain(channel: 0, on: true, value: 127))
        XCTAssertEqual(MIDIEvent([0xB0, 64, 10]), .sustain(channel: 0, on: false, value: 10))
        XCTAssertEqual(MIDIEvent([0xB0, 1, 33]), .modWheel(channel: 0, value: 33))
        XCTAssertEqual(MIDIEvent([0xB0, 7, 99]), .cc(channel: 0, controller: 7, value: 99))
        XCTAssertEqual(MIDIEvent([0xE0, 0, 64]), .pitchBend(channel: 0, value: 8192))
        XCTAssertEqual(MIDIEvent([0xE0, 127, 127]), .pitchBend(channel: 0, value: 16383))
        XCTAssertEqual(MIDIEvent([0xF8]), .other)
    }

    func testUMPMidi1AndSystem() {
        let words: [UInt32] = [0x2090_3C64, 0x20B0_407F, 0x20E0_0040, 0x10F8_0000, 0x20C0_0500]
        XCTAssertEqual(MIDIMessageParser.messages(fromUMP: words), [[0x90, 60, 100], [0xB0, 64, 127], [0xE0, 0, 64], [0xF8], [0xC0, 5]])
    }

    func testUMPMidi2ChannelVoiceScaled() {
        let words: [UInt32] = [
            0x4090_3C00, 0xFFFF_0000,   // note on, vel 0xFFFF → 127
            0x4090_3C00, 0x0000_0000,   // MIDI 2 note on vel 0 stays a note on (vel 1)
            0x40B0_0100, 0x8000_0000,   // CC1 half → 64
            0x40E0_0000, 0x8000_0000,   // bend centre → 8192
            0x3001_0203, 0x0405_0000,   // sysex7 dropped
        ]
        XCTAssertEqual(MIDIMessageParser.messages(fromUMP: words), [[0x90, 60, 127], [0x90, 60, 1], [0xB0, 1, 64], [0xE0, 0, 64]])
    }

    @MainActor
    func testBridgeBatchFormat() {
        let now: UInt64 = 1_000_000_000
        let js = MIDIBridge.encodeBatch([
            BridgedMIDIMessage(sourceID: "coremidi-42", bytes: [0x90, 60, 100], hostTime: now),
            BridgedMIDIMessage(sourceID: "coremidi-42", bytes: [0xB0, 64, 127], hostTime: now + 5),
        ], nowHostTime: now)
        XCTAssertEqual(js, #"window.__gbkMidi&&__gbkMidi.recv([["coremidi-42",[144,60,100],0.000],["coremidi-42",[176,64,127],0.000]])"#)
        XCTAssertEqual(MIDIBridge.encodeDevices([MIDIInputDevice(id: "coremidi-1", name: "Keys \"88\"", manufacturer: "Acme")]),
                       #"[{"id":"coremidi-1","manufacturer":"Acme","name":"Keys \"88\""}]"#)
    }

    func testSourceIDRoundTrip() {
        for uid: MIDIUniqueID in [1, -5, Int32.max, Int32.min] {
            let ref = UnsafeMutableRawPointer(bitPattern: Int(UInt32(bitPattern: uid)) | (1 << 40))
            XCTAssertEqual(MIDIInputHub.sourceID(ref), MIDIInputHub.deviceID(uid))
        }
    }

    /// Studio import input accepts ".mid,.midi,audio/midi,…"; WebKit's document picker maps those to UTTypes.
    /// They must resolve to a declared system type (not dynamic) so Files shows .mid/.midi without app UTType work.
    func testMidiFileTypesResolveForWebKitPicker() {
        for ext in ["mid", "midi"] {
            let t = UTType(filenameExtension: ext)
            XCTAssertEqual(t, .midi, ext); XCTAssertFalse(t?.isDynamic ?? true)
        }
        XCTAssertEqual(UTType(mimeType: "audio/midi"), .midi)
    }
}
