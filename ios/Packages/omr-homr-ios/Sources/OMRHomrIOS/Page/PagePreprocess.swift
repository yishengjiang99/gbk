// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0):
//   homr/autocrop.py      autocrop
//   homr/resize.py        calc_target_image_size, resize_image (PIL Image.resize, BICUBIC)
//   homr/color_adjust.py  apply_clahe (cv2.createCLAHE(clipLimit=1.0, tileGridSize=(8, 8)))
//   homr/main.py          load_and_preprocess_predictions: autocrop -> resize_image -> apply_clahe
// Library code ported for bit-exactness: Pillow 12.3.0 libImaging/Resample.c (8bpc bicubic, MIT-CMU),
// OpenCV 5.0.0 imgproc clahe.cpp / morph (rect kernels) / threshold / calcHist (Apache-2.0).
//
// Gray input only: homr reads BGR, and for a gray source (all fixtures) every step here equals homr's
// BGR path exactly (BGR2GRAY of equal channels is identity; calcHist uses channel 0). For a color photo
// converted to gray by the caller this is an approximation of homr (it resizes color and histograms the
// blue channel), documented on `OMRHomrIOS.parseSheetMusicWithLayout(gray8:width:height:)`.

import Foundation

/// Read-only 8-bit single-channel view (row-major, `stride` bytes per row, `pixelStride` bytes between
/// pixels: 1 for gray, 3 / 4 for one channel of interleaved color) over caller memory. Never copies.
struct GrayPlane {
    let base: UnsafePointer<UInt8>
    let width: Int
    let height: Int
    let stride: Int
    var pixelStride: Int = 1

    @inline(__always) func row(_ y: Int) -> UnsafePointer<UInt8> { base + y * stride }
    @inline(__always) func at(_ row: UnsafePointer<UInt8>, _ x: Int) -> UInt8 { row[x * pixelStride] }

    func cropped(x: Int, y: Int, width w: Int, height h: Int) -> GrayPlane {
        GrayPlane(base: base + y * stride + x * pixelStride, width: w, height: h, stride: stride, pixelStride: pixelStride)
    }
}

/// Read-only interleaved 8-bit color view (RGB / RGBA / BGRA ... : `bytesPerPixel` bytes per pixel and
/// the byte offsets of R, G and B inside a pixel).
struct ColorPlane {
    let base: UnsafePointer<UInt8>
    let width: Int
    let height: Int
    let stride: Int
    let bytesPerPixel: Int
    let offsets: (r: Int, g: Int, b: Int)

    func channel(_ offset: Int) -> GrayPlane {
        GrayPlane(base: base + offset, width: width, height: height, stride: stride, pixelStride: bytesPerPixel)
    }
}

enum PagePreprocess {
    struct Rect: Equatable, Codable {
        var x: Int
        var y: Int
        var width: Int
        var height: Int
    }

    struct Output {
        /// homr `autocrop` result in input coordinates (full image when no crop).
        var crop: Rect
        var cropped: Bool
        /// `resize_image` output (1920 wide), gray.
        var resized: [UInt8]
        /// `apply_clahe(resized)`: SegNet input and the page the staffs are cut from.
        var preprocessed: [UInt8]
        var width: Int
        var height: Int
    }

    static let targetWidth = 1920

    /// homr `calc_target_image_size`: width 1920, height `round(h * 1920 / w)` (Python round-half-even
    /// on the float64 product).
    static func targetSize(width: Int, height: Int) -> (Int, Int) {
        if width == targetWidth { return (width, height) }
        let ratio = Double(targetWidth) / Double(width)
        let th = (Double(height) * ratio).rounded(.toNearestOrEven)
        return (targetWidth, Int(th))
    }

    /// autocrop -> resize -> CLAHE. The only full-resolution allocation is autocrop's binary mask
    /// (w+2)*(h+2) bytes (freed before resizing); the resize reads the caller's memory directly and the
    /// horizontal pass writes only 1920-wide rows.
    static func run(_ src: GrayPlane) -> Output {
        let crop = autocropRect(src)
        let page = src.cropped(x: crop.x, y: crop.y, width: crop.width, height: crop.height)
        let (tw, th) = targetSize(width: page.width, height: page.height)
        let resized = PILResize.bicubic(page, outWidth: tw, outHeight: th)
        let pre = CLAHE.apply(resized, width: tw, height: th, clipLimit: 1.0, tilesX: 8, tilesY: 8)
        let full = crop == Rect(x: 0, y: 0, width: src.width, height: src.height)
        return Output(crop: crop, cropped: !full, resized: resized, preprocessed: pre, width: tw, height: th)
    }

    /// homr on a color page (`cv2.imread` BGR): autocrop thresholds BGR2GRAY and histograms the blue
    /// channel; `resize_image` resizes all three channels (Pillow, per channel exactly like L); then
    /// `apply_clahe` converts the resized page with BGR2GRAY. For a gray image (R = G = B) this equals
    /// `run(_:)` byte for byte.
    static func run(color src: ColorPlane) -> Output {
        let w = src.width, h = src.height
        var crop = Rect(x: 0, y: 0, width: w, height: h)
        do {
            var gray = [UInt8](repeating: 0, count: w * h)
            gray.withUnsafeMutableBufferPointer { g in
                for y in 0..<h {
                    let row = src.base + y * src.stride
                    let o = g.baseAddress! + y * w
                    for x in 0..<w {
                        let p = row + x * src.bytesPerPixel
                        o[x] = bgr2gray(r: p[src.offsets.r], g: p[src.offsets.g], b: p[src.offsets.b])
                    }
                }
            }
            gray.withUnsafeBufferPointer { g in
                crop = autocropRect(GrayPlane(base: g.baseAddress!, width: w, height: h, stride: w),
                                    histogram: src.channel(src.offsets.b))
            }
        }
        let (tw, th) = targetSize(width: crop.width, height: crop.height)
        func resized(_ off: Int) -> [UInt8] {
            PILResize.bicubic(src.channel(off).cropped(x: crop.x, y: crop.y, width: crop.width, height: crop.height),
                              outWidth: tw, outHeight: th)
        }
        let rr = resized(src.offsets.r), gg = resized(src.offsets.g), bb = resized(src.offsets.b)
        var page = [UInt8](repeating: 0, count: tw * th)
        for i in 0..<page.count { page[i] = bgr2gray(r: rr[i], g: gg[i], b: bb[i]) }
        let pre = CLAHE.apply(page, width: tw, height: th, clipLimit: 1.0, tilesX: 8, tilesY: 8)
        let full = crop == Rect(x: 0, y: 0, width: w, height: h)
        return Output(crop: crop, cropped: !full, resized: page, preprocessed: pre, width: tw, height: th)
    }

    /// OpenCV `cvtColor(COLOR_BGR2GRAY)` for 8U (fixed point, as `PNGImage.grayscale()`).
    @inline(__always) static func bgr2gray(r: UInt8, g: UInt8, b: UInt8) -> UInt8 {
        let rv: Int = Int(r) * 9798
        let gv: Int = Int(g) * 19235
        let bv: Int = Int(b) * 3735
        let sum: Int = rv + gv + bv + 16384
        return UInt8(sum >> 15)
    }

    /// `np.argmax(cv2.calcHist([plane], [0], None, [256], [0, 256]))` (first maximum).
    static func dominantValue(_ src: GrayPlane) -> Int {
        var hist = [Int](repeating: 0, count: 256)
        for y in 0..<src.height {
            let r = src.row(y)
            for x in 0..<src.width { hist[Int(src.at(r, x))] += 1 }
        }
        var dominant = 0
        for v in 1..<256 where hist[v] > hist[dominant] { dominant = v }
        return dominant
    }

    // MARK: - autocrop

    /// homr `autocrop`: returns the crop rect (the whole image when homr returns `img` unchanged).
    /// `histogram`: the plane homr's `calcHist([img], [0])` reads (channel 0 = blue of a BGR image);
    /// default `src` (gray input).
    static func autocropRect(_ src: GrayPlane, histogram: GrayPlane? = nil) -> Rect {
        let w = src.width, h = src.height
        let full = Rect(x: 0, y: 0, width: w, height: h)
        let dominant = dominantValue(histogram ?? src)
        // cv2.threshold(gray, dominant - 30, 255, THRESH_BINARY): v > floor(thresh)
        let thresh = dominant - 30
        let pw = w + 2
        var mask = [Int8](repeating: 0, count: pw * (h + 2))
        mask.withUnsafeMutableBufferPointer { m in
            for y in 0..<h {
                let r = src.row(y)
                let o = (y + 1) * pw + 1
                for x in 0..<w where Int(src.at(r, x)) > thresh { m[o + x] = 1 }
            }
            let interior = m.baseAddress! + pw + 1
            // morphologyEx(MORPH_CLOSE, ones 7x7) = dilate then erode; then MORPH_ERODE ones 9x9.
            BinaryMorph.rect(interior, width: w, height: h, stride: pw, kw: 7, kh: 7, erode: false)
            BinaryMorph.rect(interior, width: w, height: h, stride: pw, kw: 7, kh: 7, erode: true)
            BinaryMorph.rect(interior, width: w, height: h, stride: pw, kw: 9, kh: 9, erode: true)
        }
        let contours = CVContours.find(padded: &mask, width: w, height: h, mode: .external)
        mask = []
        var best: [CVContours.Point]?
        var areaThresh = 0.0
        for c in contours {
            let a = CVContours.contourArea(c)
            if a > areaThresh {
                areaThresh = a
                best = c
            }
        }
        guard let big = best else { return full }
        let r = CVContours.boundingRect(big)
        let limitX = Double(w) * 0.25
        let limitY = Double(h) * 0.25
        if Double(r.x) < limitX || Double(r.y) < limitY { return full }
        return Rect(x: r.x, y: r.y, width: r.width, height: r.height)
    }
}

// MARK: - binary morphology (0/1 Int8) with rectangular kernels

/// cv2.dilate / cv2.erode with a `kw x kh` all-ones kernel, default anchor (kw/2, kh/2), iterations 1,
/// BORDER_CONSTANT with `morphologyDefaultBorderValue` (out-of-image pixels never win). For 0/1 data
/// max/min over the window equals "any one" / "all ones" over its in-image part, computed separably
/// with running counts, in place, with O(width * kh) scratch.
enum BinaryMorph {
    static func rect(_ p: UnsafeMutablePointer<Int8>, width w: Int, height h: Int, stride: Int,
                     kw: Int, kh: Int, erode: Bool) {
        guard w > 0, h > 0 else { return }
        let ax = kw / 2, bx = kw - 1 - ax
        let ay = kh / 2, by = kh - 1 - ay
        // horizontal pass
        var line = [Int8](repeating: 0, count: w)
        line.withUnsafeMutableBufferPointer { l in
            for y in 0..<h {
                let r = p + y * stride
                for x in 0..<w { l[x] = r[x] }
                var count = 0
                // window for x = 0: [0, bx]
                for x in 0...min(bx, w - 1) { count += Int(l[x]) }
                for x in 0..<w {
                    let lo = max(0, x - ax), hi = min(w - 1, x + bx)
                    let n = hi - lo + 1
                    r[x] = erode ? (count == n ? 1 : 0) : (count > 0 ? 1 : 0)
                    let leaving = x - ax
                    if leaving >= 0 { count -= Int(l[leaving]) }
                    let entering = x + bx + 1
                    if entering < w { count += Int(l[entering]) }
                }
            }
        }
        // vertical pass: ring of original rows (row r lives in slot r % k)
        let k = ay + by + 1
        var ring = [Int8](repeating: 0, count: k * w)
        var col = [Int32](repeating: 0, count: w)
        ring.withUnsafeMutableBufferPointer { rg in
            col.withUnsafeMutableBufferPointer { c in
                func add(_ r: Int) {
                    let src = p + r * stride
                    let slot = rg.baseAddress! + (r % k) * w
                    for x in 0..<w {
                        slot[x] = src[x]
                        c[x] += Int32(src[x])
                    }
                }
                func remove(_ r: Int) {
                    let slot = rg.baseAddress! + (r % k) * w
                    for x in 0..<w { c[x] -= Int32(slot[x]) }
                }
                for r in 0...min(by, h - 1) { add(r) }
                for y in 0..<h {
                    let lo = max(0, y - ay), hi = min(h - 1, y + by)
                    let n = Int32(hi - lo + 1)
                    let dst = p + y * stride
                    if erode {
                        for x in 0..<w { dst[x] = c[x] == n ? 1 : 0 }
                    } else {
                        for x in 0..<w { dst[x] = c[x] > 0 ? 1 : 0 }
                    }
                    if y - ay >= 0 { remove(y - ay) }
                    if y + by + 1 < h { add(y + by + 1) }
                }
            }
        }
    }
}

// MARK: - Pillow Image.resize(BICUBIC), 8 bits per channel

enum PILResize {
    static let precisionBits = 32 - 8 - 2

    /// Pillow `bicubic_filter` (a = -0.5), support 2.
    @inline(__always) static func bicubicFilter(_ xIn: Double) -> Double {
        let a = -0.5
        let x = xIn < 0 ? -xIn : xIn
        if x < 1.0 {
            let t0 = (a + 2.0) * x - (a + 3.0)
            let t1 = t0 * x
            let t2 = t1 * x
            return t2 + 1
        }
        if x < 2.0 {
            let t0 = (x - 5) * x + 8
            let t1 = t0 * x - 4
            return t1 * a
        }
        return 0.0
    }

    struct Coeffs {
        var ksize: Int
        var bounds: [Int]   // (xmin, xmax) pairs; xmax is the tap count
        var kk: [Int32]     // normalize_coeffs_8bpc output, outSize * ksize
    }

    /// `precompute_coeffs(inSize, 0, inSize, outSize, BICUBIC)` + `normalize_coeffs_8bpc`.
    static func coeffs(inSize: Int, outSize: Int) -> Coeffs {
        let in0: Float = 0
        let in1 = Float(inSize)
        let scale = Double(in1 - in0) / Double(outSize)
        let filterscale = max(scale, 1.0)
        let support = 2.0 * filterscale
        let ksize = Int(support.rounded(.up)) * 2 + 1
        var bounds = [Int](repeating: 0, count: outSize * 2)
        var kk = [Int32](repeating: 0, count: outSize * ksize)
        var k = [Double](repeating: 0, count: ksize)
        let invFilterscale = 1.0 / filterscale
        let one = Double(1 << precisionBits)
        for xx in 0..<outSize {
            let center = Double(in0) + (Double(xx) + 0.5) * scale
            var ww = 0.0
            var xmin = Int(center - support + 0.5)   // C (int): truncation toward zero
            if xmin < 0 { xmin = 0 }
            var xmax = Int(center + support + 0.5)
            if xmax > inSize { xmax = inSize }
            xmax -= xmin
            for x in 0..<ksize { k[x] = 0 }
            for x in 0..<xmax {
                let arg = (Double(x + xmin) - center + 0.5) * invFilterscale
                let wv = bicubicFilter(arg)
                k[x] = wv
                ww += wv
            }
            if ww != 0.0 {
                for x in 0..<xmax { k[x] /= ww }
            }
            for x in 0..<ksize {
                let v = k[x] * one
                kk[xx * ksize + x] = k[x] < 0 ? Int32(-0.5 + v) : Int32(0.5 + v)
            }
            bounds[xx * 2] = xmin
            bounds[xx * 2 + 1] = xmax
        }
        return Coeffs(ksize: ksize, bounds: bounds, kk: kk)
    }

    @inline(__always) static func clip8(_ ss: Int) -> UInt8 {
        let v = ss >> precisionBits
        return v < 0 ? 0 : (v > 255 ? 255 : UInt8(v))
    }

    /// `Image.resize((outWidth, outHeight))` of an L image (ImagingResampleInner: vertical bounds first,
    /// horizontal pass over the needed source rows into a uint8 temp, then the vertical pass).
    static func bicubic(_ src: GrayPlane, outWidth: Int, outHeight: Int) -> [UInt8] {
        let needH = outWidth != src.width
        let needV = outHeight != src.height
        if !needH && !needV {
            var out = [UInt8](repeating: 0, count: outWidth * outHeight)
            for y in 0..<outHeight { for x in 0..<outWidth { out[y * outWidth + x] = src.at(src.row(y), x) } }
            return out
        }
        let cv = coeffs(inSize: src.height, outSize: outHeight)
        let yFirst = cv.bounds[0]
        let yLast = cv.bounds[outHeight * 2 - 2] + cv.bounds[outHeight * 2 - 1]
        // horizontal pass -> temp (outWidth x (yLast - yFirst)), or the source rows as-is
        var temp: [UInt8] = []
        var tempStride = outWidth
        var tempRow0 = 0
        if needH {
            let ch = coeffs(inSize: src.width, outSize: outWidth)
            let rows = yLast - yFirst
            temp = [UInt8](repeating: 0, count: outWidth * rows)
            let half = 1 << (precisionBits - 1)
            temp.withUnsafeMutableBufferPointer { t in
                ch.kk.withUnsafeBufferPointer { kk in
                    for yy in 0..<rows {
                        let lineIn = src.row(yy + yFirst)
                        let lineOut = t.baseAddress! + yy * outWidth
                        for xx in 0..<outWidth {
                            let xmin = ch.bounds[xx * 2], xmax = ch.bounds[xx * 2 + 1]
                            let kb = xx * ch.ksize
                            var ss = half
                            let ps = src.pixelStride
                            for x in 0..<xmax { ss += Int(lineIn[(x + xmin) * ps]) * Int(kk[kb + x]) }
                            lineOut[xx] = clip8(ss)
                        }
                    }
                }
            }
            tempRow0 = yFirst
        }
        guard needV else { return temp }
        var out = [UInt8](repeating: 0, count: outWidth * outHeight)
        let half = 1 << (precisionBits - 1)
        let readRow: (Int) -> UnsafePointer<UInt8>
        let colStride = needH ? 1 : src.pixelStride
        if needH {
            tempStride = outWidth
            let tp = temp.withUnsafeBufferPointer { $0.baseAddress! }
            readRow = { r in tp + (r - tempRow0) * tempStride }
        } else {
            readRow = { r in src.row(r) }
        }
        withExtendedLifetime(temp) {
            out.withUnsafeMutableBufferPointer { o in
                cv.kk.withUnsafeBufferPointer { kk in
                    var rowPtrs = [UnsafePointer<UInt8>](repeating: src.base, count: cv.ksize)
                    for yy in 0..<outHeight {
                        let ymin = cv.bounds[yy * 2], ymax = cv.bounds[yy * 2 + 1]
                        let kb = yy * cv.ksize
                        for y in 0..<ymax { rowPtrs[y] = readRow(y + ymin) }
                        let lineOut = o.baseAddress! + yy * outWidth
                        for xx in 0..<outWidth {
                            var ss = half
                            let px = xx * colStride
                            for y in 0..<ymax { ss += Int(rowPtrs[y][px]) * Int(kk[kb + y]) }
                            lineOut[xx] = clip8(ss)
                        }
                    }
                }
            }
        }
        return out
    }
}

// MARK: - CLAHE (OpenCV 5.0.0 clahe.cpp, CV_8UC1, CPU path)

enum CLAHE {
    static func apply(_ src: [UInt8], width w: Int, height h: Int, clipLimit: Double, tilesX: Int, tilesY: Int) -> [UInt8] {
        let histSize = 256
        // If either side is not a multiple of the grid, OpenCV pads BOTH sides for the LUT pass with
        // copyMakeBorder(0, tilesY - h % tilesY, 0, tilesX - w % tilesX, BORDER_REFLECT_101), i.e. a
        // side that already divides evenly still grows by a full `tiles` (1920 wide -> 1928, tile 241).
        let divisible = w % tilesX == 0 && h % tilesY == 0
        let extW = divisible ? w : w + tilesX - (w % tilesX)
        let extH = divisible ? h : h + tilesY - (h % tilesY)
        let tileW = extW / tilesX, tileH = extH / tilesY
        let tileArea = tileW * tileH
        let lutScale = Float(histSize - 1) / Float(tileArea)
        var clip = 0
        if clipLimit > 0.0 {
            clip = Int(clipLimit * Double(tileArea) / Double(histSize))
            clip = max(clip, 1)
        }
        @inline(__always) func reflect101(_ i: Int, _ n: Int) -> Int {
            if n == 1 { return 0 }
            var v = i
            while v < 0 || v >= n {
                if v < 0 { v = -v }
                if v >= n { v = 2 * n - 2 - v }
            }
            return v
        }
        var lut = [UInt8](repeating: 0, count: tilesX * tilesY * histSize)
        src.withUnsafeBufferPointer { s in
            var hist = [Int](repeating: 0, count: histSize)
            for k in 0..<(tilesX * tilesY) {
                let ty = k / tilesX, tx = k % tilesX
                for i in 0..<histSize { hist[i] = 0 }
                for yy in 0..<tileH {
                    let y = reflect101(ty * tileH + yy, h)
                    let row = y * w
                    for xx in 0..<tileW {
                        let x = reflect101(tx * tileW + xx, w)
                        hist[Int(s[row + x])] += 1
                    }
                }
                if clip > 0 {
                    var clipped = 0
                    for i in 0..<histSize where hist[i] > clip {
                        clipped += hist[i] - clip
                        hist[i] = clip
                    }
                    let redistBatch = clipped / histSize
                    var residual = clipped - redistBatch * histSize
                    for i in 0..<histSize { hist[i] += redistBatch }
                    if residual != 0 {
                        let residualStep = max(histSize / residual, 1)
                        var i = 0
                        while i < histSize && residual > 0 {
                            hist[i] += 1
                            i += residualStep
                            residual -= 1
                        }
                    }
                }
                var sum = 0
                for i in 0..<histSize {
                    sum += hist[i]
                    let v = Float(sum) * lutScale
                    lut[k * histSize + i] = saturateU8(v)
                }
            }
        }
        // interpolation
        var ind1 = [Int](repeating: 0, count: w)
        var ind2 = [Int](repeating: 0, count: w)
        var xa = [Float](repeating: 0, count: w)
        var xa1 = [Float](repeating: 0, count: w)
        let invTW: Float = 1.0 / Float(tileW)
        for x in 0..<w {
            let txf = Float(x) * invTW - 0.5
            var tx1 = Int(txf.rounded(.down))
            var tx2 = tx1 + 1
            xa[x] = txf - Float(tx1)
            xa1[x] = 1.0 - xa[x]
            tx1 = max(tx1, 0)
            tx2 = min(tx2, tilesX - 1)
            ind1[x] = tx1 * histSize
            ind2[x] = tx2 * histSize
        }
        var dst = [UInt8](repeating: 0, count: w * h)
        let invTH: Float = 1.0 / Float(tileH)
        src.withUnsafeBufferPointer { s in
            lut.withUnsafeBufferPointer { l in
                dst.withUnsafeMutableBufferPointer { d in
                    for y in 0..<h {
                        let tyf = Float(y) * invTH - 0.5
                        var ty1 = Int(tyf.rounded(.down))
                        var ty2 = ty1 + 1
                        let ya = tyf - Float(ty1)
                        let ya1: Float = 1.0 - ya
                        ty1 = max(ty1, 0)
                        ty2 = min(ty2, tilesY - 1)
                        let p1 = ty1 * tilesX * histSize
                        let p2 = ty2 * tilesX * histSize
                        for x in 0..<w {
                            let v = Int(s[y * w + x])
                            let a1 = Float(l[p1 + ind1[x] + v]) * xa1[x]
                            let b1 = Float(l[p1 + ind2[x] + v]) * xa[x]
                            let a2 = Float(l[p2 + ind1[x] + v]) * xa1[x]
                            let b2 = Float(l[p2 + ind2[x] + v]) * xa[x]
                            let top: Float = (a1 + b1) * ya1
                            let bottom: Float = (a2 + b2) * ya
                            d[y * w + x] = saturateU8(top + bottom)
                        }
                    }
                }
            }
        }
        return dst
    }

    /// `cv::saturate_cast<uchar>(float)`: cvRound (round half to even) then clamp.
    @inline(__always) static func saturateU8(_ v: Float) -> UInt8 {
        let r = v.rounded(.toNearestOrEven)
        if r <= 0 { return 0 }
        if r >= 255 { return 255 }
        return UInt8(r)
    }
}
