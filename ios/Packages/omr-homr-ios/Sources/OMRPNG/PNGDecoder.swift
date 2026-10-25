// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal pure-Swift PNG reader (no UIKit/ImageIO/CoreGraphics/zlib, no color management or gamma), so
// iOS and Linux decode byte-identically. Internal target: not a product; OMRHomrIOS exposes it only via
// `StaffTensor.fromStaffImage(pngURL:)` / `(pngData:)` and friends.
// Supports non-interlaced 8-bit gray (0), RGB (2), palette (3), gray+alpha (4), RGBA (6). Everything else
// (16-bit, sub-byte depths, Adam7) and malformed input throws `PNGError`; it never traps.
import Foundation

public struct PNGImage: Sendable {
    public let width: Int
    public let height: Int
    /// Interleaved samples per pixel: 1 gray, 2 gray+alpha, 3 RGB, 4 RGBA (palette expands to 3/4).
    public let channels: Int
    public let pixels: [UInt8]

    /// 8-bit grayscale as homr reads it: `cv2.imread(IMREAD_COLOR)` (alpha dropped) → `COLOR_BGR2GRAY`
    /// (`(R*9798 + G*19235 + B*3735 + 16384) >> 15`, OpenCV fixed point); gray input is returned unchanged.
    public func grayscale() -> [UInt8] {
        switch channels {
        case 1: return pixels
        case 2: return stride(from: 0, to: pixels.count, by: 2).map { pixels[$0] }
        default:
            let n = width * height
            var out = [UInt8](repeating: 0, count: n)
            for i in 0..<n {
                let o = i * channels
                let r: Int = Int(pixels[o]) * 9798
                let g: Int = Int(pixels[o + 1]) * 19235
                let b: Int = Int(pixels[o + 2]) * 3735
                let sum: Int = r + g + b + 16384
                out[i] = UInt8(sum >> 15)
            }
            return out
        }
    }
}

public enum PNGError: Error, CustomStringConvertible, Equatable {
    case notPNG
    case unsupported(String)
    case corrupt(String)
    public var description: String {
        switch self {
        case .notPNG: return "PNG: bad signature"
        case .unsupported(let m): return "PNG: unsupported \(m)"
        case .corrupt(let m): return "PNG: corrupt (\(m))"
        }
    }
}

public enum PNGDecoder {
    /// Largest accepted image (pixels) and side; bigger headers throw instead of allocating.
    public static let maxPixels = 1 << 27
    public static let maxSide = 1 << 16

    public static func decode(contentsOf url: URL) throws -> PNGImage {
        try decode([UInt8](Data(contentsOf: url)))
    }

    public static func decode(_ b: [UInt8]) throws -> PNGImage {
        guard b.count >= 8, b[0..<8].elementsEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) else {
            throw PNGError.notPNG
        }
        var p = 8
        var width = 0, height = 0, depth = 0, colorType = -1, interlace = 0
        var idat: [UInt8] = []
        var palette: [UInt8] = []
        var trns: [UInt8] = []
        func be32(_ i: Int) -> Int {
            let b0: Int = Int(b[i]) << 24
            let b1: Int = Int(b[i + 1]) << 16
            let b2: Int = Int(b[i + 2]) << 8
            let b3: Int = Int(b[i + 3])
            return b0 | b1 | b2 | b3
        }
        while p + 8 <= b.count {
            let len = be32(p)
            let type = String(decoding: b[(p + 4)..<(p + 8)], as: UTF8.self)
            let start = p + 8
            guard len >= 0, start + len + 4 <= b.count else { throw PNGError.corrupt("chunk \(type) overruns file") }
            let body = b[start..<(start + len)]
            switch type {
            case "IHDR":
                guard len == 13 else { throw PNGError.corrupt("IHDR length") }
                width = be32(start); height = be32(start + 4)
                depth = Int(b[start + 8]); colorType = Int(b[start + 9]); interlace = Int(b[start + 12])
            case "PLTE": palette = Array(body)
            case "tRNS": trns = Array(body)
            case "IDAT": idat.append(contentsOf: body)
            default: break
            }
            p = start + len + 4
            if type == "IEND" { break }
        }
        guard width > 0, height > 0 else { throw PNGError.corrupt("missing IHDR") }
        guard width <= maxSide, height <= maxSide, width * height <= maxPixels else {
            throw PNGError.unsupported("size \(width)x\(height) (max \(maxSide) per side, \(maxPixels) pixels)")
        }
        guard depth == 8 else { throw PNGError.unsupported("bit depth \(depth) (only 8-bit PNGs are supported)") }
        guard interlace == 0 else { throw PNGError.unsupported("interlaced PNG") }
        let spp: Int
        switch colorType {
        case 0: spp = 1
        case 2: spp = 3
        case 3: spp = 1
        case 4: spp = 2
        case 6: spp = 4
        default: throw PNGError.unsupported("color type \(colorType)")
        }
        if colorType == 3 && palette.isEmpty { throw PNGError.corrupt("palette image without PLTE") }
        let stride = width * spp
        let raw = try Inflate.zlib(idat, maxOutput: height * (stride + 1))
        guard raw.count >= height * (stride + 1) else {
            throw PNGError.corrupt("inflated \(raw.count) bytes, need \(height * (stride + 1))")
        }
        var img = [UInt8](repeating: 0, count: height * stride)
        for y in 0..<height {
            let f = raw[y * (stride + 1)]
            let s = y * (stride + 1) + 1
            let o = y * stride
            for x in 0..<stride {
                let v = raw[s + x]
                let a = x >= spp ? Int(img[o + x - spp]) : 0
                let up = y > 0 ? Int(img[o - stride + x]) : 0
                let c = (x >= spp && y > 0) ? Int(img[o - stride + x - spp]) : 0
                let pred: Int
                switch f {
                case 0: pred = 0
                case 1: pred = a
                case 2: pred = up
                case 3: pred = (a + up) >> 1
                case 4:
                    let pp = a + up - c
                    let pa = abs(pp - a), pb = abs(pp - up), pc = abs(pp - c)
                    pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c)
                default: throw PNGError.corrupt("filter \(f) on row \(y)")
                }
                img[o + x] = v &+ UInt8(truncatingIfNeeded: pred)
            }
        }
        if colorType == 3 {
            let hasAlpha = !trns.isEmpty
            let ch = hasAlpha ? 4 : 3
            var outPx = [UInt8](repeating: 0, count: width * height * ch)
            for i in 0..<(width * height) {
                let idx = Int(img[i])
                guard idx * 3 + 2 < palette.count else { throw PNGError.corrupt("palette index \(idx)") }
                outPx[i * ch] = palette[idx * 3]; outPx[i * ch + 1] = palette[idx * 3 + 1]; outPx[i * ch + 2] = palette[idx * 3 + 2]
                if hasAlpha { outPx[i * ch + 3] = idx < trns.count ? trns[idx] : 255 }
            }
            return PNGImage(width: width, height: height, channels: ch, pixels: outPx)
        }
        return PNGImage(width: width, height: height, channels: spp, pixels: img)
    }
}

/// RFC 1950/1951 inflate (stored, fixed and dynamic Huffman blocks). Adler-32 is verified.
enum Inflate {
    struct Huffman {
        var counts = [Int](repeating: 0, count: 16)
        var symbols: [Int] = []
        init(lengths: [Int]) throws {
            for l in lengths { counts[l] += 1 }
            counts[0] = 0
            var offs = [Int](repeating: 0, count: 16)
            for i in 1..<16 { offs[i] = offs[i - 1] + counts[i - 1] }
            symbols = [Int](repeating: 0, count: lengths.count)
            for (s, l) in lengths.enumerated() where l != 0 { symbols[offs[l]] = s; offs[l] += 1 }
        }
    }

    struct Bits {
        let d: [UInt8]
        var pos = 0
        var bit = 0
        var buf = 0
        var n = 0
        init(_ d: [UInt8], start: Int) { self.d = d; pos = start }
        mutating func need(_ k: Int) throws -> Int {
            while n < k {
                guard pos < d.count else { throw PNGError.corrupt("deflate stream truncated") }
                buf |= Int(d[pos]) << n; pos += 1; n += 8
            }
            let v = buf & ((1 << k) - 1)
            buf >>= k; n -= k
            return v
        }
        mutating func alignByte() { buf = 0; n = 0 }
        mutating func decode(_ h: Huffman) throws -> Int {
            var code = 0, first = 0, index = 0
            for len in 1..<16 {
                code |= try need(1)
                let count = h.counts[len]
                if code - count < first {
                    let k = index + (code - first)
                    guard k >= 0, k < h.symbols.count else { throw PNGError.corrupt("bad Huffman code") }
                    return h.symbols[k]
                }
                index += count; first += count; first <<= 1; code <<= 1
            }
            throw PNGError.corrupt("bad Huffman code")
        }
    }

    static let lenBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    static let lenExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    static let distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
    static let distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
    static let clOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

    /// `maxOutput`: expected inflated size; a stream producing more throws (decompression-bomb guard).
    static func zlib(_ d: [UInt8], maxOutput: Int = Int.max) throws -> [UInt8] {
        guard d.count >= 6, d[0] & 0x0F == 8, (Int(d[0]) << 8 | Int(d[1])) % 31 == 0, d[1] & 0x20 == 0 else {
            throw PNGError.corrupt("zlib header")
        }
        var bits = Bits(d, start: 2)
        var out: [UInt8] = []
        out.reserveCapacity(min(maxOutput, d.count * 4))
        let fixedLit = try Huffman(lengths: (0..<288).map { $0 < 144 ? 8 : $0 < 256 ? 9 : $0 < 280 ? 7 : 8 })
        let fixedDist = try Huffman(lengths: [Int](repeating: 5, count: 30))
        var last = 0
        repeat {
            last = try bits.need(1)
            let type = try bits.need(2)
            switch type {
            case 0:
                bits.alignByte()
                let p = bits.pos
                guard p + 4 <= d.count else { throw PNGError.corrupt("stored header") }
                let len = Int(d[p]) | Int(d[p + 1]) << 8
                let nlen = Int(d[p + 2]) | Int(d[p + 3]) << 8
                guard len == (~nlen & 0xFFFF), p + 4 + len <= d.count else { throw PNGError.corrupt("stored block") }
                out.append(contentsOf: d[(p + 4)..<(p + 4 + len)])
                bits.pos = p + 4 + len
                guard out.count <= maxOutput else { throw PNGError.corrupt("image data larger than \(maxOutput) bytes") }
            case 1:
                try block(&bits, &out, fixedLit, fixedDist, maxOutput)
            case 2:
                let hlit = try bits.need(5) + 257, hdist = try bits.need(5) + 1, hclen = try bits.need(4) + 4
                var cl = [Int](repeating: 0, count: 19)
                for i in 0..<hclen { cl[clOrder[i]] = try bits.need(3) }
                let clh = try Huffman(lengths: cl)
                var lengths: [Int] = []
                while lengths.count < hlit + hdist {
                    let sym = try bits.decode(clh)
                    switch sym {
                    case 0..<16: lengths.append(sym)
                    case 16:
                        guard let prev = lengths.last else { throw PNGError.corrupt("repeat with no length") }
                        lengths += [Int](repeating: prev, count: 3 + (try bits.need(2)))
                    case 17: lengths += [Int](repeating: 0, count: 3 + (try bits.need(3)))
                    default: lengths += [Int](repeating: 0, count: 11 + (try bits.need(7)))
                    }
                }
                guard lengths.count == hlit + hdist else { throw PNGError.corrupt("code lengths overrun") }
                try block(&bits, &out, Huffman(lengths: Array(lengths[0..<hlit])), Huffman(lengths: Array(lengths[hlit...])), maxOutput)
            default:
                throw PNGError.corrupt("block type 3")
            }
        } while last == 0
        bits.alignByte()
        let p = bits.pos
        if p + 4 <= d.count {
            let w0: UInt32 = UInt32(d[p]) << 24
            let w1: UInt32 = UInt32(d[p + 1]) << 16
            let w2: UInt32 = UInt32(d[p + 2]) << 8
            let w3: UInt32 = UInt32(d[p + 3])
            let want: UInt32 = w0 | w1 | w2 | w3
            var a: UInt32 = 1, b: UInt32 = 0
            for chunk in stride(from: 0, to: out.count, by: 5552) {
                for i in chunk..<min(chunk + 5552, out.count) { a += UInt32(out[i]); b += a }
                a %= 65521; b %= 65521
            }
            guard (b << 16 | a) == want else { throw PNGError.corrupt("Adler-32 mismatch") }
        }
        return out
    }

    static func block(_ bits: inout Bits, _ out: inout [UInt8], _ lit: Huffman, _ dist: Huffman, _ maxOutput: Int) throws {
        while true {
            guard out.count <= maxOutput else { throw PNGError.corrupt("image data larger than \(maxOutput) bytes") }
            let sym = try bits.decode(lit)
            if sym < 256 { out.append(UInt8(sym)); continue }
            if sym == 256 { return }
            let li = sym - 257
            guard li < 29 else { throw PNGError.corrupt("length symbol \(sym)") }
            let len = lenBase[li] + (try bits.need(lenExtra[li]))
            let ds = try bits.decode(dist)
            guard ds < 30 else { throw PNGError.corrupt("distance symbol \(ds)") }
            guard len <= maxOutput else { throw PNGError.corrupt("length \(len)") }
            let dd = distBase[ds] + (try bits.need(distExtra[ds]))
            guard dd <= out.count else { throw PNGError.corrupt("distance \(dd) > output \(out.count)") }
            let s = out.count - dd
            for i in 0..<len { out.append(out[s + i]) }
        }
    }
}
