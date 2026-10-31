import Foundation
import UIKit

/// One recognized note. Times are in quarter notes (beats) from the start of the score.
struct ScoreNote: Equatable, Codable, Sendable {
    var pitch: Int
    var onset: Double
    var duration: Double
    var velocity: Int
}

struct ScorePart: Equatable, Codable, Sendable {
    var name: String
    var program: Int?
    var notes: [ScoreNote]
}

struct TimeSignature: Equatable, Codable, Sendable {
    var numerator: Int
    var denominator: Int
}

/// Recognizer output: parts plus global tempo (BPM), key (e.g. "C", "Am", "F#") and time signature.
struct Score: Equatable, Codable, Sendable {
    var parts: [ScorePart]
    var tempo: Double?
    var key: String?
    var timeSig: TimeSignature?

    var noteCount: Int { parts.reduce(0) { $0 + $1.notes.count } }
}

/// One rasterized page (camera scan, photo or PDF page).
struct SheetPage: @unchecked Sendable {
    var image: CGImage
}

enum ScanError: Error, Equatable, LocalizedError {
    case cameraDenied
    case nothingRecognized
    case recognizerUnavailable(String)
    case unreadableInput(String)
    case studioNotReady
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .cameraDenied: return "Camera access is off. Allow it in Settings › GBK › Camera, or import a photo or PDF instead."
        case .nothingRecognized: return "No notes were recognized. Try a sharper, well-lit photo of printed sheet music."
        case .recognizerUnavailable(let m): return "Sheet recognition isn't available: \(m)"
        case .unreadableInput(let m): return "Couldn't read that file: \(m)"
        case .studioNotReady: return "The studio isn't ready to import yet. Wait for it to finish loading, then try again."
        case .failed(let m): return "Recognition failed: \(m)"
        }
    }
}

/// Pages in, Score out. `HomrSheetRecognizer` (omr-homr-ios) in the app; fixtures in tests.
protocol SheetRecognizer: Sendable {
    func recognize(pages: [SheetPage]) async throws -> Score
}

/// One page rendered as R, G, B, X bytes (`bytesPerRow == 4 * width`), for the native
/// pipeline's color preprocessing.
struct RGBXPage: Sendable {
    var data: Data
    var width: Int
    var height: Int
    var bytesPerRow: Int { width * 4 }
}

extension SheetPage {
    /// Upright 8-bit gray pixels, row-major, no padding (what OMRHomrIOS takes).
    func gray8(maxSide: Int = 3000) -> (data: Data, width: Int, height: Int) {
        let scale = min(1, Double(maxSide) / Double(max(image.width, image.height)))
        let w = max(1, Int(Double(image.width) * scale)), h = max(1, Int(Double(image.height) * scale))
        var px = [UInt8](repeating: 255, count: w * h)
        px.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return (Data(px), w, h)
    }

    /// Color rendering of the page (same max-side cap as `gray8`), so the native pipeline
    /// preprocesses in color like homr — Music Reader's rule: monochrome pages stay gray8
    /// (returns nil), color pages become RGBX rendered in their own RGB space (or DeviceRGB),
    /// white-backed, R/G/B/X byte order. A failed render also returns nil; the engine then
    /// falls back to `gray8`.
    func rgbx(maxSide: Int = 3000) -> RGBXPage? {
        guard image.colorSpace?.model != .monochrome else { return nil }
        let scale = min(1, Double(maxSide) / Double(max(image.width, image.height)))
        let w = max(1, Int(Double(image.width) * scale)), h = max(1, Int(Double(image.height) * scale))
        let space = image.colorSpace?.model == .rgb && image.colorSpace != nil
            ? image.colorSpace! : CGColorSpaceCreateDeviceRGB()
        var px = Data(count: w * h * 4)
        let ok = px.withUnsafeMutableBytes { buf -> Bool in
            guard let base = buf.baseAddress,
                  let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: space,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                                          | CGBitmapInfo.byteOrder32Big.rawValue),
                  ctx.bytesPerRow == w * 4 else { return false }
            ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return ok ? RGBXPage(data: px, width: w, height: h) : nil
    }

    /// Bakes EXIF orientation in so the page is upright.
    init?(uiImage: UIImage) {
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let upright = uiImage.imageOrientation == .up ? uiImage
            : UIGraphicsImageRenderer(size: uiImage.size, format: fmt).image { _ in uiImage.draw(at: .zero) }
        guard let cg = upright.cgImage else { return nil }
        image = cg
    }
}
