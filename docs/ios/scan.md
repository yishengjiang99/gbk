# iOS: Scan sheet music

Scan printed sheet music (camera, photos or PDF) into new tracks of the open studio project.

## Flow (iOS-only; no web changes)

1. Create tab: a slim native bar **above** the studio WKWebView (stacked in a VStack, not overlaid) has a **Scan sheet music** button (`StudioNativeBar`, accent capsule; light and dark). The web view keeps its whole frame below the bar, so the web toolbar and the bottom composer input stay visible.
2. Tap → native sheet (`ScanSheet`, which presents OMRScanUI's `OMRScanFlow` with GBK's `ScanTheme`): **Scan with camera** (VNDocumentCameraViewController), **Choose photos** (PhotosPicker, up to 10), **Import PDF or image** (fileImporter; PDFKit rasterizes up to 10 pages at 200 dpi). `-uiTestScanFixture` adds **Use test sheet** (bundled `scan-fixture.png`) for UI tests.
3. `ScanRunner.run(pages:source:host:)` (OMRScanKit) recognizes each page, merges the per-page SMFs (page 2 starts where page 1 ends) and writes one SMF (type 1, 480 TPQ: conductor with tempo / time signature / key, then one track per staff; channels skip 9). The reading card shows a determinate "Warming up… x%" then "Reading music… x%" fed only by the warmup load and the page pipeline; Cancel stops at the next checkpoint and a late result is never handed to the studio.
4. Hand-off through the studio's existing MIDI import (prod since befdd00, checked in the live bundle on 2026-10-25): native runs
   `window.dispatchEvent(new CustomEvent("gbk:midi-file", {detail: {file: new File([bytes], "Scanned sheet music.mid", {type: "audio/midi"})}}))`.
   The page's `MidiImportChooser` asks **Open as new project** / **Add to current project** (read-only projects only offer "new"), parses the SMF with `workstation/smf.ts`, and drops the conductor track. Native waits for `[data-testid="midi-import"]` to appear, then closes its sheet.
5. Errors in the sheet: camera denied (with Open Settings), nothing recognized, models missing, unreadable file, studio not ready (the page has not loaded / the chooser did not appear).

There is no `scan` capability in `window.gbkNative` and no `gbkScan` message handler; Scan depends on no native-specific web API.

If the studio ever drops the `gbk:midi-file` event, the smallest web hook that keeps this working is: keep `MidiImportChooser` mounted on /studio and listening for `window` `gbk:midi-file` with `{detail: {file: File}}` (a test in the web suite should pin it).

## Recognizer: OMRScanKit / OMRScanUI over omr-homr-ios (AGPL-3.0)

Yisheng chose to license `ios/` AGPL-3.0-or-later (2026-10-25), so the real recognizer is linked.

- **Package**: the root `Package.swift` of https://github.com/yishengjiang99/omr-sheet-cam (products `OMRScanKit`, no UI, and `OMRScanUI`, SwiftUI; `OMRScanKit` re-exports `OMRHomrIOS`, the homr port in that repo's `Packages/omr-homr-ios`). omr-sheet-cam is the single source of truth: GBK vendors nothing and fixes go upstream. Pinned in `ios/project.yml` (`packages.OMRScan`). Pulls `microsoft/onnxruntime-swift-package-manager` exact `1.24.2`.
- **Host seams** (`ios/GBKComposer/Features/Scan`, the only scan code left in GBK): `ScanCoordinator` (sheet state + the studio hand-off, `StudioMIDIImport`), `GBKScanHost` (`ScanHost`: `didFinish` hands the SMF to the studio; `telemetry` maps `ScanEvent`s onto `ScanTelemetryLogger`), `ScanTelemetry.swift` (the existing `scan_started` / `scan_completed` / `scan_failed` reports, same fields and reason codes). Theme comes from the `scanTheme` environment value (`ScanTheme.gbk`); copy can be overridden with an `OMRScan` strings table in the app bundle; the `-uiTestScanFixture` page is a `ScanFixture`.
- **Failure taxonomy** (`ScanError.reasonCode`): `no_staff`, `empty_midi`, `no_notes`, `models_not_bundled`, `session_not_configured`, `tokenizer_missing`, `invalid_input`, `unsupported_format`, `parse_error`, plus host codes (`studio_not_ready`).
- **Lifecycle**: `ScanKit.warmUp()` at launch and `ScanKit.warmUpOnForeground()` on foreground (re-warm after a failure or memory-warning release); both also install the memory-warning release observer.
- **Models**: homr `onnx_checkpoints` (SegNet fp16 29 MB, encoder fp16 26 MB on CoreML; decoder fp32 47 MB on CPU; ~102 MB), SHA-256 pinned in `ios/models.lock`, fetched by `ios/scripts/fetch-models` into gitignored `ios/models/`, copied into `GBKComposer.app/models/` by the "Bundle OMR models" build phase. Missing models: build warning, Scan shows the models error. `ios-release.yml` fetches them and sets `OMR_REQUIRE_MODELS=1`, so a release archive never ships without them.
- **Size decision**: bundle (simplest, works offline, ~+102 MB, under the 200 MB cellular limit). Follow-up if size matters: first-use download of the three `.onnx` files from a pinned URL (the homr release assets are .zip, so host unzipped copies) with SHA-256 check into Application Support, passing that directory as `modelsDirectory`.

## Tests

- Recognition, progress, cancellation, multi-page merge, SMF round trip and the failure taxonomy are tested in the package (`omr-sheet-cam` `Tests/OMRScanKitTests`, `Tests/OMRScanUITests`), not here.
- `ScanTests.swift`: the `gbk:midi-file` hand-off against a stand-in chooser page (file name, type, bytes), "studio not ready" on a page without the import, a classified nothing-recognized error, a cancelled scan never reaching the studio, no `scan` capability flag, and the real pipeline on `GBKComposerTests/Fixtures/c_major_scale.png` (pitches 60 62 64 65 67 69 71 72; CI sets `OMR_REQUIRE_MODELS=1`).
- `ScanTelemetryTests.swift`: event names, fields and the client-error wire shape.
- `ScanUITests.swift` (live compose.grepawk.com/studio): bar button → sheet → **Use test sheet** → real recognition (~3 min on the simulator) → studio chooser → **Open as new project** → "Imported 1 track, 8 notes"; composer input hittable throughout. The app is locked to Light (`UIUserInterfaceStyle`), so dark is checked by the snapshot tests.
- Snapshots: `scan-entry`, `scan-error`, `studio-scan-bar` (light/dark) + UI screenshots `scan-ui-*` in the `ios-snapshots` artifact.

## AGPL §13 note

§13 (remote network interaction) applies to a modified AGPL program that users interact with over a network. The iOS app runs on the device; it ships no server code. It calls the separately licensed compose.grepawk.com service over HTTPS and loads the studio web page, neither of which is derived from the AGPL iOS code, so §13 does not reach them. The obligation the app does carry is to offer corresponding source to users who receive the binary: Profile › About › Source code links to https://github.com/yishengjiang99/gbk/tree/main/ios.
