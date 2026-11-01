import Foundation
import OMRScanKit

/// GBK's `ScanHost`: a finished scan goes to the studio's MIDI import; telemetry events map onto
/// the existing `scan_started` / `scan_completed` / `scan_failed` reports (same fields and reason codes).
final class GBKScanHost: ScanHost, @unchecked Sendable {
    private weak var coordinator: ScanCoordinator?

    init(coordinator: ScanCoordinator) { self.coordinator = coordinator }

    func didFinish(_ result: ScanResult) async throws {
        guard let coordinator else { throw StudioNotReady() }
        try await coordinator.handOff(result.midi)
    }

    func telemetry(_ event: ScanEvent) {
        guard let logger = coordinator?.telemetry else { return }
        Task { @MainActor in
            switch event {
            case let .started(source, pages, width, height):
                logger.started(source: source, pages: pages, imageWidth: width, imageHeight: height)
            case .progress:
                break // progress is UI state, not a telemetry event
            case let .completed(source, result, durationMs):
                logger.completed(source: source, diagnostics: result.diagnostics, durationMs: durationMs, noteCount: result.noteCount)
            case let .failed(source, reasonCode, diagnostics, durationMs):
                logger.failed(source: source, reason: reasonCode, diagnostics: diagnostics, durationMs: durationMs)
            }
        }
    }
}
