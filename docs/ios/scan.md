# iOS: Scan sheet music

Scan printed sheet music (camera, photos or PDF) into new tracks of the open studio project.

## Flow

1. The app injects the shared, frozen `window.gbkNative = {platform: "ios", version: 1, capabilities: ["hum", "scan"], scan: true}` at document start (`HumBridge.capabilityScript`).
2. The studio renders a **📷 Scan** button next to Hum (`src/components/workstation/ScanButton.tsx`) only when the scan capability and `webkit.messageHandlers.gbkScan` exist. Native draws nothing over the web toolbar or composer.
3. Tap → web posts `{type: "scan.start", project: {ppq, channels, noteCount, readOnly, readOnlyReason?}}` to `webkit.messageHandlers.gbkScan`.
4. Native shows a sheet (`ScanSheetView`): **Scan with camera** (VNDocumentCameraViewController), **Choose photos** (PhotosPicker, up to 10), **Import PDF or image** (fileImporter; PDFKit rasterizes up to 10 pages at 200 dpi).
5. `SheetRecognizer.recognize(pages:)` → `Score` → `ScoreOps.ops` → `window.gbkStudio.applyNativeOps(ops, {label: "scan sheet music", source: "scan"})`, one undo step through `workstation.userEdit`. Native then fires `gbknative:scan` (`{status: "added", tracks, notes}` or `{status: "cancelled"}`).

Errors shown in the sheet: camera denied (with Open Settings), nothing recognized, read-only project (checked from `scan.start` and again from the `applyNativeOps` result), models missing, unreadable file.

## Web contract (implemented in this repo, `src/native/scan-bridge.ts`)

- `window.gbkNative.capabilities` includes `"scan"` (also `window.gbkNative.scan === true`); one shared object with Hum.
- `webkit.messageHandlers.gbkScan.postMessage({type: "scan.start", project})`.
- `window.gbkStudio.applyNativeOps(ops: Op[], opts?) -> {ok: boolean, revision?: number, error?: string}`; accepts only `addTrack`, `addNotes`, `setTempoMap`, `setTimeSigMap`, `setMeta`; error `READ_ONLY: <reason>` on read-only projects.
- Event `gbknative:scan` on `window` (optional to listen to).

## Score and ops

```swift
protocol SheetRecognizer { func recognize(pages: [SheetPage]) async throws -> Score }
Score { parts: [{name, program?, notes: [{pitch, onset, duration, velocity}]}], tempo (BPM)?, key?, timeSig? }  // onset/duration in quarter notes
```

Ops match `humToOps` (`src/hum/notes-to-ops.ts`): per part `addTrack {id, name, channel, program, bankMsb: 0, bankLsb: 0, role: "melody"}` + `addNotes {trackId, channel, tick, duration, pitch, velocity}` with `tick = beats * project.ppq`; channels are the next free melodic ones (skip 9). Tempo/time signature/key ops are emitted only when the project has no notes.

## Recognizer: omr-homr-ios (AGPL-3.0)

Yisheng chose to license `ios/` AGPL-3.0-or-later (2026-10-25), so the real recognizer is linked.

- **Package**: `Packages/omr-homr-ios` inside https://github.com/yishengjiang99/omr-sheet-cam (not a standalone repo; SwiftPM can't use a remote subdirectory). Vendored at `ios/Packages/omr-homr-ios` @ omr-sheet-cam `467308a` (`VENDORED.md` has the update command), local path package in `project.yml`, product/module `OMRHomrIOS`. Pulls `microsoft/onnxruntime-swift-package-manager` exact `1.24.2`.
- **API used**: `OMRHomrIOS.parseSheetMusicWithLayout(gray8:width:height:)` → `ParseSheetMusicResult {midi (SMF type 1, 480 TPQ, one track per staff), noteLayout, staffCount, warnings}`. No PDF input and no structured tempo/key/time signature, so `SMFReader` parses the SMF (notes per track, tempo 0x51, time sig 0x58, key 0x59) into `Score`; one gbk track per staff; pages are appended in order.
- **Glue**: `ios/GBKComposer/Features/Scan/HomrSheetRecognizer.swift` (off-main `Task.detached`; `OMRError.modelsNotBundled` → "recognition models are not installed").
- **Models**: homr `onnx_checkpoints` (SegNet fp16 29 MB, encoder fp16 26 MB on CoreML; decoder fp32 47 MB on CPU; ~102 MB), SHA-256 pinned in `ios/models.lock`, fetched by `ios/scripts/fetch-models` (copied from omr-sheet-cam) into gitignored `ios/models/`, copied into `GBKComposer.app/models/` by the "Bundle OMR models" build phase. Missing models: build warning, Scan shows the models error. `ios-release.yml` fetches them and sets `OMR_REQUIRE_MODELS=1`, so a release archive never ships without them.
- **Size decision**: bundle (simplest, works offline, ~+102 MB, under the 200 MB cellular limit). Follow-up if size matters: first-use download of the three `.onnx` files from a pinned URL (the homr release assets are .zip, so host unzipped copies) with SHA-256 check into Application Support, passing that directory as `modelsDirectory`.
- Package resources (tokenizers/vocab): 44 KB.

## Tests

- `ScanTests.swift`: Score → ops (empty and existing project, channels, read-only, nothing recognized, exact op JSON), SMF reader, bridge message decode / scripts, controller errors, and the real pipeline on `GBKComposerTests/Fixtures/c_major_scale.png` (omr-sheet-cam `fixtures/mono.c_major_scale`) asserting pitches 60 62 64 65 67 69 71 72. CI sets `OMR_REQUIRE_MODELS=1` so that test can't silently skip.
- `SnapshotTests.testScanEntryAndErrorLightAndDark`: `scan-entry`, `scan-error`, `scan-read-only` light/dark in the `ios-snapshots` artifact.
- Web: `test/native-scan-bridge.test.ts`.

## AGPL §13 note

§13 (remote network interaction) applies to a modified AGPL program that users interact with over a network. The iOS app runs on the device; it ships no server code. It calls the separately licensed compose.grepawk.com service over HTTPS and loads the studio web page, neither of which is derived from the AGPL iOS code, so §13 does not reach them. The obligation the app does carry is to offer corresponding source to users who receive the binary: Profile › About › Source code links to https://github.com/yishengjiang99/gbk/tree/main/ios.
