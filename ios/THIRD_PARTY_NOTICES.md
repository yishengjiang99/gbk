# Third-party notices (GBK Composer for iOS)

The iOS app (`ios/`) is licensed AGPL-3.0-or-later (`ios/LICENSE`). It includes or downloads at build time:

| Component | Use | License | Source |
|---|---|---|---|
| omr-scan (OMRScanKit, OMRScanUI, omr-homr-ios) — SwiftPM package from yishengjiang99/omr-sheet-cam (pinned in `ios/project.yml`) | Sheet-music scan: recognition core, warmup, camera/import UI | AGPL-3.0 (`LICENSE`, `NOTICE` in that repo) | https://github.com/yishengjiang99/omr-sheet-cam |
| liebharc/homr | Algorithms, tokenizers and vocabulary that omr-homr-ios ports | AGPL-3.0 | https://github.com/liebharc/homr |
| homr ONNX checkpoints: SegNet `segnet_308-3296ccd…_fp16`, encoder `encoder_pytorch_model_465-597144c…_fp16`, decoder `decoder_pytorch_model_465-597144c…` (SHA-256 pinned in `ios/models.lock`, ~102 MB, bundled into the app at build time) | Recognition models | AGPL-3.0 (released with homr) | https://github.com/liebharc/homr/releases/tag/onnx_checkpoints |
| BreezeWhite/oemer | Credited by homr / omr-homr-ios (segmentation approach) | MIT | https://github.com/BreezeWhite/oemer |
| NetEase/Polyphonic-TrOMR | Credited by homr / omr-homr-ios (transformer recognizer) | MIT | https://github.com/NetEase/Polyphonic-TrOMR |
| ONNX Runtime (microsoft/onnxruntime-swift-package-manager 1.24.2, `onnxruntime.xcframework`) | Model inference (CoreML / CPU) | MIT (`ios/licenses/ONNXRuntime-LICENSE.txt`) | https://github.com/microsoft/onnxruntime-swift-package-manager |
| HearSheetCore (`ios/Packages/HearSheetCore`) | Hum transcription core | AGPL-3.0 (`ios/Packages/HearSheetCore/LICENSE`) | in this repo |
| sf2player-swift (`SF2Engine`, rev 6ce4941) | SoundFont engine | AGPL-3.0 | https://github.com/yishengjiang99/sf2player-swift |
| GeneralUser GS SoundFont (S. Christian Collins) | Instrument sounds, loaded by the studio web page from compose.grepawk.com (not bundled in the app binary) | GeneralUser GS License v2.0 (free use, including commercial; redistribution with its license) | https://schristiancollins.com/generaluser.php |

Apple system frameworks (SwiftUI, WebKit, VisionKit, PDFKit, PhotosUI, AVFoundation, StoreKit, CoreML) are used under the Apple SDK terms and are not redistributed.
