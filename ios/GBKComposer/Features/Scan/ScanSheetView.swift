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
        NavigationStack {
            VStack(spacing: 18) {
                switch controller.phase {
                case .choose: choose
                case .working:
                    Spacer()
                    ProgressView().controlSize(.large).tint(Theme.accent)
                    Text("Reading the sheet music…").foregroundStyle(Theme.textSecondary)
                    Spacer()
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
        .fullScreenCover(isPresented: $showCamera) {
            DocumentCamera { images in
                showCamera = false
                controller.recognize(images.compactMap(SheetPage.init(uiImage:)))
            } onCancel: { showCamera = false } onError: { e in
                showCamera = false; controller.fail(.failed(e.localizedDescription))
            }.ignoresSafeArea()
        }
        .fileImporter(isPresented: $showPDF, allowedContentTypes: [.pdf, .image]) { result in
            switch result {
            case .success(let url): controller.recognize(pagesFromFile(url))
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
                if pages.isEmpty { controller.fail(.unreadableInput("the selected photo couldn't be opened")) } else { controller.recognize(pages) }
            }
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
                    if let img = UIImage(contentsOfFile: url.path), let p = SheetPage(uiImage: img) { controller.recognize([p]) }
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
