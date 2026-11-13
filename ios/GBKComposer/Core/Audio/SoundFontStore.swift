import Foundation
import SF2Player

/// GeneralUser GS 2.0.2 (bundled, same file and SHA as sf2player-swift soundfont.lock), parsed once at launch
/// and shared by every feed player.
@MainActor
final class SoundFontStore {
    static let shared = SoundFontStore()
    private var task: Task<SF2SoundFont?, Never>?

    nonisolated static var bundledURL: URL? {
        Bundle.main.url(forResource: "GeneralUser-GS", withExtension: "sf2")
            ?? Bundle(for: SoundFontStoreToken.self).url(forResource: "GeneralUser-GS", withExtension: "sf2")
    }

    func preload() { _ = load() }

    @discardableResult
    func load(from url: URL? = SoundFontStore.bundledURL) -> Task<SF2SoundFont?, Never> {
        if let task { return task }
        let t = Task<SF2SoundFont?, Never> { [weak self] in
            let sf: SF2SoundFont? = if let url { try? await SF2SoundFont.load(contentsOf: url) } else { nil }
            if sf == nil { self?.task = nil } // a failed load is retried next time, not memoized
            return sf
        }
        task = t
        return t
    }
}

private final class SoundFontStoreToken {}
