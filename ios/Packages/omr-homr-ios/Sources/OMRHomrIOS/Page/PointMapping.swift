// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ dda4d2ffe4410a360e18251936884eba9a41c321 (AGPL-3.0), "Write input image
// positions of notes": homr/point_mapping.py (undo_crop, undo_resize, chain),
// homr/staff_dewarping.py (PiecewiseAffineTransform.inverse_transform_point, _is_point_in_triangle),
// homr/staff_parsing.py (prepare_staff_image's to_page chain, _canvas_y_offset, _get_symbol_center,
// parse_staff_image filling image_coordinates) and homr/main.py (undo_resize + undo_crop for autocrop).
// Snapping to SegNet notehead boxes and the box size are this app's additions (not in homr).

import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A point in some image's pixel space (x right, y down).
public struct PagePoint: Equatable, Sendable, Codable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// homr `point_mapping`: inverse image transformations, composed with `chain`.
public enum PointMapping {
    /// `undo_crop(x, y)`: inverse of cropping at top-left `(x, y)` (pasting at (x, y) is a crop at (-x, -y)).
    public static func undoCrop(_ p: PagePoint, x: Double, y: Double) -> PagePoint { PagePoint(x: p.x + x, y: p.y + y) }

    /// `undo_resize(shape_before, shape_after)` with sizes as (width, height).
    public static func undoResize(_ p: PagePoint, before: (w: Int, h: Int), after: (w: Int, h: Int)) -> PagePoint {
        let sx = Double(after.w) / Double(before.w), sy = Double(after.h) / Double(before.h)
        return PagePoint(x: p.x / sx, y: p.y / sy)
    }
}

/// homr `prepare_staff_image`'s `to_page`: transformer canvas (1280x256) point -> preprocessed page point.
///
///     to_page = chain(undo_crop(0, -_canvas_y_offset(content_h)), undo_resize(before_canvas, content),
///                     undo_crop2, dewarp.undewarp_point, undo_crop1, undo_scaling)
public struct StaffToPageMapping: Sendable {
    /// Page (preprocessed) size and the resized page the staff was cut from.
    var pageSize: (w: Int, h: Int)
    var scaledSize: (w: Int, h: Int)
    /// Top-left of crop 1 (region ± 10 / 50 px, in the resized page) and crop 2 (region, in crop 1).
    var crop1: (x: Int, y: Int)
    var crop2: (x: Int, y: Int)
    /// Dewarp of crop 1 (nil when homr's dewarp failed: identity).
    var dewarp: StaffPrepare.PiecewiseAffine?
    /// Staff image before `center_image_on_canvas` and the size it is resized to on the canvas.
    var beforeCanvas: (w: Int, h: Int)
    var canvasContent: (w: Int, h: Int)

    /// `_canvas_y_offset(resized_height)` = (256 - h) // 2.
    var canvasYOffset: Int { (StaffInputSpec.maxHeight - canvasContent.h) / 2 }

    public func toPage(_ canvasPoint: PagePoint) -> PagePoint {
        var p = PointMapping.undoCrop(canvasPoint, x: 0, y: -Double(canvasYOffset))
        if beforeCanvas.w > 0, beforeCanvas.h > 0 {
            p = PointMapping.undoResize(p, before: beforeCanvas, after: canvasContent)
        }
        p = PointMapping.undoCrop(p, x: Double(crop2.x), y: Double(crop2.y))
        if let dewarp { p = dewarp.inverseTransform(p) }
        p = PointMapping.undoCrop(p, x: Double(crop1.x), y: Double(crop1.y))
        return PointMapping.undoResize(p, before: pageSize, after: scaledSize)
    }
}

extension StaffPrepare.PiecewiseAffine {
    /// `_is_point_in_triangle` (float64 cross products, boundary counts as inside).
    static func isPoint(_ p: PagePoint, inTriangle t: [CVGeometry.Point2f]) -> Bool {
        func cross(_ a: CVGeometry.Point2f, _ b: CVGeometry.Point2f) -> Double {
            (Double(b.x) - Double(a.x)) * (p.y - Double(a.y)) - (Double(b.y) - Double(a.y)) * (p.x - Double(a.x))
        }
        let d1 = cross(t[0], t[1]), d2 = cross(t[1], t[2]), d3 = cross(t[2], t[0])
        let neg = d1 < 0 || d2 < 0 || d3 < 0
        let pos = d1 > 0 || d2 > 0 || d3 > 0
        return !(neg && pos)
    }

    /// `inverse_transform_point`: first valid triangle (triangulation order) whose destination corners
    /// contain the point, mapped back with the inverse of its source -> destination affine; outside the
    /// mesh the point is returned unchanged.
    func inverseTransform(_ p: PagePoint) -> PagePoint {
        for (si, s) in simplices.enumerated() where valid[si] {
            let dt = s.map { dst[$0] }
            guard Self.isPoint(p, inTriangle: dt) else { continue }
            let m = CVGeometry.getAffineTransform(s.map { src[$0] }, dt) // 2x3, src -> dst
            guard let inv = Self.invertAffine(m) else { continue }
            return PagePoint(x: inv[0] * p.x + inv[1] * p.y + inv[2], y: inv[3] * p.x + inv[4] * p.y + inv[5])
        }
        return p
    }

    /// Forward `transform_point` for a point inside the source mesh (tests: round trip).
    func forwardTransform(_ p: PagePoint) -> PagePoint {
        for (si, s) in simplices.enumerated() where valid[si] {
            let st = s.map { src[$0] }
            guard Self.isPoint(p, inTriangle: st) else { continue }
            let m = CVGeometry.getAffineTransform(st, s.map { dst[$0] })
            return PagePoint(x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5])
        }
        return p
    }

    /// `cv2.invertAffineTransform` for a row-major 2x3 matrix.
    static func invertAffine(_ m: [Double]) -> [Double]? {
        let det = m[0] * m[4] - m[1] * m[3]
        guard det != 0, det.isFinite else { return nil }
        let d = 1 / det
        let a11 = m[4] * d, a12 = -m[1] * d, a21 = -m[3] * d, a22 = m[0] * d
        return [a11, a12, -(a11 * m[2] + a12 * m[5]), a21, a22, -(a21 * m[2] + a22 * m[5])]
    }
}

public extension EncodedSymbol {
    /// homr `_get_symbol_center`: the decoder's attention center `(x, y)` on the 1280x256 staff canvas
    /// (`attention` output, 2 x float32), nil for `chord` separators, missing or NaN values.
    var attentionCenter: PagePoint? {
        if rhythm.hasPrefix("chord") { return nil }
        guard let d = attentionPayload, d.count >= 8 else { return nil }
        let v: [Float] = d.withUnsafeBytes { raw in
            (0..<2).map { Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))) }
        }
        guard v[0].isFinite, v[1].isFinite else { return nil }
        return PagePoint(x: Double(v[0]), y: Double(v[1]))
    }
}

/// Page -> input image: homr `chain(undo_resize(cropped_shape, preprocessed_shape), undo_crop(*crop_top_left))`.
public struct PageToInputMapping: Sendable, Equatable {
    public var crop: PagePipeline.Rect
    public var pageWidth: Int
    public var pageHeight: Int

    public func toInput(_ p: PagePoint) -> PagePoint {
        let q = PointMapping.undoResize(p, before: (crop.width, crop.height), after: (pageWidth, pageHeight))
        return PointMapping.undoCrop(q, x: Double(crop.x), y: Double(crop.y))
    }

    /// Input pixels per page pixel (x, y).
    public var scale: (x: Double, y: Double) {
        (Double(crop.width) / Double(pageWidth), Double(crop.height) / Double(pageHeight))
    }
}

/// `NoteBoxProvider` from the decoder's attention: each note's page point (`EncodedSymbol.pagePoint`) is
/// snapped to the nearest SegNet notehead box within `snapRadius` (else a notehead-sized box centered on
/// the point), then mapped to input-image pixels. Notes without an attention point get no box.
public struct AttentionNoteBoxProvider: NoteBoxProvider, Sendable {
    /// SegNet notehead boxes `[cx, cy, w, h, angle]` in preprocessed page pixels (`PageStaffLayout.symbols["noteheads"]`).
    public var noteheads: [[Double]]
    public var noteheadHeight: Double
    public var toInput: PageToInputMapping

    public init(noteheads: [[Double]], noteheadHeight: Double, toInput: PageToInputMapping) {
        self.noteheads = noteheads
        self.noteheadHeight = noteheadHeight > 0 && noteheadHeight.isFinite ? noteheadHeight : 12
        self.toInput = toInput
    }

    /// Max distance (page px) from the attention point to a notehead center for a snap.
    public var snapRadius: Double { 2.5 * noteheadHeight }

    /// Page-space box for a point: the snapped notehead's axis-aligned box, or a default-size box.
    public func pageBox(around p: PagePoint) -> (x: Double, y: Double, w: Double, h: Double, snapped: Bool) {
        var best: [Double]?
        var bestD = snapRadius * snapRadius
        for b in noteheads where b.count >= 4 {
            let dx = b[0] - p.x, dy = b[1] - p.y
            let d = dx * dx + dy * dy
            if d <= bestD { bestD = d; best = b }
        }
        if let b = best {
            // cv2 RotatedRect (w, h, angle). A single notehead is roughly round; a chord's touching
            // noteheads merge into one elongated blob, so each note keeps the blob's x and its own y.
            let big = max(b[2], b[3]), small = min(b[2], b[3])
            if big <= 1.7 * small {
                let side = max(big, 0.5 * noteheadHeight)
                return (b[0] - side / 2, b[1] - side / 2, side, side, true)
            }
            let side = max(1.2 * small, 4)
            let half = big / 2
            let y = min(max(p.y, b[1] - half), b[1] + half)
            return (b[0] - side / 2, y - side / 2, side, side, true)
        }
        let side = 1.4 * noteheadHeight
        return (p.x - side / 2, p.y - side / 2, side, side, false)
    }

    public func pageRect(forSymbolAt symbolIndex: Int, symbol: EncodedSymbol) -> CGRect? {
        guard let p = symbol.pagePoint else { return nil }
        let b = pageBox(around: p)
        let o = toInput.toInput(PagePoint(x: b.x, y: b.y))
        let s = toInput.scale
        return CGRect(x: o.x, y: o.y, width: b.w * s.x, height: b.h * s.y)
    }
}
