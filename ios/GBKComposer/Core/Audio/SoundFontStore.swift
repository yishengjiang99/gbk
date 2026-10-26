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
        let t = Task<SF2SoundFont?, Never> {
            guard let url else { return nil }
            return try? await SF2SoundFont.load(contentsOf: url)
        }
        task = t
        return t
    }
}

private final class SoundFontStoreToken {}
