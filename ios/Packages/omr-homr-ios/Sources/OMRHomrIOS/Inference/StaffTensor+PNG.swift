// SPDX-License-Identifier: AGPL-3.0-or-later
// PNG entry points for the staff tensor. They decode with the package's own pure-Swift PNG reader
// (internal `OMRPNG` target: no ImageIO/CoreGraphics, no color management or gamma), then convert to gray
// the way homr's `cv2.imread(IMREAD_COLOR)` + `COLOR_BGR2GRAY` does (alpha dropped, OpenCV fixed point),
// so iOS and Linux get byte-identical tensors from the same file.
import Foundation
import OMRPNG

extension StaffTensor {
    /// PNG load/decode failure (unsupported variant or malformed file). Never a trap.
    public enum PNGLoadError: Error, Equatable, CustomStringConvertible {
        /// The file could not be read.
        case unreadable(String)
        /// Missing PNG signature.
        case notPNG
        /// Valid PNG the decoder does not handle (16-bit, sub-byte depth, interlaced, oversized, ...).
        case unsupported(String)
        /// Malformed PNG data.
        case corrupt(String)

        public var description: String {
            switch self {
            case .unreadable(let m): return "StaffTensor: cannot read PNG (\(m))"
            case .notPNG: return "StaffTensor: not a PNG file (bad signature)"
            case .unsupported(let m): return "StaffTensor: unsupported PNG: \(m). Supported: non-interlaced 8-bit gray, gray+alpha, RGB, RGBA, palette"
            case .corrupt(let m): return "StaffTensor: corrupt PNG (\(m))"
            }
        }
    }

    /// Cropped staff image PNG → homr canvas + `ConvertToArray` (`fromStaffImage(grayscale:width:height:)`).
    public static func fromStaffImage(pngURL: URL) throws -> StaffTensor {
        let g = try decodeGrayPNG(readPNG(pngURL))
        return try fromStaffImage(grayscale: g.pixels, width: g.width, height: g.height)
    }

    /// Same as `fromStaffImage(pngURL:)` for in-memory PNG bytes.
    public static func fromStaffImage(pngData: Data) throws -> StaffTensor {
        let g = try decodeGrayPNG(pngData)
        return try fromStaffImage(grayscale: g.pixels, width: g.width, height: g.height)
    }

    /// Full page PNG + staff geometry → homr `prepare_staff_image` (crop + dewarp) → canvas → tensor.
    public static func fromPage(pngURL: URL, geometry: StaffGeometry) throws -> StaffTensor {
        let g = try decodeGrayPNG(readPNG(pngURL))
        return try fromPage(grayscale: g.pixels, width: g.width, height: g.height, geometry: geometry)
    }

    static func readPNG(_ url: URL) throws -> Data {
        do { return try Data(contentsOf: url) } catch { throw PNGLoadError.unreadable("\(url.path): \(error.localizedDescription)") }
    }

    /// PNG bytes → 8-bit gray as homr reads it (`cv2.imread` + `COLOR_BGR2GRAY`).
    static func decodeGrayPNG(_ data: Data) throws -> (pixels: [UInt8], width: Int, height: Int) {
        do {
            let img = try PNGDecoder.decode([UInt8](data))
            return (img.grayscale(), img.width, img.height)
        } catch let e as PNGError {
            switch e {
            case .notPNG: throw PNGLoadError.notPNG
            case .unsupported(let m): throw PNGLoadError.unsupported(m)
            case .corrupt(let m): throw PNGLoadError.corrupt(m)
            }
        }
    }
}

extension StaffPrepare {
    /// `prepareStaffImage` on a page PNG decoded like `StaffTensor.fromPage(pngURL:geometry:)`.
    public static func prepareStaffImage(pngURL: URL, geometry: StaffGeometry) throws -> Result {
        let g = try StaffTensor.decodeGrayPNG(StaffTensor.readPNG(pngURL))
        return try prepareStaffImage(page: g.pixels, width: g.width, height: g.height, geometry: geometry)
    }
}
