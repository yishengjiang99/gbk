import Foundation

/// Staff-only encoder input assumptions mirrored from upstream
/// `homr.transformer.configs.Config` + `staff2score.ConvertToArray`.
///
/// OMR iOS (and Gate-1 fixtures) must feed a single-channel staff tile already
/// resized/padded to these spatial bounds. Shape is NCHW:
/// `[batch=1, channels=1, height=256, width=1280]`.
public enum StaffInputSpec: Sendable {
    /// `Config.channels`
    public static let channels: Int = 1
    /// `Config.max_height`
    public static let maxHeight: Int = 256
    /// `Config.max_width`
    public static let maxWidth: Int = 1280
    /// `Config.patch_size`
    public static let patchSize: Int = 16

    /// NCHW tensor shape the encoder ONNX expects after `ConvertToArray`.
    public static let nchwShape: [Int] = [1, channels, maxHeight, maxWidth]

    /// `ConvertToArray.mean` (grayscale normalize after /255).
    public static let normalizeMean: Float = 0.7931
    /// `ConvertToArray.std`
    public static let normalizeStd: Float = 0.1738

    /// Element count for one fp32 staff tile (`1 * 1 * 256 * 1280`).
    public static var elementCount: Int {
        nchwShape.reduce(1, *)
    }

    /// Validate a logical NCHW shape against staff-only Gate-1 assumptions.
    public static func isValidStaffNCHW(_ shape: [Int]) -> Bool {
        shape == nchwShape
    }
}
