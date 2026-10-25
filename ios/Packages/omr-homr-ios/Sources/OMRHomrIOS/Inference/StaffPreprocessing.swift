// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0):
//   homr/staff_parsing.py      get_tr_omr_canvas_size, center_image_on_canvas, add_image_into_tr_omr_canvas
//   homr/transformer/staff2score.py  ConvertToArray (_transform)
// plus the two OpenCV primitives those call: cv2.resize(INTER_LINEAR, CV_8UC1) and
// cv2.cvtColor(COLOR_BGR2GRAY, CV_8U). Pure Swift (no UIKit / CoreGraphics), so it runs on Linux.
import Foundation

/// homr staff preprocessing: grayscale staff crop → 256×1280 white canvas → normalized fp32 tensor.
public enum StaffPreprocessing {
    public enum Error: Swift.Error, Equatable, CustomStringConvertible {
        case badImage(width: Int, height: Int, pixelCount: Int, channels: Int)
        case badTarget(width: Int, height: Int)

        public var description: String {
            switch self {
            case .badImage(let w, let h, let n, let c):
                return "StaffPreprocessing: \(n) pixels for \(w)x\(h)x\(c)"
            case .badTarget(let w, let h):
                return "StaffPreprocessing: resize target \(w)x\(h) does not fit the \(StaffInputSpec.maxWidth)x\(StaffInputSpec.maxHeight) canvas"
            }
        }
    }

    /// `get_tr_omr_canvas_size(image_shape, margin_top, margin_bottom)`: aspect-fit size `(width, height)`
    /// inside `1280 × (256 - margins)`. Same float64 comparison and `int()` truncation as homr.
    public static func canvasSize(width: Int, height: Int, marginTop: Int = 0, marginBottom: Int = 0) -> (width: Int, height: Int) {
        let maxH = StaffInputSpec.maxHeight - marginTop - marginBottom
        let maxW = StaffInputSpec.maxWidth
        let ratio = Double(maxH) / Double(maxW)
        if Double(height) / Double(width) > ratio {
            return (Int(Double(width) / Double(height) * Double(maxH)), maxH) // height limits
        }
        return (maxW, Int(Double(height) / Double(width) * Double(maxW))) // width limits
    }

    /// `center_image_on_canvas(image, canvas_size)` for a grayscale image: `cv2.resize` (INTER_LINEAR) to
    /// `target`, then paste onto a 255-filled 256×1280 canvas at x = 0, y = (256 - h) // 2.
    /// homr calls this with a precomputed `target` in `prepare_staff_image` (may stretch), and with
    /// `canvasSize(...)` of the image itself in `add_image_into_tr_omr_canvas`.
    public static func centerOnCanvas(
        grayscale pixels: [UInt8], width: Int, height: Int, targetWidth: Int, targetHeight: Int
    ) throws -> [UInt8] {
        let cw = StaffInputSpec.maxWidth, ch = StaffInputSpec.maxHeight
        guard targetWidth > 0, targetHeight > 0, targetWidth <= cw, targetHeight <= ch else {
            throw Error.badTarget(width: targetWidth, height: targetHeight)
        }
        let resized = try resizeLinear(grayscale: pixels, width: width, height: height,
                                       toWidth: targetWidth, toHeight: targetHeight)
        var canvas = [UInt8](repeating: 255, count: cw * ch)
        let y0 = (ch - targetHeight) / 2 // Python // on non-negative ints
        for y in 0..<targetHeight {
            let src = y * targetWidth, dst = (y0 + y) * cw
            for x in 0..<targetWidth { canvas[dst + x] = resized[src + x] }
        }
        return canvas
    }

    /// `add_image_into_tr_omr_canvas(image)`: aspect-fit + center (left-aligned) on the 256×1280 canvas.
    public static func canvas(grayscale pixels: [UInt8], width: Int, height: Int) throws -> [UInt8] {
        guard width > 0, height > 0, pixels.count == width * height else {
            throw Error.badImage(width: width, height: height, pixelCount: pixels.count, channels: 1)
        }
        let t = canvasSize(width: width, height: height)
        return try centerOnCanvas(grayscale: pixels, width: width, height: height,
                                  targetWidth: t.width, targetHeight: t.height)
    }

    /// `ConvertToArray`: `((px / 255) - 0.7931) / 0.1738` computed in float64 (numpy), then cast to fp32.
    /// A 256-entry table, so every pixel maps to the bit-identical float numpy produces.
    public static let normalizationTable: [Float] = (0..<256).map { (p: Int) -> Float in
        let unit: Double = Double(p) / 255.0
        let z: Double = (unit - 0.7931) / 0.1738
        return Float(z)
    }

    /// cv2.cvtColor(COLOR_BGR2GRAY / RGB2GRAY) for 8-bit: `(R*9798 + G*19235 + B*3735 + 16384) >> 15`
    /// (OpenCV `color_rgb` fixed point; checked bit-exact against cv2 5.0.0).
    /// `channels` 3 or 4 (alpha ignored, as `cv2.imread(IMREAD_COLOR)` drops it); `bgr` selects byte order.
    public static func grayscale(interleaved pixels: [UInt8], width: Int, height: Int, channels: Int, bgr: Bool = false) throws -> [UInt8] {
        guard width > 0, height > 0, channels == 3 || channels == 4, pixels.count == width * height * channels else {
            throw Error.badImage(width: width, height: height, pixelCount: pixels.count, channels: channels)
        }
        let n = width * height
        var out = [UInt8](repeating: 0, count: n)
        let ri = bgr ? 2 : 0, bi = bgr ? 0 : 2
        for i in 0..<n {
            let o = i * channels
            let r: Int = Int(pixels[o + ri]) * 9798
            let g: Int = Int(pixels[o + 1]) * 19235
            let b: Int = Int(pixels[o + bi]) * 3735
            let sum: Int = r + g + b + 16384
            out[i] = UInt8(sum >> 15)
        }
        return out
    }

    // MARK: - cv2.resize(src, (w, h)) — INTER_LINEAR, CV_8UC1

    static let coefBits = 11 // INTER_RESIZE_COEF_BITS
    static let coefScale = 1 << coefBits

    /// Port of OpenCV's `resize` for `INTER_LINEAR` on 8-bit single-channel images (modules/imgproc
    /// resize.cpp, generic fixed-point path): pixel-center mapping `(d + 0.5) * scale - 0.5` in float,
    /// edge clamp, 11-bit short weights (`saturate_cast<short>` = round-half-even), int horizontal pass,
    /// and the 8-bit vertical pass of the `VResizeLinear<uchar, int, short, ...>` specialization
    /// (`VResizeLinearVec_32s8u` + identical scalar tail). Checked bit-exact against cv2 5.0.0.
    /// Same size = copy (OpenCV short-circuits), exact 2× downscale = INTER_AREA (identical result).
    public static func resizeLinear(grayscale src: [UInt8], width sw: Int, height sh: Int, toWidth dw: Int, toHeight dh: Int) throws -> [UInt8] {
        try resizeLinearWindow(grayscale: src, width: sw, height: sh, toWidth: dw, toHeight: dh,
                               x0: 0, y0: 0, x1: dw, y1: dh)
    }

    /// `cv2.resize(src, (dw, dh))[y0:y1, x0:x1]` without materializing the whole resized image: every
    /// output pixel of the INTER_LINEAR kernel depends only on its own taps and weights, so the window is
    /// byte-identical to cropping the full result (used by `StaffPrepare` on full pages).
    static func resizeLinearWindow(grayscale src: [UInt8], width sw: Int, height sh: Int, toWidth dw: Int, toHeight dh: Int,
                                   x0: Int, y0: Int, x1: Int, y1: Int) throws -> [UInt8] {
        guard sw > 0, sh > 0, src.count == sw * sh else {
            throw Error.badImage(width: sw, height: sh, pixelCount: src.count, channels: 1)
        }
        guard dw > 0, dh > 0 else { throw Error.badTarget(width: dw, height: dh) }
        precondition(0 <= x0 && x0 <= x1 && x1 <= dw && 0 <= y0 && y0 <= y1 && y1 <= dh, "bad resize window")
        let ow = x1 - x0, oh = y1 - y0
        if sw == dw && sh == dh {
            if x0 == 0 && y0 == 0 && ow == dw && oh == dh { return src }
            var out = [UInt8](repeating: 0, count: ow * oh)
            for y in 0..<oh { for x in 0..<ow { out[y * ow + x] = src[(y0 + y) * sw + x0 + x] } }
            return out
        }

        let scaleX = 1.0 / (Double(dw) / Double(sw))
        let scaleY = 1.0 / (Double(dh) / Double(sh))

        var xofs = [Int](repeating: 0, count: dw)
        var alpha = [Int32](repeating: 0, count: dw * 2)
        var xmax = dw
        for dx in 0..<dw {
            var fx = Float((Double(dx) + 0.5) * scaleX - 0.5)
            var sx = Int(fx.rounded(.down))
            fx -= Float(sx)
            if sx < 0 { fx = 0; sx = 0 }
            if sx + 1 >= sw {
                xmax = min(xmax, dx)
                if sx >= sw - 1 { fx = 0; sx = sw - 1 }
            }
            xofs[dx] = sx
            alpha[dx * 2] = Int32(saturateShort((1 - fx) * Float(coefScale)))
            alpha[dx * 2 + 1] = Int32(saturateShort(fx * Float(coefScale)))
        }

        // Horizontal pass cache: one Int32 row (window columns only) per source row that is used.
        func hrow(_ sy: Int) -> [Int32] {
            var row = [Int32](repeating: 0, count: ow)
            let base = sy * sw
            for i in 0..<ow {
                let dx = x0 + i
                let sx = xofs[dx]
                if dx < xmax {
                    row[i] = Int32(src[base + sx]) * alpha[dx * 2] + Int32(src[base + sx + 1]) * alpha[dx * 2 + 1]
                } else {
                    row[i] = Int32(src[base + sx]) * Int32(coefScale)
                }
            }
            return row
        }
        var cache: [Int: [Int32]] = [:]
        func cached(_ sy: Int) -> [Int32] {
            if let r = cache[sy] { return r }
            let r = hrow(sy)
            if cache.count > 4 { cache.removeAll(keepingCapacity: true) }
            cache[sy] = r
            return r
        }

        var dst = [UInt8](repeating: 0, count: ow * oh)
        for j in 0..<oh {
            let dy = y0 + j
            var fy = Float((Double(dy) + 0.5) * scaleY - 0.5)
            let sy = Int(fy.rounded(.down))
            fy -= Float(sy)
            let b0 = Int32(saturateShort((1 - fy) * Float(coefScale)))
            let b1 = Int32(saturateShort(fy * Float(coefScale)))
            let s0 = cached(min(max(sy, 0), sh - 1))
            let s1 = cached(min(max(sy + 1, 0), sh - 1))
            let o = j * ow
            // VResizeLinear<uchar, int, short, ...> specialization: the SIMD body and its scalar tail
            // both compute ((b0*(S0>>4))>>16) + ((b1*(S1>>4))>>16) + 2) >> 2 (not FixedPtCast<22>).
            for x in 0..<ow {
                let a = (b0 * (s0[x] >> 4)) >> 16
                let b = (b1 * (s1[x] >> 4)) >> 16
                dst[o + x] = UInt8(truncatingIfNeeded: (a + b + 2) >> 2)
            }
        }
        return dst
    }

    /// `saturate_cast<short>(float)`: cvRound (round half to even) then clamp.
    @inline(__always) static func saturateShort(_ v: Float) -> Int16 {
        let r = v.rounded(.toNearestOrEven)
        return Int16(max(-32768, min(32767, r)))
    }
}

extension StaffTensor {
    /// homr staff preprocessing: `add_image_into_tr_omr_canvas` (aspect-fit, cv2 INTER_LINEAR resize,
    /// white 256×1280 canvas, left-aligned, vertically centered) → `ConvertToArray`
    /// (`(px/255 - 0.7931) / 0.1738`, fp32 NCHW `[1, 1, 256, 1280]`).
    /// A 1280×256 input (already a homr canvas, e.g. `fixtures/oracle.c_scale_staff/staff.png`)
    /// passes through the resize unchanged, as in OpenCV.
    /// - Parameter pixels: 8-bit grayscale, row-major, `width * height` bytes. For RGB(A) input use
    ///   `StaffPreprocessing.grayscale(interleaved:width:height:channels:)` first (cv2 BGR2GRAY weights).
    public static func fromStaffImage(grayscale pixels: [UInt8], width: Int, height: Int) throws -> StaffTensor {
        let canvas = try StaffPreprocessing.canvas(grayscale: pixels, width: width, height: height)
        return try fromCanvas(canvas)
    }

    /// `ConvertToArray` only: a ready 256×1280 grayscale canvas → normalized tensor.
    public static func fromCanvas(_ canvas: [UInt8]) throws -> StaffTensor {
        let n = StaffInputSpec.maxWidth * StaffInputSpec.maxHeight
        guard canvas.count == n else { throw LoadError.valueCount(expected: n, got: canvas.count) }
        let table = StaffPreprocessing.normalizationTable
        return try StaffTensor(values: canvas.map { table[Int($0)] }, shape: StaffInputSpec.nchwShape)
    }
}

/// Element-wise comparison of two staff tensors (preprocessing gate).
public struct StaffTensorDiff: Sendable {
    /// One 8-bit gray level after `ConvertToArray`, measured on the fp32 values the tensor actually holds:
    /// the largest step between adjacent `normalizationTable` entries (nominally `1 / (255 * 0.1738)` ≈
    /// 0.0225637; fp32 rounding of the two endpoints makes some steps up to ~1e-7 larger, e.g. 0.0225637555).
    /// The preprocessing gate allows at most this much per element: a single ±1 gray-level rounding
    /// difference in a resized pixel is tolerated; anything larger (wrong kernel, offset, gamma, dtype) is not.
    public static let oneGrayLevel: Double = {
        let t = StaffPreprocessing.normalizationTable
        return (1..<t.count).map { Double(t[$0]) - Double(t[$0 - 1]) }.max()!
    }()

    public let count: Int
    public let maxAbs: Double
    public let meanAbs: Double
    public let countAbove1e3: Int

    public init(_ a: StaffTensor, _ b: StaffTensor) {
        precondition(a.shape == b.shape && a.values.count == b.values.count, "shape mismatch")
        var mx = 0.0, sum = 0.0, above = 0
        for i in 0..<a.values.count {
            let d = abs(Double(a.values[i]) - Double(b.values[i]))
            if d > mx { mx = d }
            sum += d
            if d > 1e-3 { above += 1 }
        }
        count = a.values.count
        maxAbs = mx
        meanAbs = count > 0 ? sum / Double(count) : 0
        countAbove1e3 = above
    }

    public var withinOneGrayLevel: Bool { maxAbs <= Self.oneGrayLevel }
}
