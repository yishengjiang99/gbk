import Foundation

/// Opens the native paywall. Tests replace `handler` so a 402 can be asserted without StoreKit.
enum PaywallPresentation {
    @MainActor static var handler: (String) -> Void = { PurchaseStore.shared.presentPaywall(reason: $0) }

    static func present(reason: String) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { handler(reason) }
        } else {
            DispatchQueue.main.sync { MainActor.assumeIsolated { handler(reason) } }
        }
    }
}

/// Client-side export gate and the one-time 3rd-song popup (paywall plan, 2026-11-16).
enum Paywall {
    enum ExportKind: String { case midi, wav }

    /// Kind for a download filename; unknown audio/video is treated as wav (it carries the audio).
    static func exportKind(filename: String) -> ExportKind {
        let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
        if ext == "mid" || ext == "midi" { return .midi }
        return .wav
    }

    /// POST /api/paywall/check before a MIDI/WAV export. Only a 402 blocks (and presents the native
    /// paywall with reason `export`). 200, 404, or any other status goes ahead so a build shipped
    /// before the server route stays usable.
    static func allowExport(kind: ExportKind, client: APIClient = .shared) async -> Bool {
        do {
            _ = try await client.send(Endpoints.paywallCheck(action: "export", kind: kind.rawValue), as: OKResult.self)
            return true
        } catch APIError.paywall {
            return false
        } catch {
            return true
        }
    }

    /// Pure: a free user starting a new song, already having 2+ songs, who has not seen the popup.
    static func shouldShowThirdSong(isPro: Bool, seen: Bool, existingSongs: Int) -> Bool {
        !isPro && !seen && existingSongs >= 2
    }
}

/// Remembers the 3rd-song popup locally after the first view, matching the server's
/// `Me.paywall.third_song_seen` (and the web's `gbk.paywall.thirdSong.v1`).
enum ThirdSongGate {
    static let defaultsKey = "paywall.thirdSongSeen"

    static func seenLocal(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: defaultsKey)
    }

    static func markSeen(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: defaultsKey)
    }

    /// Present the 3rd-song paywall at most once. Marks local seen on the first view so it cannot
    /// reappear in this install even if the engagement report is lost.
    @MainActor @discardableResult
    static func maybePresent(me: Me?, isPro: Bool, defaults: UserDefaults = .standard,
                             present: (String) -> Void = { PurchaseStore.shared.presentPaywall(reason: $0) }) -> Bool {
        let seenServer = me?.paywall?.thirdSongSeen == true
        if seenServer { markSeen(defaults: defaults) }
        let seen = seenServer || seenLocal(defaults: defaults)
        let songs = me?.songCount ?? 0
        guard Paywall.shouldShowThirdSong(isPro: isPro, seen: seen, existingSongs: songs) else { return false }
        markSeen(defaults: defaults)
        present("third_song")
        return true
    }
}
