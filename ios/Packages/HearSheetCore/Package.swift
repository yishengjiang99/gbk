// swift-tools-version: 5.9
// Vendored subset of yishengjiang99/earsheet Packages/HearSheet (@357cb76, Copyright (C) 2026 Yisheng Jiang,
// AGPL-3.0-or-later): Basic Pitch Core ML inference + note decoding, used by the native Hum button.
import PackageDescription

let package = Package(
    name: "HearSheetCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "HearSheetCore", targets: ["HearSheetCore"])],
    targets: [
        .target(name: "HearSheetCore", resources: [.process("velocity-calibration.json")]),
        .testTarget(name: "HearSheetCoreTests", dependencies: ["HearSheetCore"]),
    ]
)
