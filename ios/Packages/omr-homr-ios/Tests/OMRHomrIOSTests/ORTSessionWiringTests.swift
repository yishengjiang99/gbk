import XCTest
@testable import OMRHomrIOS

/// Plumbing tests for Encoder/Decoder sessions over `ORTSessionBackend` using a scripted
/// in-memory backend. These check names / dtypes / shapes / cache threading against the real
/// pinned-model I/O (see DecoderSession docs); they do NOT run a model and prove nothing about
/// token accuracy.
final class ORTSessionWiringTests: XCTestCase {

    /// Records every run; answers decoder or encoder shaped outputs.
    final class ScriptedBackend: ORTSessionBackend {
        static var nextRhythms: [Int] = []
        let provider: ORTProvider
        let inputNames: [String]
        let outputNames: [String]
        var calls: [[String: ORTTensor]] = []
        var rhythms: [Int] = []
        let isEncoder: Bool

        required init(modelURL: URL, provider: ORTProvider) throws {
            self.provider = provider
            isEncoder = modelURL.lastPathComponent.hasPrefix("encoder")
            if isEncoder {
                inputNames = ["input"]
                outputNames = ["output"]
            } else {
                inputNames = DecoderSession.inputNames + (0..<32).map { "cache_in\($0)" }
                outputNames = DecoderSession.outputNames + (0..<32).map { "cache_out\($0)" }
                rhythms = Self.nextRhythms
            }
        }

        func run(inputs: [String: ORTTensor], outputNames: [String]) throws -> [String: ORTTensor] {
            calls.append(inputs)
            if isEncoder {
                let n = 1 * 4 * 512 // tiny fake context [1,4,512] fp16
                return ["output": ORTTensor(type: .float16, shape: [1, 4, 512], data: Data(count: n * 2))]
            }
            let step = calls.count - 1
            func logits(_ v: Int, hot: Int) -> ORTTensor {
                var f = [Float](repeating: 0, count: v)
                f[hot] = 1
                return ORTTensor(type: .float32, shape: [1, 1, v], data: f.withUnsafeBytes { Data($0) })
            }
            let r = step < rhythms.count ? rhythms[step] : 2
            var out: [String: ORTTensor] = [
                "out_rhythms": logits(260, hot: r),
                "out_pitchs": logits(72, hot: 3),
                "out_lifts": logits(7, hot: 0),
                "out_positions": logits(5, hot: 1),
                "out_articulations": logits(62, hot: 0),
                "out_slurs": logits(5, hot: 0),
                "attention": ORTTensor(type: .float32, shape: [2], data: Data(count: 8)),
            ]
            for i in 0..<32 {
                out["cache_out\(i)"] = ORTTensor(
                    type: .float32, shape: [1, 8, step + 1, 64], data: Data(count: (step + 1) * 8 * 64 * 4)
                )
            }
            return out.filter { outputNames.contains($0.key) }
        }
    }

    func vocab() throws -> HomrVocabulary { try TokenizerLoader.loadVocabulary() }

    func testDecoderRejectsNonCPUProvider() throws {
        let b = try ScriptedBackend(modelURL: URL(fileURLWithPath: "/m/decoder.onnx"), provider: .coreML)
        XCTAssertThrowsError(try DecoderSession(vocabulary: vocab(), backend: b, provider: .coreML))
        XCTAssertNoThrow(try DecoderSession(vocabulary: vocab(), backend: b, provider: .cpu))
    }

    func testDecoderOpenUsesCPUOnly() throws {
        let d = try DecoderSession.open(
            ScriptedBackend.self, vocabulary: vocab(), modelURL: URL(fileURLWithPath: "/m/decoder.onnx")
        )
        XCTAssertEqual((d.backend as? ScriptedBackend)?.provider, .cpu)
        XCTAssertNoThrow(try d.configureStub())
    }

    func testStepRunnerFeedsUpstreamInputsAndThreadsCache() throws {
        let v = try vocab()
        let quarter = try XCTUnwrap(v.rhythm.keys.sorted().first { $0.hasPrefix("note_") })
        ScriptedBackend.nextRhythms = [v.rhythm[quarter]!, v.rhythm[quarter]!] // then EOS
        let d = try DecoderSession.open(
            ScriptedBackend.self, vocabulary: v, modelURL: URL(fileURLWithPath: "/m/decoder.onnx")
        )
        let ctxFloats = [Float](repeating: 0.5, count: 3 * 512)
        let ctx = EncoderContext(bytes: ctxFloats.withUnsafeBytes { Data($0) }, dtype: .float32, shape: [1, 3, 512])
        let runner = try d.makeStepRunner(context: ctx)
        let symbols = try DecoderLoop(vocabulary: v).generate(context: ctx, stepRunner: runner)
        XCTAssertEqual(symbols.map(\.rhythm), [quarter, quarter])
        XCTAssertEqual(symbols.first?.position, v.invPosition[1])

        let calls = try XCTUnwrap(d.backend as? ScriptedBackend).calls
        XCTAssertEqual(calls.count, 3, "2 symbols + EOS step")
        XCTAssertEqual(Set(calls[0].keys), Set(d.stepInputNames))
        // step 0: BOS / nonote, full context, cache_len 0, empty caches
        XCTAssertEqual(calls[0]["rhythms"]?.data, ORTDecoderStepRunner.int64Data([Int64(v.bosToken)]))
        XCTAssertEqual(calls[0]["rhythms"]?.shape, [1, 1])
        XCTAssertEqual(calls[0]["rhythms"]?.type, .int64)
        XCTAssertEqual(calls[0]["pitchs"]?.data, ORTDecoderStepRunner.int64Data([0]))
        XCTAssertEqual(calls[0]["context"]?.shape, [1, 3, 512])
        XCTAssertEqual(calls[0]["cache_len"]?.shape, [1])
        XCTAssertEqual(calls[0]["cache_len"]?.data, ORTDecoderStepRunner.int64Data([0]))
        XCTAssertEqual(calls[0]["cache_in0"]?.shape, [1, 8, 0, 64])
        XCTAssertEqual(calls[0]["cache_in31"]?.type, .float32)
        // step 1: previous samples, reduced context, cache_len 1, cache from cache_out
        XCTAssertEqual(calls[1]["rhythms"]?.data, ORTDecoderStepRunner.int64Data([Int64(v.rhythm[quarter]!)]))
        XCTAssertEqual(calls[1]["pitchs"]?.data, ORTDecoderStepRunner.int64Data([3]))
        XCTAssertEqual(calls[1]["context"]?.shape, [1, 1, 512])
        XCTAssertEqual(calls[1]["context"]?.data.count, 512 * 4)
        XCTAssertEqual(calls[1]["cache_len"]?.data, ORTDecoderStepRunner.int64Data([1]))
        XCTAssertEqual(calls[1]["cache_in5"]?.shape, [1, 8, 1, 64])
        XCTAssertEqual(calls[2]["cache_in5"]?.shape, [1, 8, 2, 64])
    }

    func testStepRunnerRefusesFP16Context() throws {
        let d = try DecoderSession.open(
            ScriptedBackend.self, vocabulary: vocab(), modelURL: URL(fileURLWithPath: "/m/decoder.onnx")
        )
        let ctx = EncoderContext(bytes: Data(count: 512 * 2), dtype: .float16, shape: [1, 1, 512])
        XCTAssertThrowsError(try d.makeStepRunner(context: ctx))
        XCTAssertNoThrow(try d.makeStepRunner(context: ctx.castToFP32ForDecoder()))
    }

    func testArgmaxFirstMaxWins() throws {
        let f: [Float] = [0, 3, 3, 1]
        let t = ORTTensor(type: .float32, shape: [1, 1, 4], data: f.withUnsafeBytes { Data($0) })
        XCTAssertEqual(try ORTDecoderStepRunner.argmaxLastRow(t, name: "x"), 1)
        let neg: [Float] = [-5, -2, -9]
        let t2 = ORTTensor(type: .float32, shape: [1, 1, 3], data: neg.withUnsafeBytes { Data($0) })
        XCTAssertEqual(try ORTDecoderStepRunner.argmaxLastRow(t2, name: "x"), 1)
    }

    func testEncoderFeedsFP16InputAndReturnsFP16Context() throws {
        let enc = try EncoderSession.open(
            ScriptedBackend.self, fp16ModelURL: URL(fileURLWithPath: "/m/encoder_fp16.onnx")
        )
        #if canImport(CoreML)
        XCTAssertEqual(enc.activeProvider, .coreMLFP16)
        #else
        XCTAssertEqual(enc.activeProvider, .cpuFallback)
        #endif
        let n = StaffInputSpec.nchwShape.reduce(1, *)
        let img = [Float](repeating: 1.0, count: n)
        let ctx = try enc.generateContext(staffImageNormalized: img.withUnsafeBytes { Data($0) })
        XCTAssertEqual(ctx.dtype, .float16)
        XCTAssertEqual(ctx.shape, [1, 4, 512])
        let fed = try XCTUnwrap((enc.backend as? ScriptedBackend)?.calls.first?["input"])
        XCTAssertEqual(fed.type, .float16)
        XCTAssertEqual(fed.shape, [1, 1, 256, 1280])
        XCTAssertEqual(fed.data.count, n * 2)
        XCTAssertEqual(fed.data.prefix(2), Data([0x00, 0x3C]), "1.0 as binary16 LE")
        XCTAssertThrowsError(try enc.generateContext(staffImageNormalized: Data(count: 10)))
    }

    func testFloat16RoundTrip() {
        for x: Float in [0, -0, 1, -2.5, 0.1, 65504, 1e-5, 3.14159, -0.7931] {
            let h = EncoderSession.float16Bits(fromFloat32Bits: x.bitPattern)
            let back = EncoderContext.float32(fromFloat16Bits: h)
            XCTAssertEqual(back, x, accuracy: max(abs(x) * 1e-3, 1e-7), "\(x)")
        }
        XCTAssertEqual(EncoderSession.float16Bits(fromFloat32Bits: Float(1e6).bitPattern), 0x7C00)
        XCTAssertEqual(EncoderSession.float16Bits(fromFloat32Bits: Float(1.0).bitPattern), 0x3C00)
    }

    func testStaffTensorLoadsOracleNPY() throws {
        let url = try WriterOnlyFixtureTests.fixturesRoot()
            .appendingPathComponent("oracle.c_scale_staff/staff.npy")
        let t = try StaffTensor.loadNPY(url)
        XCTAssertEqual(t.shape, [1, 1, 256, 1280])
        XCTAssertEqual(t.values.count, 327_680)
        // White canvas pixel = (1 - 0.7931) / 0.1738 ≈ 1.1904
        XCTAssertEqual(t.values[0], (1 - 0.7931) / 0.1738, accuracy: 1e-4)
        XCTAssertEqual(t.float32LEData.count, 327_680 * 4)
        XCTAssertThrowsError(try StaffTensor(values: [0], shape: [1, 1, 1, 1]))
        XCTAssertThrowsError(try StaffTensor(values: [0], shape: [1, 1, 256, 1280]))
    }

    /// Synthetic `.npy` (v1 or v2 header) with `n` elements of `descr`, value i*0.5 at index i.
    private func writeNPY(descr: String, elem: Int, v2: Bool, fortran: Bool = false) throws -> URL {
        let n = StaffInputSpec.elementCount
        var header = "{'descr': '\(descr)', 'fortran_order': \(fortran ? "True" : "False"), 'shape': (1, 1, 256, 1280), }"
        let pre = v2 ? 12 : 10
        while (pre + header.utf8.count + 1) % 64 != 0 { header += " " }
        header += "\n"
        var d = Data([0x93] + Array("NUMPY".utf8) + [v2 ? 2 : 1, 0])
        let hl = header.utf8.count
        d.append(contentsOf: v2 ? [UInt8(hl & 0xFF), UInt8(hl >> 8), 0, 0] : [UInt8(hl & 0xFF), UInt8(hl >> 8)])
        d.append(contentsOf: Array(header.utf8))
        for i in 0..<n {
            let x = Double(i % 64) * 0.5
            switch elem {
            case 2: withUnsafeBytes(of: EncoderSession.float16Bits(fromFloat32Bits: Float(x).bitPattern).littleEndian) { d.append(contentsOf: $0) }
            case 8: withUnsafeBytes(of: x.bitPattern.littleEndian) { d.append(contentsOf: $0) }
            default: withUnsafeBytes(of: Float(x).bitPattern.littleEndian) { d.append(contentsOf: $0) }
            }
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("st-\(descr.dropFirst())-\(v2)-\(fortran).npy")
        try d.write(to: url)
        return url
    }

    func testStaffTensorNPYDtypesAndHeaders() throws {
        for (descr, elem) in [("<f4", 4), ("<f2", 2), ("<f8", 8)] {
            for v2 in [false, true] {
                let t = try StaffTensor.loadNPY(writeNPY(descr: descr, elem: elem, v2: v2))
                XCTAssertEqual(t.shape, [1, 1, 256, 1280], "\(descr) v2=\(v2)")
                XCTAssertEqual(t.values[3], 1.5, "\(descr) v2=\(v2)")
                XCTAssertEqual(t.values[63], 31.5, "\(descr) v2=\(v2)")
                XCTAssertEqual(t.values[327_679], 31.5, "\(descr) v2=\(v2)")
            }
        }
        XCTAssertThrowsError(try StaffTensor.loadNPY(writeNPY(descr: ">f4", elem: 4, v2: false)))
        XCTAssertThrowsError(try StaffTensor.loadNPY(writeNPY(descr: "<f4", elem: 4, v2: false, fortran: true)))
    }

    func testGate1EntryDecodesThroughScriptedBackends() throws {
        let v = try vocab()
        let quarter = try XCTUnwrap(v.rhythm.keys.sorted().first { $0.hasPrefix("note_") })
        ScriptedBackend.nextRhythms = [v.rhythm[quarter]!]
        let enc = try ScriptedBackend(modelURL: URL(fileURLWithPath: "/m/encoder_fp16.onnx"), provider: .cpu)
        let dec = try ScriptedBackend(modelURL: URL(fileURLWithPath: "/m/decoder.onnx"), provider: .cpu)
        let session = try StaffInferenceSession(encoder: enc, decoder: dec, vocabulary: v)
        let tensor = try StaffTensor(values: [Float](repeating: 0, count: 327_680), shape: [1, 1, 256, 1280])
        let symbols = try session.decodeStaff(tensor: tensor)
        XCTAssertEqual(symbols.map(\.rhythm), [quarter])
        XCTAssertEqual(enc.calls.first?["input"]?.type, .float16)
        XCTAssertEqual(dec.calls.first?["context"]?.type, .float32, "fp16 context cast before decoder")
        XCTAssertEqual(dec.calls.first?["context"]?.shape, [1, 4, 512])
        XCTAssertEqual(dec.calls.count, 2)
    }
}
