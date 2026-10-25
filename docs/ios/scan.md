# iOS: Scan sheet music

Scan printed sheet music (camera, photos or PDF) into new tracks of the open studio project.

## Flow (iOS-only; no web changes)

1. Create tab: a slim native bar **above** the studio WKWebView (stacked in a VStack, not overlaid) has a **Scan sheet music** button (`StudioNativeBar`, accent capsule; light and dark). The web view keeps its whole frame below the bar, so the web toolbar and the bottom composer input stay visible.
2. Tap → native sheet (`ScanSheetView`): **Scan with camera** (VNDocumentCameraViewController), **Choose photos** (PhotosPicker, up to 10), **Import PDF or image** (fileImporter; PDFKit rasterizes up to 10 pages at 200 dpi). `-uiTestScanFixture` adds **Use test sheet** (bundled `scan-fixture.png`) for UI tests.
3. `SheetRecognizer.recognize(pages:)` → `Score` → `SMFWriter` (type 1, 480 TPQ: conductor with tempo / time signature / key, then one track per part with name and program; channels skip 9).
4. Hand-off through the studio's existing MIDI import (prod since befdd00, checked in the live bundle on 2026-10-25): native runs
   `window.dispatchEvent(new CustomEvent("gbk:midi-file", {detail: {file: new File([bytes], "Scanned sheet music.mid", {type: "audio/midi"})}}))`.
   The page's `MidiImportChooser` asks **Open as new project** / **Add to current project** (read-only projects only offer "new"), parses the SMF with `workstation/smf.ts`, and drops the conductor track. Native waits for `[data-testid="midi-import"]` to appear, then closes its sheet.
5. Errors in the sheet: camera denied (with Open Settings), nothing recognized, models missing, unreadable file, studio not ready (the page has not loaded / the chooser did not appear).

There is no `scan` capability in `window.gbkNative` and no `gbkScan` message handler; Scan depends on no native-specific web API.

If the studio ever drops the `gbk:midi-file` event, the smallest web hook that keeps this working is: keep `MidiImportChooser` mounted on /studio and listening for `window` `gbk:midi-file` with `{detail: {file: File}}` (a test in the web suite should pin it).

## Recognizer: omr-homr-ios (AGPL-3.0)

Yisheng chose to license `ios/` AGPL-3.0-or-later (2026-10-25), so the real recognizer is linked.

- **Package**: `Packages/omr-homr-ios` inside https://github.com/yishengjiang99/omr-sheet-cam (not a standalone repo; SwiftPM can't use a remote subdirectory). Vendored at `ios/Packages/omr-homr-ios` @ omr-sheet-cam `467308a` (`VENDORED.md` has the update command), local path package in `project.yml`, product/module `OMRHomrIOS`. Pulls `microsoft/onnxruntime-swift-package-manager` exact `1.24.2`.
- **API used**: `OMRHomrIOS.parseSheetMusicWithLayout(gray8:width:height:)` → `ParseSheetMusicResult {midi (SMF type 1, 480 TPQ, one track per staff), noteLayout, staffCount, warnings}`. No PDF input and no structured tempo/key/time signature, so `SMFReader` parses the SMF (notes per track, tempo 0x51, time sig 0x58, key 0x59) into `Score`; one gbk track per staff; pages are appended in order.
- **Glue**: `ios/GBKComposer/Features/Scan/HomrSheetRecognizer.swift` (off-main `Task.detached`; `OMRError.modelsNotBundled` → "recognition models are not installed").
- **Models**: homr `onnx_checkpoints` (SegNet fp16 29 MB, encoder fp16 26 MB on CoreML; decoder fp32 47 MB on CPU; ~102 MB), SHA-256 pinned in `ios/models.lock`, fetched by `ios/scripts/fetch-models` (copied from omr-sheet-cam) into gitignored `ios/models/`, copied into `GBKComposer.app/models/` by the "Bundle OMR models" build phase. Missing models: build warning, Scan shows the models error. `ios-release.yml` fetches them and sets `OMR_REQUIRE_MODELS=1`, so a release archive never ships without them.
- **Size decision**: bundle (simplest, works offline, ~+102 MB, under the 200 MB cellular limit). Follow-up if size matters: first-use download of the three `.onnx` files from a pinned URL (the homr release assets are .zip, so host unzipped copies) with SHA-256 check into Application Support, passing that directory as `modelsDirectory`.
- Package resources (tokenizers/vocab): 44 KB.

## Tests

- `ScanTests.swift`: Score → SMF → Score round trip (tempo, time sig, key, names, programs, retriggered pitches, channels), SMF reader, the `gbk:midi-file` hand-off against a stand-in chooser page (file name, type, bytes), "studio not ready" on a page without the import, nothing recognized, no `scan` capability flag, and the real pipeline on `GBKComposerTests/Fixtures/c_major_scale.png` (pitches 60 62 64 65 67 69 71 72; CI sets `OMR_REQUIRE_MODELS=1`).
- `ScanUITests.swift` (live compose.grepawk.com/studio): bar button → sheet → **Use test sheet** → real recognition (~3 min on the simulator) → studio chooser → **Open as new project** → "Imported 1 track, 8 notes"; composer input hittable throughout. The app is locked to Light (`UIUserInterfaceStyle`), so dark is checked by the snapshot tests.
- Snapshots: `scan-entry`, `scan-error`, `studio-scan-bar` (light/dark) + UI screenshots `scan-ui-*` in the `ios-snapshots` artifact.

## AGPL §13 note

§13 (remote network interaction) applies to a modified AGPL program that users interact with over a network. The iOS app runs on the device; it ships no server code. It calls the separately licensed compose.grepawk.com service over HTTPS and loads the studio web page, neither of which is derived from the AGPL iOS code, so §13 does not reach them. The obligation the app does carry is to offer corresponding source to users who receive the binary: Profile › About › Source code links to https://github.com/yishengjiang99/gbk/tree/main/ios.
