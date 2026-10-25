// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — real progress for a full-page parse (PageInferenceSession.parsePage): stage events from the
// pipeline itself (SegNet tiles done / total, staff detection, encoder + decoder per staff done / total), mapped
// to one 0...1 fraction weighted by typical stage time.

import Foundation

/// One progress report from `PageInferenceSession.parsePage(gray8:width:height:progress:)`.
public struct PageParseProgress: Sendable, Equatable {
    public enum Stage: String, Sendable, CaseIterable {
        case preprocess, segnet, staffs, decode, render
    }

    public var stage: Stage
    /// Units of `stage` done so far (SegNet: tiles; decode: staffs; other stages: 0 or 1).
    public var completed: Int
    public var total: Int
    /// Whole-parse progress 0...1 (`PageParseProgress.fraction(stage:completed:total:)`).
    public var fraction: Double

    public init(stage: Stage, completed: Int, total: Int) {
        self.stage = stage
        self.completed = completed
        self.total = total
        fraction = Self.fraction(stage: stage, completed: completed, total: total)
    }

    /// Stage weights (sum 1), from a 24 s iPhone parse (docs/plans/segnet-tile-batching.md: preprocess=298
    /// segnet=12013 staffs=700 decode=10822 render=1 ms), rounded so fast stages still move the bar.
    public static let weights: [(stage: Stage, weight: Double)] = [
        (.preprocess, 0.02), (.segnet, 0.49), (.staffs, 0.04), (.decode, 0.44), (.render, 0.01),
    ]

    /// Fraction of the whole parse when `completed` of `total` units of `stage` are done (earlier stages count
    /// in full). Non-decreasing along the pipeline order; 1.0 once `render` is complete.
    public static func fraction(stage: Stage, completed: Int, total: Int) -> Double {
        var before = 0.0
        for (s, w) in weights {
            if s == stage {
                let part = total > 0 ? Double(min(max(completed, 0), total)) / Double(total) : 1
                return min(1, before + w * part)
            }
            before += w
        }
        return 1
    }
}

public typealias PageParseProgressHandler = @Sendable (PageParseProgress) -> Void
