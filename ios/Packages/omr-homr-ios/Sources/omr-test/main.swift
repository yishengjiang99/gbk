// omr-test — thin, non-interactive fixture runner (docs/TESTING.md "Addendum: agent / CLI TDD loop").
//
//   omr-test --no-onnx [--fixtures DIR] [--tier TIER] [fixtures/<id> | <id> ...]
//       Writer-only: expected.tokens.json → SMFWriter → SMFNoteReader → diff expected.notes.csv.
//   omr-test [--fixtures DIR] [--models DIR] [fixtures/<id> ...]
//       ONNX path (staff image → tokens). Exits 3 where no ORT backend is linked.
//   omr-test decode-staff <staff.npy | staff.f32> [--models DIR] [--expected FILE] [--json]
//       StaffTensor → StaffInferenceSession.decodeStaff (encoder fp16 → cast → decoder fp32 CPU);
//       prints raw rhythm/pitch/lift/articulation per symbol + token edit distance vs
//       expected.tokens.json (default: next to the input). 0 = exact match, 1 = mismatch.
//       A .png input is preprocessed in Swift first (StaffTensor.fromStaffImage, homr canvas + ConvertToArray);
//       with --geometry <json> the .png is a full page and goes through StaffTensor.fromPage
//       (prepare_staff_image crop + dewarp, then the canvas).
//   omr-test preprocess-staff <staff.png> [--compare staff.npy] [--out staff.npy]
//       PNG → cv2-equivalent grayscale → StaffTensor.fromStaffImage; prints shape and, with --compare,
//       max/mean abs diff and count(|diff| > 1e-3). 0 = max abs diff <= one gray level (~1/(255*0.1738)).
//   omr-test segnet-page <page.png> [--compare ORACLE_DIR] [--threads N] [--models DIR]
//       Page preprocessing (homr autocrop -> PIL bicubic resize to 1920 wide -> CLAHE) + SegNet fp16 tiling
//       and merge (PagePipeline). With --compare (fixtures/oracle.pages/<id>): resized/preprocessed pixel
//       mismatches and per-class SegNet mismatch counts vs segnet.png. 0 = preprocessing identical
//       (SegNet mismatches are reported, not gated). --threads = SegNet ORT intra-op threads (default: cores).
//   omr-test detect-staffs <ORACLE_DIR>
//       homr staff detection (PagePipeline.detectStaffs) on ORACLE_DIR/segnet.png; compares symbol boxes,
//       note-head height, staff grids, multi-staffs / grand staffs, ensured rows and per-staff geometry
//       against ORACLE_DIR/stages.json. 0 = identical to homr, 1 = any difference.
//   omr-test parse-page <page.png> [--compare ORACLE_DIR] [--out song.mid] [--threads N] [--models DIR]
//       Full page (PageInferenceSession.parsePage, all CPU): preprocessing -> SegNet -> staff detection -> per-staff
//       crop/dewarp + decode -> homr voices -> SMF + noteLayout; prints stage timings, voices and SMF checks. With
//       --compare fixtures/oracle.pages/<id>: per-staff canvas SHA-256, raw / position-filtered symbols and voices
//       vs stages.json (edit distances). 0 = valid SMF (+ identical to homr with --compare).
//   omr-test prepare-staff <page.png> --geometry <geometry.json> [--compare prepared.npy] [--out prepared.npy]
//       homr prepare_staff_image (crop + dewarp, StaffPrepare) on a grayscale page with explicit staff
//       geometry; with --compare prints max abs diff (gray levels) and count(|diff| > 1). 0 = identical.
//
// Exit codes: 0 all selected fixtures passed (SKIP does not fail) · 1 a fixture failed ·
//             2 usage / input error · 3 ONNX path not runnable on this platform yet.
import Foundation
import OMRHomrIOS

#if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
// ORT C API on both platforms. Linux (`scripts/fetch-ort`): CPU EP only. Apple: CoreML EP for the
// encoder (CPU fallback), decoder always CPU. 1 intra-op thread by default
// (`OMR_ORT_INTRA_OP_THREADS`) for run-to-run deterministic logits.
typealias PlatformORTBackend = ORTCSession
let hasORT = true
#else
let hasORT = false
#endif

// MARK: - Output / exit helpers

func out(_ s: String) { print(s) }
func err(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }
func exitUsage(_ msg: String) -> Never {
    err("omr-test: \(msg)")
    err(usage)
    exit(2)
}
func exitNotRunnable(_ detail: String) -> Never {
    out("ONNX path not runnable on this platform yet")
    err("omr-test: \(detail)")
    exit(3)
}

let usage = """
usage: omr-test --no-onnx [--fixtures DIR] [--tier TIER] [fixtures/<id> | <id> ...]
       omr-test [--fixtures DIR] [--models DIR] [fixtures/<id> ...]       (ONNX path)
       omr-test decode-staff <staff.npy|staff.f32|staff.png | page.png --geometry JSON> [--models DIR] [--expected FILE] [--json]
       omr-test preprocess-staff <staff.png> [--compare staff.npy] [--out staff.npy]
       omr-test prepare-staff <page.png> --geometry <geometry.json> [--compare prepared.npy] [--out prepared.npy]
       omr-test segnet-page <page.png> [--compare ORACLE_DIR] [--threads N] [--models DIR]
       omr-test detect-staffs <ORACLE_DIR>   (homr staff detection on ORACLE_DIR/segnet.png vs stages.json)
       omr-test parse-page <page.png> [--compare ORACLE_DIR] [--out song.mid] [--threads N] [--models DIR]
exit: 0 pass · 1 fail · 2 usage/input error · 3 ONNX path not runnable on this platform yet
"""

// MARK: - Arg parsing

var args = Array(CommandLine.arguments.dropFirst())
var noONNX = false
var fixturesOverride: String?
var modelsOverride: String?
var tierFilter: String?
var jsonOut = false
var expectedOverride: String?
var compareNPY: String?
var outNPY: String?
var geometryJSON: String?
var segnetThreads = ProcessInfo.processInfo.activeProcessorCount
var positional: [String] = []
while !args.isEmpty {
    let a = args.removeFirst()
    switch a {
    case "--no-onnx": noONNX = true
    case "--json": jsonOut = true
    case "--fixtures":
        guard !args.isEmpty else { exitUsage("--fixtures needs a directory") }
        fixturesOverride = args.removeFirst()
    case "--models":
        guard !args.isEmpty else { exitUsage("--models needs a directory") }
        modelsOverride = args.removeFirst()
    case "--expected":
        guard !args.isEmpty else { exitUsage("--expected needs a file") }
        expectedOverride = args.removeFirst()
    case "--compare":
        guard !args.isEmpty else { exitUsage("--compare needs a .npy file") }
        compareNPY = args.removeFirst()
    case "--out":
        guard !args.isEmpty else { exitUsage("--out needs a .npy path") }
        outNPY = args.removeFirst()
    case "--geometry":
        guard !args.isEmpty else { exitUsage("--geometry needs a .json file") }
        geometryJSON = args.removeFirst()
    case "--threads":
        guard !args.isEmpty, let n = Int(args.removeFirst()), n >= 0 else { exitUsage("--threads needs a count (0 = ORT default)") }
        segnetThreads = n
    case "--tier":
        guard !args.isEmpty else { exitUsage("--tier needs a value") }
        tierFilter = args.removeFirst()
    case "-h", "--help":
        out(usage)
        exit(0)
    default:
        if a.hasPrefix("-") { exitUsage("unknown option \(a)") }
        positional.append(a)
    }
}

// MARK: - Repo discovery

let fm = FileManager.default
let cwd = URL(fileURLWithPath: fm.currentDirectoryPath)

func isDir(_ url: URL) -> Bool {
    var d: ObjCBool = false
    return fm.fileExists(atPath: url.path, isDirectory: &d) && d.boolValue
}

/// Walk up from cwd until `<dir>/<name>` exists.
func findUp(_ name: String) -> URL? {
    var dir = cwd.standardizedFileURL
    while true {
        let c = dir.appendingPathComponent(name)
        if isDir(c) { return c }
        let parent = dir.deletingLastPathComponent()
        if parent.path == dir.path { return nil }
        dir = parent
    }
}

func resolveDir(_ override: String?, _ name: String) -> URL? {
    if let o = override {
        let u = URL(fileURLWithPath: o, relativeTo: cwd).standardizedFileURL
        return isDir(u) ? u : nil
    }
    return findUp(name)
}

// MARK: - Model discovery + backend

struct ModelFiles { var encoderFP16: URL; var decoderFP32: URL; var segnetFP16: URL? }

/// Pinned models: file names from repo-root `models.lock` (`<sha256>  <file>  <url>`), files in
/// `models/` (or `--models DIR`). Falls back to a directory scan when no models.lock is found.
func findModels() -> ModelFiles? {
    guard let dir = resolveDir(modelsOverride, "models") else { return nil }
    var names: [String] = []
    let lock = dir.deletingLastPathComponent().appendingPathComponent("models.lock")
    if let text = try? String(contentsOf: lock, encoding: .utf8) {
        for line in text.split(whereSeparator: \.isNewline) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t.hasPrefix("#") { continue }
            let f = t.split(whereSeparator: { $0 == " " || $0 == "\t" })
            if f.count >= 2 { names.append(String(f[1])) }
        }
    } else {
        names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
    }
    let enc = names.filter { $0.hasPrefix("encoder_") && $0.hasSuffix("_fp16.onnx") }.sorted().last
    let dec = names.filter { $0.hasPrefix("decoder_") && $0.hasSuffix(".onnx") && !$0.hasSuffix("_fp16.onnx") }
        .sorted().last
    guard let enc, let dec else { return nil }
    let seg = names.filter { $0.hasPrefix("segnet_") && $0.hasSuffix("_fp16.onnx") }.sorted().last
        .map { dir.appendingPathComponent($0) }.flatMap { fm.fileExists(atPath: $0.path) ? $0 : nil }
    let m = ModelFiles(encoderFP16: dir.appendingPathComponent(enc), decoderFP32: dir.appendingPathComponent(dec),
                       segnetFP16: seg)
    guard fm.fileExists(atPath: m.encoderFP16.path), fm.fileExists(atPath: m.decoderFP32.path) else { return nil }
    return m
}

/// Gate-1 entry: encoder fp16 (CPU on Linux; CoreML EP w/ CPU fallback on Apple) →
/// `castToFP32ForDecoder()` → decoder fp32 ORT CPU → raw symbols (EOS excluded).
func decodeStaff(tensor: StaffTensor, models: ModelFiles, vocab: HomrVocabulary) throws -> [EncodedSymbol] {
    #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
    #if canImport(CoreML) && canImport(CONNXRuntimeApple)
    // Not `(try? a) ?? (try b)`: `??` is rethrows, so that form needs an outer `try` (macOS build error).
    let encoder: PlatformORTBackend
    if let coreML = try? PlatformORTBackend(modelURL: models.encoderFP16, provider: .coreML) {
        encoder = coreML
    } else {
        encoder = try PlatformORTBackend(modelURL: models.encoderFP16, provider: .cpu)
    }
    #else
    let encoder = try PlatformORTBackend(modelURL: models.encoderFP16, provider: .cpu)
    #endif
    let decoder = try PlatformORTBackend(modelURL: models.decoderFP32, provider: .cpu)
    let session = try StaffInferenceSession(encoder: encoder, decoder: decoder, vocabulary: vocab)
    return try session.decodeStaff(tensor: tensor)
    #else
    exitNotRunnable("no ORTSessionBackend is linked on this platform (Linux: run scripts/fetch-ort, see docs/ORT-LINUX.md)")
    #endif
}

func requireONNX() -> ModelFiles {
    guard hasORT else {
        exitNotRunnable("no ORTSessionBackend is linked on this platform (Linux: run scripts/fetch-ort, see docs/ORT-LINUX.md)")
    }
    guard let m = findModels() else {
        exitNotRunnable("pinned models not found (run scripts/fetch-models or pass --models DIR)")
    }
    return m
}

// MARK: - Staff tensor input

/// Load a normalized fp32 NCHW [1,1,256,1280] staff tensor (`.npy` via `StaffTensor.loadNPY`,
/// or raw little-endian fp32 `.f32`).
func loadStaffTensor(_ path: String) -> StaffTensor {
    let url = URL(fileURLWithPath: path, relativeTo: cwd)
    switch url.pathExtension.lowercased() {
    case "f32", "bin", "raw":
        guard let d = try? Data(contentsOf: url) else { exitUsage("cannot read \(path)") }
        let n = StaffInputSpec.elementCount
        guard d.count == n * 4 else { exitUsage("\(path): \(d.count) bytes, want \(n * 4) (fp32 \(StaffInputSpec.nchwShape))") }
        let values: [Float] = d.withUnsafeBytes { raw in
            (0..<n).map { Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))) }
        }
        do { return try StaffTensor(values: values, shape: StaffInputSpec.nchwShape) } catch { exitUsage("\(path): \(error)") }
    case "npy":
        do { return try StaffTensor.loadNPY(url) } catch { exitUsage("\(path): \(error)") }
    case "png":
        return preprocessPNG(path)
    default:
        exitUsage("\(path): expected .npy, .f32 or .png")
    }
}

/// PNG → `StaffTensor.fromStaffImage(pngURL:)` (package PNG decoder, cv2 imread + BGR2GRAY semantics).
func preprocessPNG(_ path: String) -> StaffTensor {
    do {
        return try StaffTensor.fromStaffImage(pngURL: URL(fileURLWithPath: path, relativeTo: cwd))
    } catch { exitUsage("\(path): \(error)") }
}

/// Minimal `.npy` v1 writer (`<f4`, C order) for `preprocess-staff --out`.
func writeNPY(_ t: StaffTensor, to path: String) throws {
    var header = "{'descr': '<f4', 'fortran_order': False, 'shape': (\(t.shape.map(String.init).joined(separator: ", ")))}, }"
    let total = 10 + header.utf8.count + 1
    header += String(repeating: " ", count: (64 - total % 64) % 64) + "\n"
    var d = Data([0x93]) + Data("NUMPY".utf8) + Data([1, 0])
    let hl = UInt16(header.utf8.count)
    d.append(contentsOf: [UInt8(hl & 0xFF), UInt8(hl >> 8)])
    d.append(Data(header.utf8))
    d.append(t.float32LEData)
    try d.write(to: URL(fileURLWithPath: path, relativeTo: cwd))
}

// MARK: - Fixtures

struct TokenFile: Decodable {
    var status: String?
    var symbols: [OracleSymbolFields]
}

struct Note: Hashable, Comparable, CustomStringConvertible {
    var tick: Int, pitch: Int, duration: Int, staff: Int?
    static func < (a: Note, b: Note) -> Bool {
        (a.tick, a.staff ?? -1, a.pitch, a.duration) < (b.tick, b.staff ?? -1, b.pitch, b.duration)
    }
    var description: String {
        "(t\(tick) p\(pitch) d\(duration)" + (staff.map { " s\($0)" } ?? "") + ")"
    }
}

func readMeta(_ dir: URL) -> [String: String] {
    guard let s = try? String(contentsOf: dir.appendingPathComponent("meta.yaml"), encoding: .utf8) else { return [:] }
    var m: [String: String] = [:]
    for line in s.split(separator: "\n") where !line.hasPrefix(" ") && !line.hasPrefix("#") {
        guard let i = line.firstIndex(of: ":") else { continue }
        let k = line[..<i].trimmingCharacters(in: .whitespaces)
        var v = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
        if v.hasPrefix("\""), v.hasSuffix("\""), v.count >= 2 { v = String(v.dropFirst().dropLast()) }
        m[k] = v
    }
    return m
}

func readCSV(_ url: URL) throws -> [Note] {
    let s = try String(contentsOf: url, encoding: .utf8)
    var outNotes: [Note] = []
    for (i, line) in s.split(whereSeparator: \.isNewline).enumerated() {
        let f = line.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        if i == 0 && f.first == "tick" { continue }
        guard f.count >= 4, let t = Int(f[0]), let p = Int(f[1]), let d = Int(f[2]), let st = Int(f[3]) else {
            throw NSError(domain: "omr-test", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(url.lastPathComponent):\(i + 1): bad row '\(line)'"])
        }
        outNotes.append(Note(tick: t, pitch: p, duration: d, staff: st))
    }
    return outNotes
}

func levenshtein<T: Equatable>(_ a: [T], _ b: [T]) -> Int {
    if a.isEmpty { return b.count }
    if b.isEmpty { return a.count }
    var prev = Array(0...b.count)
    var cur = [Int](repeating: 0, count: b.count + 1)
    for i in 1...a.count {
        cur[0] = i
        for j in 1...b.count {
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
        }
        swap(&prev, &cur)
    }
    return prev[b.count]
}

enum Verdict: String { case pass = "PASS", fail = "FAIL", skip = "SKIP" }

/// Writer-only run of one fixture.
func runWriterOnly(id: String, dir: URL, tier: String, vocab: HomrVocabulary) -> Verdict {
    let tokensURL = dir.appendingPathComponent("expected.tokens.json")
    let csvURL = dir.appendingPathComponent("expected.notes.csv")
    guard let data = try? Data(contentsOf: tokensURL),
          let tf = try? JSONDecoder().decode(TokenFile.self, from: data) else {
        out("SKIP \(id) [\(tier)] no readable expected.tokens.json")
        return .skip
    }
    let status = tf.status ?? "unknown"
    if status == "stub" || status == "awaiting_oracle_export" || status != "complete" || tf.symbols.isEmpty {
        out("SKIP \(id) [\(tier)] tokens status=\(status) symbols=\(tf.symbols.count) — no writer input")
        return .skip
    }
    guard let expected = try? readCSV(csvURL) else {
        out("FAIL \(id) [\(tier)] cannot read expected.notes.csv")
        return .fail
    }
    // Vocab gate: never write tokens outside vocabulary.json.
    var vocabErrors: [String] = []
    for (i, s) in tf.symbols.enumerated() {
        for (field, value, table) in [
            ("rhythm", s.rhythm, vocab.rhythm), ("pitch", s.pitch, vocab.pitch), ("lift", s.lift, vocab.lift),
            ("articulation", s.articulation, vocab.articulation), ("slur", s.slur, vocab.slur),
            ("position", s.position, vocab.position),
        ] where table[value] == nil {
            vocabErrors.append("#\(i) \(field)='\(value)'")
        }
    }

    let symbols = tf.symbols.map { EncodedSymbol(oracleFields: $0) }
    let smf = SMFWriter().write(symbols: symbols)
    let contents: SMFNoteReader.Contents
    do {
        contents = try SMFNoteReader.read(from: smf)
    } catch {
        out("FAIL \(id) [\(tier)] SMFNoteReader: \(error)")
        return .fail
    }
    let compareStaff = contents.noteTrackCount > 1
    let got = contents.notes.map {
        Note(tick: $0.tick, pitch: $0.pitch, duration: $0.duration, staff: compareStaff ? contents.staff(of: $0) : nil)
    }.sorted()
    let want = expected.map {
        Note(tick: $0.tick, pitch: $0.pitch, duration: $0.duration, staff: compareStaff ? $0.staff : nil)
    }.sorted()
    let midiDist = levenshtein(got, want)

    // Multiset diff for the report.
    var remaining = want
    var extra: [Note] = []
    for n in got {
        if let i = remaining.firstIndex(of: n) { remaining.remove(at: i) } else { extra.append(n) }
    }
    let verdict: Verdict = tier == "snapshot" ? .pass : (midiDist == 0 && vocabErrors.isEmpty ? .pass : .fail)
    let fields = compareStaff ? "tick,pitch,duration,staff" : "tick,pitch,duration"
    out("\(verdict.rawValue) \(id) [\(tier)] token_edit=n/a midi_edit=\(midiDist) notes=\(got.count)/\(want.count) "
        + "tracks=\(contents.parsedTrackCount) compared=(\(fields))")
    for e in vocabErrors { out("    vocab: not in vocabulary.json: \(e)") }
    for n in remaining { out("    - missing \(n)") }
    for n in extra { out("    + extra   \(n)") }
    return verdict
}

// MARK: - Commands

let vocab: HomrVocabulary
do {
    vocab = try TokenizerLoader.loadVocabulary()
} catch {
    err("omr-test: cannot load vocabulary: \(error)")
    exit(2)
}

if positional.first == "preprocess-staff" {
    guard positional.count == 2 else { exitUsage("preprocess-staff needs exactly one .png") }
    guard positional[1].lowercased().hasSuffix(".png") else { exitUsage("preprocess-staff: \(positional[1]) is not a .png") }
    let t0 = Date()
    let tensor = preprocessPNG(positional[1])
    let ms = Date().timeIntervalSince(t0) * 1000
    out("preprocess-staff: \(URL(fileURLWithPath: positional[1], relativeTo: cwd).standardizedFileURL.path)")
    out("shape: \(tensor.shape) fp32 (\(String(format: "%.1f", ms)) ms)")
    if let o = outNPY {
        do { try writeNPY(tensor, to: o) } catch { exitUsage("--out \(o): \(error)") }
        out("wrote: \(o)")
    }
    guard let cmp = compareNPY else { exit(0) }
    let ref: StaffTensor
    do { ref = try StaffTensor.loadNPY(URL(fileURLWithPath: cmp, relativeTo: cwd)) } catch { exitUsage("\(cmp): \(error)") }
    let d = StaffTensorDiff(tensor, ref)
    out("compare: \(cmp) shape \(ref.shape)")
    out(String(format: "max_abs_diff=%.9g mean_abs_diff=%.9g count_gt_1e-3=%d / %d",
               d.maxAbs, d.meanAbs, d.countAbove1e3, d.count))
    out(String(format: "tolerance: max_abs_diff <= %.9g (one gray level after ConvertToArray: largest fp32 step "
               + "of (p/255-0.7931)/0.1738, nominal 1/(255*0.1738) = %.9g)",
               StaffTensorDiff.oneGrayLevel, 1.0 / (255.0 * 0.1738)))
    if d.withinOneGrayLevel {
        out("PASS within tolerance")
        exit(0)
    }
    out("FAIL exceeds tolerance")
    exit(1)
}

if positional.first == "segnet-page" {
    guard positional.count == 2 else { exitUsage("segnet-page needs exactly one page .png") }
    let url = URL(fileURLWithPath: positional[1], relativeTo: cwd)
    var t0 = Date()
    let page: PagePipeline.PreprocessedPage
    do { page = try PagePipeline.preprocess(pngURL: url) } catch { exitUsage("\(positional[1]): \(error)") }
    out("segnet-page: \(url.standardizedFileURL.path)")
    out("autocrop: \(page.cropped ? "cropped" : "full page") \(page.crop) -> resized \(page.width)x\(page.height) "
        + "(\(String(format: "%.0f", Date().timeIntervalSince(t0) * 1000)) ms incl. PNG decode)")
    var failed = false
    var oracle: URL?
    if let c = compareNPY {
        let dir = URL(fileURLWithPath: c, relativeTo: cwd)
        oracle = dir
        for (name, got) in [("resized.png", page.resized), ("preprocessed.png", page.preprocessed)] {
            guard let d = try? Data(contentsOf: dir.appendingPathComponent(name)),
                  let ref = try? PagePipeline.decodeGrayPNG(d) else { exitUsage("\(name) missing in \(dir.path)") }
            let ne = ref.width == page.width && ref.height == page.height
                ? zip(ref.pixels, got).filter { $0 != $1 }.count : -1
            out("compare \(name): \(ne == 0 ? "identical" : (ne < 0 ? "size mismatch \(ref.width)x\(ref.height)" : "\(ne) pixels differ"))")
            if ne != 0 { failed = true }
        }
    }
    let models = requireONNX()
    guard let segURL = models.segnetFP16 else { exitNotRunnable("SegNet model not found (run scripts/fetch-models)") }
    #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
    let merged: [UInt8]
    do {
        let backend = try PlatformORTBackend(modelURL: segURL, provider: .cpu, intraOpThreads: segnetThreads)
        t0 = Date()
        merged = try PagePipeline.segment(page, segnet: SegNetSession(backend: backend))
    } catch { err("omr-test: segnet failed: \(error)"); exit(1) }
    let tiles = SegNetSession.tileCount(width: page.width, height: page.height)
    out("segnet: \(tiles) tiles, \(String(format: "%.0f", Date().timeIntervalSince(t0) * 1000)) ms "
        + "(CPU, \(segnetThreads) intra-op threads) \(segURL.lastPathComponent)")
    var counts = [Int](repeating: 0, count: 6)
    for v in merged { counts[Int(v)] += 1 }
    out("class_counts: \(counts)")
    if let dir = oracle {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("segnet.png")),
              let ref = try? PagePipeline.decodeGrayPNG(d), ref.pixels.count == merged.count else {
            exitUsage("segnet.png missing or wrong size in \(dir.path)")
        }
        var confusion = [[Int]](repeating: [Int](repeating: 0, count: 6), count: 6)
        for i in 0..<merged.count { confusion[Int(ref.pixels[i])][Int(merged[i])] += 1 }
        let names = ["background", "stems_rests", "notehead", "clefs_keys", "staff", "symbols"]
        var total = 0
        for c in 0..<6 {
            let want = confusion[c].reduce(0, +)
            let got = (0..<6).map { confusion[$0][c] }.reduce(0, +)
            let missed = want - confusion[c][c], extra = got - confusion[c][c]
            total += missed
            out("class \(c) \(names[c]): oracle \(want) swift \(got) missed \(missed) extra \(extra)")
        }
        out("segnet_mismatch_pixels=\(total) / \(merged.count)")
    }
    #endif
    exit(failed ? 1 : 0)
}

if positional.first == "detect-staffs" {
    guard positional.count == 2 else { exitUsage("detect-staffs needs exactly one oracle directory") }
    let dir = URL(fileURLWithPath: positional[1], relativeTo: cwd)
    guard let sd = try? Data(contentsOf: dir.appendingPathComponent("segnet.png")),
          let seg = try? PagePipeline.decodeGrayPNG(sd) else { exitUsage("segnet.png missing in \(dir.path)") }
    let stages: StaffLayoutCompare.Stages
    do { stages = try StaffLayoutCompare.load(dir.appendingPathComponent("stages.json")) } catch {
        exitUsage("stages.json missing/unreadable in \(dir.path): \(error)")
    }
    let t0 = Date()
    let layout: PageStaffLayout
    do { layout = try PagePipeline.detectStaffs(segmentation: seg.pixels, width: seg.width, height: seg.height) } catch {
        err("omr-test: detect-staffs failed: \(error)"); exit(1)
    }
    out("detect-staffs: \(dir.standardizedFileURL.path) \(seg.width)x\(seg.height) "
        + "(\(String(format: "%.0f", Date().timeIntervalSince(t0) * 1000)) ms)")
    let report = StaffLayoutCompare.compare(layout, stages)
    for line in report.lines { out(line) }
    out(report.ok ? "PASS identical to homr" : "FAIL differs from homr")
    exit(report.ok ? 0 : 1)
}

if positional.first == "parse-page" {
    guard positional.count == 2 else { exitUsage("parse-page needs exactly one page .png") }
    let models = requireONNX()
    guard let segURL = models.segnetFP16 else { exitNotRunnable("SegNet model not found (run scripts/fetch-models)") }
    #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
    let vocab: HomrVocabulary
    do { vocab = try TokenizerLoader.loadVocabulary() } catch { err("omr-test: vocabulary: \(error)"); exit(1) }
    let session: PageInferenceSession
    do {
        let seg = try PlatformORTBackend(modelURL: segURL, provider: .cpu, intraOpThreads: segnetThreads)
        let enc = try PlatformORTBackend(modelURL: models.encoderFP16, provider: .cpu)
        let dec = try PlatformORTBackend(modelURL: models.decoderFP32, provider: .cpu)
        session = try PageInferenceSession(segnet: seg, encoder: enc, decoder: dec, vocabulary: vocab)
    } catch { err("omr-test: model load failed: \(error)"); exit(1) }
    out("models: \(segURL.lastPathComponent) | \(models.encoderFP16.lastPathComponent) | \(models.decoderFP32.lastPathComponent) (all CPU)")
    let code = PageParseCommand.run(
        session: session, pageURL: URL(fileURLWithPath: positional[1], relativeTo: cwd),
        oracle: compareNPY.map { URL(fileURLWithPath: $0, relativeTo: cwd) },
        midiOut: outNPY.map { URL(fileURLWithPath: $0, relativeTo: cwd) }, verbose: jsonOut)
    exit(code)
    #else
    exitNotRunnable("no ORTSessionBackend is linked on this platform")
    #endif
}

if positional.first == "prepare-staff" {
    guard positional.count == 2 else { exitUsage("prepare-staff needs exactly one page .png") }
    guard let geo = geometryJSON else { exitUsage("prepare-staff needs --geometry <json>") }
    let url = URL(fileURLWithPath: positional[1], relativeTo: cwd)
    let geometry: StaffGeometry
    do { geometry = try StaffPrepare.loadGeometry(URL(fileURLWithPath: geo, relativeTo: cwd)) } catch { exitUsage("\(geo): \(error)") }
    let t0 = Date()
    let r: StaffPrepare.Result
    do {
        r = try StaffPrepare.prepareStaffImage(pngURL: url, geometry: geometry)
    } catch let e as StaffTensor.PNGLoadError {
        exitUsage("\(positional[1]): \(e)")
    } catch { err("omr-test: prepare-staff failed: \(error)"); exit(1) }
    let ms = Date().timeIntervalSince(t0) * 1000
    out("prepare-staff: \(url.standardizedFileURL.path)")
    out("prepared: \(r.width)x\(r.height) uint8, canvas size \(r.canvasWidth)x\(r.canvasHeight) (\(String(format: "%.1f", ms)) ms)")
    if let o = outNPY {
        var header = "{'descr': '|u1', 'fortran_order': False, 'shape': (\(r.height), \(r.width)), }"
        header += String(repeating: " ", count: (64 - (10 + header.utf8.count + 1) % 64) % 64) + "\n"
        var d = Data([0x93]) + Data("NUMPY".utf8) + Data([1, 0])
        d.append(contentsOf: [UInt8(header.utf8.count & 0xFF), UInt8(header.utf8.count >> 8)])
        d.append(Data(header.utf8)); d.append(contentsOf: r.pixels)
        do { try d.write(to: URL(fileURLWithPath: o, relativeTo: cwd)) } catch { exitUsage("--out \(o): \(error)") }
        out("wrote: \(o)")
    }
    guard let cmp = compareNPY else { exit(0) }
    let ref: (pixels: [UInt8], width: Int, height: Int)
    do { ref = try StaffPrepare.loadGrayNPY(URL(fileURLWithPath: cmp, relativeTo: cwd)) } catch { exitUsage("\(cmp): \(error)") }
    out("compare: \(cmp) \(ref.width)x\(ref.height)")
    guard ref.width == r.width, ref.height == r.height else {
        out("FAIL shape mismatch: got \(r.width)x\(r.height), expected \(ref.width)x\(ref.height)")
        exit(1)
    }
    var maxDiff = 0, over1 = 0, nonzero = 0
    for i in 0..<ref.pixels.count {
        let d = abs(Int(ref.pixels[i]) - Int(r.pixels[i]))
        maxDiff = max(maxDiff, d)
        if d > 1 { over1 += 1 }
        if d > 0 { nonzero += 1 }
    }
    out("max_abs_diff=\(maxDiff) count_gt_1=\(over1) count_ne=\(nonzero) / \(ref.pixels.count) (uint8 gray levels)")
    if maxDiff == 0 { out("PASS identical"); exit(0) }
    out("FAIL differs")
    exit(1)
}

if positional.first == "decode-staff" {
    guard positional.count == 2 else { exitUsage("decode-staff needs exactly one input file") }
    let tensor: StaffTensor
    if let geo = geometryJSON {
        guard positional[1].lowercased().hasSuffix(".png") else { exitUsage("decode-staff --geometry needs a page .png") }
        do {
            let g = try StaffPrepare.loadGeometry(URL(fileURLWithPath: geo, relativeTo: cwd))
            tensor = try StaffTensor.fromPage(pngURL: URL(fileURLWithPath: positional[1], relativeTo: cwd), geometry: g)
        } catch { exitUsage("\(positional[1]) --geometry \(geo): \(error)") }
    } else {
        tensor = loadStaffTensor(positional[1])
    }
    // Oracle: --expected FILE, else expected.tokens.json next to the input tensor.
    let inputURL = URL(fileURLWithPath: positional[1], relativeTo: cwd).standardizedFileURL
    let expectedURL = expectedOverride.map { URL(fileURLWithPath: $0, relativeTo: cwd).standardizedFileURL }
        ?? inputURL.deletingLastPathComponent().appendingPathComponent("expected.tokens.json")
    let models = requireONNX()
    let symbols: [EncodedSymbol]
    do {
        symbols = try decodeStaff(tensor: tensor, models: models, vocab: vocab)
    } catch {
        err("omr-test: decode-staff failed: \(error)")
        exit(1)
    }
    if jsonOut {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let body = try? enc.encode(OracleSymbolSequence(encoded: symbols).symbols) {
            out(String(decoding: body, as: UTF8.self))
        }
    }
    out("decode-staff: \(inputURL.path)")
    out("models: \(models.encoderFP16.lastPathComponent) (fp16) | \(models.decoderFP32.lastPathComponent) (fp32 CPU)")
    out("# idx\trhythm\tpitch\tlift\tarticulation")
    for (i, s) in symbols.enumerated() {
        out("\(i)\t\(s.rhythm)\t\(s.pitch)\t\(s.lift)\t\(s.articulation)")
    }
    out("symbols: \(symbols.count)")
    struct FourStreams: Equatable { var rhythm, pitch, lift, articulation: String }
    let got = symbols.map { FourStreams(rhythm: $0.rhythm, pitch: $0.pitch, lift: $0.lift, articulation: $0.articulation) }
    guard let data = try? Data(contentsOf: expectedURL),
          let tf = try? JSONDecoder().decode(TokenFile.self, from: data), !tf.symbols.isEmpty else {
        out("expected: \(expectedURL.path) missing/unreadable; token_edit=n/a")
        exit(1)
    }
    let want = tf.symbols.map { FourStreams(rhythm: $0.rhythm, pitch: $0.pitch, lift: $0.lift, articulation: $0.articulation) }
    let dist = levenshtein(got, want)
    let perStream = [
        ("rhythm", levenshtein(got.map(\.rhythm), want.map(\.rhythm))),
        ("pitch", levenshtein(got.map(\.pitch), want.map(\.pitch))),
        ("lift", levenshtein(got.map(\.lift), want.map(\.lift))),
        ("articulation", levenshtein(got.map(\.articulation), want.map(\.articulation))),
    ].map { "\($0.0)=\($0.1)" }.joined(separator: " ")
    out("expected: \(expectedURL.path) (\(want.count) symbols)")
    out("token_edit=\(dist) (symbol = rhythm/pitch/lift/articulation tuple; per stream: \(perStream))")
    if dist == 0 {
        out("PASS exact match")
        exit(0)
    }
    let common: Int = min(got.count, want.count)
    let firstDiff: Int? = (0..<common).first(where: { got[$0] != want[$0] })
    let lengthDiff: Int? = got.count != want.count ? common : nil
    if let i = firstDiff ?? lengthDiff {
        let g = i < got.count ? "\(got[i])" : "<end>"
        let w = i < want.count ? "\(want[i])" : "<end>"
        out("first mismatch at symbol \(i): got \(g) want \(w)")
    }
    out("FAIL token mismatch")
    exit(1)
}

guard let fixturesRoot = resolveDir(fixturesOverride, "fixtures") else {
    exitUsage("fixtures/ not found walking up from \(cwd.path) (use --fixtures DIR)")
}

var selected: [String]
if positional.isEmpty {
    selected = ((try? fm.contentsOfDirectory(atPath: fixturesRoot.path)) ?? [])
        .filter { isDir(fixturesRoot.appendingPathComponent($0)) }
        .sorted()
} else {
    selected = positional.map { p in
        let trimmed = p.hasSuffix("/") ? String(p.dropLast()) : p
        return URL(fileURLWithPath: trimmed).lastPathComponent
    }
    for id in selected where !isDir(fixturesRoot.appendingPathComponent(id)) {
        exitUsage("no fixture '\(id)' under \(fixturesRoot.path)")
    }
}

if !noONNX {
    _ = requireONNX()
    // ONNX fixture path needs a staff tensor per fixture (input.png → homr canvas) and a
    // committed oracle token file; not wired until an ORT backend runs on this platform.
    exitNotRunnable("fixture ONNX path requires a linked ORT backend + staff tensors; use --no-onnx or decode-staff")
}

out("omr-test --no-onnx: writer-only (expected.tokens.json → SMFWriter → SMFNoteReader vs expected.notes.csv)")
out("fixtures: \(fixturesRoot.path)")
out("tokens: expected.tokens.json is the writer INPUT; no decoded or committed oracle tokens are compared "
    + "without ONNX, so token_edit=n/a")
var counts: [Verdict: Int] = [:]
for id in selected {
    let dir = fixturesRoot.appendingPathComponent(id)
    let tier = readMeta(dir)["match_tier"] ?? "exact_tokens"
    if let t = tierFilter, t != tier { continue }
    let v = runWriterOnly(id: id, dir: dir, tier: tier, vocab: vocab)
    counts[v, default: 0] += 1
}
let pass = counts[.pass] ?? 0, fail = counts[.fail] ?? 0, skip = counts[.skip] ?? 0
out("summary: \(pass) PASS, \(fail) FAIL, \(skip) SKIP")
exit(fail > 0 ? 1 : 0)
