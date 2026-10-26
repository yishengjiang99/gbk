// swift-tools-version:5.9
// SPDX-License-Identifier: AGPL-3.0-or-later
// SF2Player: SMF reader + sequencer + real-time scheduler + AVAudioEngine player on top of the
// shared SF2Engine package (SoundFont 2 parser + synth, github.com/yishengjiang99/sf2player-swift).
// Swift port of yishengjiang99/gbk (sf2-parser.ts, src/sf2-renderer.ts, src/midi-timer.worker.ts).
// AGPL-3.0-or-later (see LICENSE). Independent of omr-homr-ios: consumes only MIDI Data.
import PackageDescription

let package = Package(
    name: "SF2Player",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SF2Player", targets: ["SF2Player"]),
    ],
    dependencies: [
        // Shared SF2 rendering engine (same module in omr-sheet-cam and earsheet), pinned revision.
        .package(url: "https://github.com/yishengjiang99/sf2player-swift.git", revision: "6ce4941247d1dcd178da5c71b9279a9cf91fc007"),
    ],
    targets: [
        // Lock-free acquire/release loads and stores for the render-thread command ring.
        .target(name: "CSF2Atomics"),
        .target(name: "SF2Player", dependencies: ["CSF2Atomics", .product(name: "SF2Engine", package: "sf2player-swift")]),
    ]
)
