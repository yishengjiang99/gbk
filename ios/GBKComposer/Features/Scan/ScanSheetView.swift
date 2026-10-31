import AVFoundation
import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/// Presented as a sheet over the studio (never overlays the web toolbar/composer in place).
struct ScanSheetView: View {
    static var fixtureEnabled: Bool { ProcessInfo.processInfo.arguments.contains("-uiTestScanFixture") }
    @ObservedObject var controller: ScanController
    @State private var showCamera = false
    @State private var showPDF = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        Group {
            if case .working = controller.phase {
                // Music Reader parity: dark reading screen with its own Cancel pill — no
                // navigation title / toolbar in this state (see ScanWorkingView).
                ScanWorkingView(page: controller.scanningPage, state: controller.workingState) { controller.cancel() }
            } else {
                sheetBody
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            DocumentCamera { images in
                showCamera = false
                controller.recognize(images.compactMap(SheetPage.init(uiImage:)), source: .camera)
            } onCancel: { showCamera = false } onError: { e in
                showCamera = false; controller.fail(.failed(e.localizedDescription))
            }.ignoresSafeArea()
        }
        .fileImporter(isPresented: $showPDF, allowedContentTypes: [.pdf, .image]) { result in
            switch result {
            case .success(let url): controller.recognize(pagesFromFile(url), source: .file)
            case .failure(let e): controller.fail(.unreadableInput(e.localizedDescription))
            }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                var pages: [SheetPage] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data), let p = SheetPage(uiImage: img) { pages.append(p) }
                }
                photoItems = []
                if pages.isEmpty { controller.fail(.unreadableInput("the selected photo couldn't be opened")) } else { controller.recognize(pages, source: .photos) }
            }
        }
    }

    /// The light GBK sheet for the non-working phases (choose / done / error), unchanged.
    private var sheetBody: some View {
        NavigationStack {
            VStack(spacing: 18) {
                switch controller.phase {
                case .choose: choose
                case .working: EmptyView() // unreachable: `body` routes .working to ScanWorkingView
                case .done(let tracks, let notes):
                    Spacer()
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(Theme.accent)
                    Text("Added \(tracks) track\(tracks == 1 ? "" : "s") · \(notes) notes").foregroundStyle(Theme.text)
                    Spacer()
                case .error(let e): errorView(e)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Scan sheet music")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { controller.cancel() } } }
        }
    }

    private var choose: some View {
        VStack(spacing: 14) {
            Image(systemName: "music.note.list").font(.system(size: 44)).foregroundStyle(Theme.accent).padding(.top, 12)
            Text("Turn printed sheet music into a MIDI file and open it in the studio as a new song or new tracks.")
                .multilineTextAlignment(.center).foregroundStyle(Theme.textSecondary)
            Spacer().frame(height: 8)
            ScanOptionButton(title: "Scan with camera", icon: "doc.viewfinder", id: "scan-camera") { startCamera() }
            PhotosPicker(selection: $photoItems, maxSelectionCount: 10, matching: .images) {
                ScanOptionLabel(title: "Choose photos", icon: "photo.on.rectangle")
            }.accessibilityIdentifier("scan-photos")
            ScanOptionButton(title: "Import PDF or image", icon: "doc.richtext", id: "scan-pdf") { showPDF = true }
            if ScanSheetView.fixtureEnabled, let url = Bundle.main.url(forResource: "scan-fixture", withExtension: "png") {
                // UI tests only (-uiTestScanFixture): the simulator has no document camera.
                ScanOptionButton(title: "Use test sheet", icon: "testtube.2", id: "scan-fixture") {
                    if let img = UIImage(contentsOfFile: url.path), let p = SheetPage(uiImage: img) { controller.recognize([p], source: .fixture) }
                }
            }
            Spacer()
        }
    }

    private func errorView(_ e: ScanError) -> some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 44)).foregroundStyle(Theme.destructive)
            Text(e.localizedDescription).multilineTextAlignment(.center).foregroundStyle(Theme.text)
                .accessibilityIdentifier("scan-error")
            if e == .cameraDenied, let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url).foregroundStyle(Theme.accent)
            }
            Button("Try again") { controller.phase = .choose }.buttonStyle(.borderedProminent).tint(Theme.accent)
            Spacer()
        }
    }

    private func startCamera() {
        guard VNDocumentCameraViewController.isSupported else { controller.fail(.failed("this device has no document camera; import a photo or PDF")); return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: showCamera = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                Task { @MainActor in if ok { showCamera = true } else { controller.fail(.cameraDenied) } }
            }
        default: controller.fail(.cameraDenied)
        }
    }

    private func pagesFromFile(_ url: URL) -> [SheetPage] {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if let doc = PDFDocument(url: url) { return PDFPages.render(doc) }
        if let data = try? Data(contentsOf: url), let img = UIImage(data: data), let p = SheetPage(uiImage: img) { return [p] }
        return []
    }
}

/// The `.working` state, at layout parity with Music Reader's `ReadingView`: dark full-bleed
/// background, Cancel pill, the scanned page with an animated scan-line sweep, and a bottom
/// progress card. The accent is GBK's own `Theme.accent` instead of Music Reader's coral.
/// Colors are set explicitly (white on near-black) because the app is locked to Light
/// (Info.plist), so nothing here may rely on the color scheme.
///
/// Copy mirrors ReadingView, adapted to what GBK actually knows: while warming, a real
/// determinate fraction + ETA from `ScanModelWarmup` ("Warming up… x%"); while reading, the
/// homr parse emits no progress, so the bar is indeterminate and no percentage is shown.
struct ScanWorkingView: View {
    /// The first scanned page, when one was retained.
    let page: CGImage?
    let state: ScanController.WorkingState
    var onCancel: () -> Void

    /// "Warming up… 42%" (real warmup fraction) / "Reading the sheet music…" (no parse % exists).
    static func title(state: ScanController.WorkingState) -> String {
        switch state {
        case .warming(let fraction, _, _):
            return "Warming up… \(Int((min(max(fraction, 0), 1) * 100).rounded(.down)))%"
        case .reading:
            return "Reading the sheet music…"
        }
    }

    /// Subtitle under the bar; while warming up shows the ticking ETA when known.
    static func subtitle(state: ScanController.WorkingState) -> String {
        switch state {
        case .warming(_, let etaSeconds, let isRewarm):
            if isRewarm {
                if let eta = etaSeconds, eta > 1 {
                    return "About \(Int(eta.rounded())) seconds left · reloading the music models"
                }
                return "Reloading the music models on your iPhone"
            }
            if let eta = etaSeconds, eta > 1 {
                return "About \(Int(eta.rounded())) seconds left · one-time setup"
            }
            return "One-time setup — loading the music models on your iPhone"
        case .reading:
            return "This usually takes a few seconds"
        }
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep = false

    var body: some View {
        ZStack {
            Color(white: 0.07).ignoresSafeArea()
            VStack(spacing: 20) {
                HStack {
                    Button("Cancel", action: onCancel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.white.opacity(0.14), in: Capsule())
                        .accessibilityIdentifier("reading.cancel")
                    Spacer()
                }
                pageView
                Spacer(minLength: 0)
                card
            }
            .padding(20)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { sweep = true }
        }
    }

    @ViewBuilder
    private var pageView: some View {
        if let page {
            Image(uiImage: UIImage(cgImage: page))
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    GeometryReader { geo in
                        LinearGradient(colors: [Theme.accent.opacity(0), Theme.accent.opacity(0.35), Theme.accent.opacity(0)],
                                       startPoint: .top, endPoint: .bottom)
                            .frame(height: 60)
                            .overlay(Rectangle().fill(Theme.accent).frame(height: 2))
                            .offset(y: sweep ? geo.size.height - 30 : -30)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .allowsHitTesting(false)
                }
                .frame(maxHeight: 440)
                .accessibilityHidden(true)
        } else {
            // No retained page (defensive: recognize() always sets one) — a plain dark
            // placeholder in the page area, keeping the card layout identical.
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.08))
                .frame(maxWidth: .infinity)
                .frame(height: 240)
                .accessibilityHidden(true)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text(Self.title(state: state))
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .accessibilityIdentifier("reading.percent")
                Group {
                    if case .warming(let fraction, _, _) = state {
                        ProgressView(value: min(max(fraction, 0), 1))
                            .animation(.easeOut(duration: 0.25), value: fraction)
                    } else {
                        ProgressView()
                    }
                }
                .progressViewStyle(.linear)
                .tint(Theme.accent)
                Text(Self.subtitle(state: state))
                    .font(.subheadline).foregroundStyle(.white.opacity(0.7))
            }
            Label("Read on your iPhone. No internet needed.", systemImage: "lock.fill")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("reading.progress")
    }
}

enum PDFPages {
    /// Rasterizes up to `maxPages` at ~200 dpi on white.
    static func render(_ doc: PDFDocument, maxPages: Int = 10, dpi: CGFloat = 200) -> [SheetPage] {
        (0..<min(doc.pageCount, maxPages)).compactMap { i in
            guard let page = doc.page(at: i) else { return nil }
            let box = page.bounds(for: .mediaBox)
            let scale = dpi / 72
            let size = CGSize(width: box.width * scale, height: box.height * scale)
            let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
            let img = UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in
                UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
                ctx.cgContext.translateBy(x: 0, y: size.height); ctx.cgContext.scaleBy(x: scale, y: -scale)
                page.draw(with: .mediaBox, to: ctx.cgContext)
            }
            return img.cgImage.map(SheetPage.init(image:))
        }
    }
}

private struct ScanOptionLabel: View {
    let title: String, icon: String
    var body: some View {
        Label(title, systemImage: icon).font(.headline).frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(Theme.text).background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border))
    }
}

private struct ScanOptionButton: View {
    let title: String, icon: String, id: String, action: () -> Void
    var body: some View { Button(action: action) { ScanOptionLabel(title: title, icon: icon) }.accessibilityIdentifier(id) }
}

struct DocumentCamera: UIViewControllerRepresentable {
    var onScan: ([UIImage]) -> Void
    var onCancel: () -> Void
    var onError: (Error) -> Void
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController(); vc.delegate = context.coordinator; return vc
    }
    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentCamera
        init(_ p: DocumentCamera) { parent = p }
        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            parent.onScan((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
        }
        func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) { parent.onCancel() }
        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError e: Error) { parent.onError(e) }
    }
}
