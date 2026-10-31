// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PageLoadProgress: warmup load step weights + the monotonic emitter load() reports through.
import Foundation
import XCTest
@testable import OMRHomrIOS

final class PageLoadProgressTests: XCTestCase {
    func testWeightsSumToOneForAnySlotCount() {
        for slots in 1...4 {
            let w = PageLoadProgress.weights(staffSlots: slots)
            XCTAssertEqual(w.count, 2 + slots * 3, "slots \(slots)")
            XCTAssertEqual(w.reduce(0, +), 1, accuracy: 1e-9, "slots \(slots)")
        }
    }

    func testEncoderStepsDominate() {
        let w = PageLoadProgress.weights(staffSlots: 2)
        // Order: vocabulary, segnet, then per slot encoder / decoder / staff init.
        XCTAssertEqual(w[0], PageLoadProgress.vocabularyWeight)
        XCTAssertEqual(w[1], PageLoadProgress.segnetWeight)
        XCTAssertEqual(w[2] + w[5], PageLoadProgress.encoderWeightTotal, accuracy: 1e-9)
        XCTAssertEqual(w[2] + w[5], 0.90, accuracy: 1e-9)
    }

    func testEmitterIsMonotonicClampedAndEndsAtOne() {
        final class Box: @unchecked Sendable { var values: [Double] = [] }
        let box = Box()
        let emitter = MonotonicPageLoadProgress { box.values.append($0) }
        emitter.emit(0.05)
        emitter.emit(0.5)
        emitter.emit(0.4) // late ticker tick: dropped
        emitter.emit(-1) // clamped / not increasing: dropped
        emitter.emit(2) // clamps to 1
        XCTAssertEqual(box.values, [0.05, 0.5, 1])
        XCTAssertEqual(emitter.current, 1)
    }
}
