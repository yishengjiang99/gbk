import CoreMIDI
import Foundation

/// One complete MIDI 1.0 message from a source, stamped with CoreMIDI host time (mach ticks).
struct BridgedMIDIMessage: Equatable {
    var sourceID: String
    var bytes: [UInt8]
    var hostTime: UInt64
}

struct MIDIInputDevice: Equatable, Codable {
    var id: String
    var name: String
    var manufacturer: String
}

/// CoreMIDI input: every source (USB/class-compliant, network session, Bluetooth LE once paired, virtual),
/// hot-plug through client notifications, UMP input port (MIDI 1.0 protocol) parsed into MIDI 1.0 messages.
/// Messages are buffered off the CoreMIDI thread and delivered to `onMessages` on main once per run-loop turn.
final class MIDIInputHub: @unchecked Sendable {
    static let shared = MIDIInputHub()

    var onMessages: (([BridgedMIDIMessage]) -> Void)?
    var onDevicesChanged: (([MIDIInputDevice]) -> Void)?
    private(set) var devices: [MIDIInputDevice] = []
    private(set) var started = false
    private(set) var lastError: OSStatus = noErr

    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var connected: [MIDIUniqueID: MIDIEndpointRef] = [:]
    private let lock = NSLock()
    private var buffer: [BridgedMIDIMessage] = []
    private var flushScheduled = false

    /// Idempotent. Call on main.
    @discardableResult
    func start() -> OSStatus {
        if started { return noErr }
        var s = MIDIClientCreateWithBlock("GBK MIDI" as CFString, &client) { [weak self] note in
            let id = note.pointee.messageID
            if id == .msgSetupChanged || id == .msgObjectAdded || id == .msgObjectRemoved || id == .msgPropertyChanged {
                DispatchQueue.main.async { self?.rescan() }
            }
        }
        guard s == noErr else { lastError = s; return s }
        s = MIDIInputPortCreateWithProtocol(client, "GBK In" as CFString, ._1_0, &port) { [weak self] list, refCon in
            self?.receive(list, sourceID: Self.sourceID(refCon))
        }
        guard s == noErr else { lastError = s; return s }
        let net = MIDINetworkSession.default()             // network MIDI (RTP-MIDI / Audio MIDI Setup)
        net.isEnabled = true
        net.connectionPolicy = .anyone
        started = true
        rescan()
        return noErr
    }

    /// Connect new sources, drop vanished ones, publish the device list.
    func rescan() {
        guard started else { return }
        var seen: [MIDIUniqueID: MIDIEndpointRef] = [:]
        var list: [MIDIInputDevice] = []
        for i in 0..<MIDIGetNumberOfSources() {
            let src = MIDIGetSource(i)
            guard src != 0 else { continue }
            if Self.int(src, kMIDIPropertyOffline) == 1 { continue }
            let uid = MIDIUniqueID(Self.int(src, kMIDIPropertyUniqueID))
            seen[uid] = src
            if connected[uid] == nil {
                let ref = UnsafeMutableRawPointer(bitPattern: Int(UInt32(bitPattern: uid)) | (1 << 40))
                MIDIPortConnectSource(port, src, ref)
            }
            list.append(MIDIInputDevice(id: Self.deviceID(uid),
                                        name: Self.string(src, kMIDIPropertyDisplayName) ?? Self.string(src, kMIDIPropertyName) ?? "MIDI input",
                                        manufacturer: Self.string(src, kMIDIPropertyManufacturer) ?? ""))
        }
        for (uid, src) in connected where seen[uid] == nil { MIDIPortDisconnectSource(port, src) }
        connected = seen
        if list != devices { devices = list; onDevicesChanged?(list) }
    }

    static func deviceID(_ uid: MIDIUniqueID) -> String { "coremidi-\(uid)" }
    static func sourceID(_ ref: UnsafeMutableRawPointer?) -> String {
        guard let ref else { return "coremidi-unknown" }
        return deviceID(MIDIUniqueID(bitPattern: UInt32(truncatingIfNeeded: Int(bitPattern: ref))))
    }

    // MARK: receive (CoreMIDI thread)

    private func receive(_ list: UnsafePointer<MIDIEventList>, sourceID: String) {
        var msgs: [BridgedMIDIMessage] = []
        for packet in list.unsafeSequence() {
            let count = Int(packet.pointee.wordCount)
            let words: [UInt32] = withUnsafeBytes(of: packet.pointee.words) { raw in Array(raw.bindMemory(to: UInt32.self).prefix(count)) }
            let ts = packet.pointee.timeStamp == 0 ? mach_absolute_time() : packet.pointee.timeStamp
            for m in MIDIMessageParser.messages(fromUMP: words) { msgs.append(BridgedMIDIMessage(sourceID: sourceID, bytes: m, hostTime: ts)) }
        }
        ingest(msgs)
    }

    /// UMP words from one source (same path as the CoreMIDI callback after unpacking the event list).
    func ingestUMP(_ words: [UInt32], sourceID: String, hostTime: UInt64 = mach_absolute_time()) {
        ingest(MIDIMessageParser.messages(fromUMP: words).map { BridgedMIDIMessage(sourceID: sourceID, bytes: $0, hostTime: hostTime) })
    }

    /// Queue messages and schedule one main-thread flush (batches everything that arrives before main runs).
    func ingest(_ msgs: [BridgedMIDIMessage]) {
        guard !msgs.isEmpty else { return }
        lock.lock()
        buffer.append(contentsOf: msgs)
        let schedule = !flushScheduled
        flushScheduled = true
        lock.unlock()
        if schedule { DispatchQueue.main.async { [weak self] in self?.flush() } }
    }

    private func flush() {
        lock.lock()
        let batch = buffer
        buffer.removeAll(keepingCapacity: true)
        flushScheduled = false
        lock.unlock()
        if !batch.isEmpty { onMessages?(batch) }
    }

    // MARK: helpers

    private static func int(_ obj: MIDIObjectRef, _ prop: CFString) -> Int32 {
        var v: Int32 = 0
        MIDIObjectGetIntegerProperty(obj, prop, &v)
        return v
    }

    private static func string(_ obj: MIDIObjectRef, _ prop: CFString) -> String? {
        var s: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(obj, prop, &s) == noErr, let v = s?.takeRetainedValue() else { return nil }
        return v as String
    }

    static func hostTimeToMs(_ ticks: UInt64) -> Double {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return Double(ticks) * Double(tb.numer) / Double(tb.denom) / 1_000_000
    }
}
