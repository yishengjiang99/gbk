// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-test parse-page: full page -> PageInferenceSession.parsePage -> SMF + noteLayout; with --compare, per-staff
// canvases (SHA-256), raw / position-filtered decoder symbols and homr voices vs fixtures/oracle.pages/<id>/stages.json.
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): checks against homr/main.py
// process_image -> parse_staffs outputs captured by tools/oracle/export_page_pipeline.py.
import Foundation
import OMRHomrIOS

enum PageParseCommand {
    struct Sym: Decodable, Equatable {
        var rhythm, pitch, lift, articulation, slur, position: String
    }
    struct Stages: Decodable {
        struct Input: Decodable {
            var is_grandstaff: Bool
            var canvas_sha256: String
            var symbols: [Sym]
            var symbols_after_position_filter: [Sym]
        }
        var staff_inputs: [Input]
        var voices: [[Sym]]
    }

    static func sym(_ s: EncodedSymbol) -> Sym {
        Sym(rhythm: s.rhythm, pitch: s.pitch, lift: s.lift, articulation: s.articulation, slur: s.slur, position: s.position)
    }

    static func edit(_ a: [Sym], _ b: [Sym]) -> Int { levenshtein(a, b) }

    /// Returns the process exit code.
    static func run(session: PageInferenceSession, pageURL: URL, oracle: URL?, midiOut: URL?, verbose: Bool) -> Int32 {
        guard let png = try? Data(contentsOf: pageURL) else { exitUsage("cannot read \(pageURL.path)") }
        let g: (pixels: [UInt8], width: Int, height: Int)
        do { g = try PagePipeline.decodeGrayPNG(png) } catch { exitUsage("\(pageURL.path): \(error)") }
        let gray = Data(g.pixels)
        let t0 = Date()
        let r: PageParseResult
        // OMR_COLOR=1: homr's color preprocessing path (parsePage(rgbx:)) instead of gray first.
        let color = ProcessInfo.processInfo.environment["OMR_COLOR"] == "1"
        do {
            if color {
                let c = try PagePipeline.decodeRGBXPNG(png)
                out("input: color (rgbx)")
                r = try session.parsePage(rgbx: c.pixels, width: c.width, height: c.height, bytesPerRow: c.width * 4)
            } else {
                r = try session.parsePage(gray8: gray, width: g.width, height: g.height)
            }
        } catch {
            err("omr-test: parse-page failed: \(error)"); return 1
        }
        let totalMs = Date().timeIntervalSince(t0) * 1000
        out("parse-page: \(pageURL.standardizedFileURL.path) \(g.width)x\(g.height) -> page \(r.pageWidth)x\(r.pageHeight)")
        out("timings: " + r.timings.map { "\($0.stage) \(String(format: "%.0f", $0.ms)) ms" }.joined(separator: ", ")
            + String(format: " | total %.0f ms", totalMs))
        out("staffs: \(r.layout.staffs.count), voices: \(r.voices.count), rows: \(r.layout.ensuredRows)")
        for (i, s) in r.layout.staffs.enumerated() {
            out("  staff[\(i)] voice \(s.voice) row \(s.row) grandstaff \(s.isGrandstaff): \(r.staffSymbols[i].count) symbols raw, "
                + "\(r.filteredStaffSymbols[i].count) after position filter")
        }
        for (v, stream) in r.voices.enumerated() {
            out("voice[\(v)] \(stream.count) symbols:")
            if verbose || stream.count <= 80 {
                for (k, s) in stream.enumerated() { out("  \(k)\t\(s)") }
            }
        }
        let res = r.result
        var failed = false
        do {
            let smf = try SMFNoteReader.read(from: res.midi)
            let ok = smf.notes.count == res.noteLayout.count && smf.header.format == 1
            out("smf: \(res.midi.count) bytes, format \(smf.header.format), \(smf.parsedTrackCount) tracks "
                + "(staffCount \(res.staffCount)), \(smf.notes.count) notes, noteLayout \(res.noteLayout.count) "
                + (ok ? "OK" : "MISMATCH"))
            if !ok { failed = true }
        } catch {
            out("smf: INVALID (\(error))"); failed = true
        }
        for w in res.warnings { out("warning: \(w)") }
        out("layout: \(res.layoutSource.rawValue), \(res.noteLayout.filter(\.hasBox).count)/\(res.noteLayout.count) boxed")
        // OMR_POSITIONS_OUT=<file.json>: per staff raw symbols with homr dda4d2f image coordinates + boxes.
        if let path = ProcessInfo.processInfo.environment["OMR_POSITIONS_OUT"], !path.isEmpty {
            struct Sym: Encodable { var symbol: String; var image: [Double]?; var page: [Double]?; var canvas: [Double]? }
            struct Note: Encodable { var noteIndex: Int; var symbolIndex: Int; var staffIndex: Int; var midiNote: Int; var rect: [Double] }
            struct Dump: Encodable { var staffs: [[Sym]]; var notes: [Note]; var layoutSource: String }
            func pt(_ p: PagePoint?) -> [Double]? { p.map { [$0.x, $0.y] } }
            let dump = Dump(
                staffs: r.staffSymbols.map { $0.map { Sym(symbol: $0.description, image: pt($0.imageCoordinates),
                                                         page: pt($0.pagePoint), canvas: pt($0.attentionCenter)) } },
                notes: res.noteLayout.map { n in
                    Note(noteIndex: n.noteIndex, symbolIndex: n.symbolIndex, staffIndex: n.staffIndex, midiNote: n.midiNote ?? -1,
                         rect: n.hasBox ? [Double(n.pageRect.origin.x), Double(n.pageRect.origin.y),
                                           Double(n.pageRect.width), Double(n.pageRect.height)] : [])
                },
                layoutSource: res.layoutSource.rawValue)
            do {
                try JSONEncoder().encode(dump).write(to: URL(fileURLWithPath: path)); out("wrote positions \(path)")
            } catch { err("omr-test: positions: \(error)") }
        }
        if let m = midiOut {
            do { try res.midi.write(to: m); out("wrote \(m.path)") } catch { err("cannot write \(m.path): \(error)") }
        }

        guard let dir = oracle else { return failed ? 1 : 0 }
        let stages: Stages
        do { stages = try JSONDecoder().decode(Stages.self, from: Data(contentsOf: dir.appendingPathComponent("stages.json"))) } catch {
            exitUsage("stages.json missing/unreadable in \(dir.path): \(error)")
        }
        out("compare vs \(dir.standardizedFileURL.path)/stages.json:")
        if stages.staff_inputs.count != r.layout.staffs.count {
            out("  staff count \(r.layout.staffs.count) vs homr \(stages.staff_inputs.count)"); failed = true
        }
        // Canvases: recompute from the same (deterministic) preprocessing.
        var canvasesOK = true
        if let page = try? PagePipeline.preprocess(gray8: gray, width: g.width, height: g.height) {
            let image = PagePipeline.maskedPage(page.preprocessed, noiseMask: r.layout.noiseMask)
            for (i, (s, ref)) in zip(r.layout.staffs, stages.staff_inputs).enumerated() {
                let canvas = (try? PagePipeline.staffCanvas(page: image, width: page.width, height: page.height, staff: s)) ?? []
                let h = SHA256.hex(canvas)
                let same = h == ref.canvas_sha256
                if !same { canvasesOK = false }
                out("  staff[\(i)] canvas \(canvas.count) bytes: \(same ? "identical" : "DIFFERS (\(h.prefix(12)) vs \(ref.canvas_sha256.prefix(12)))")")
            }
        }
        var tokensOK = true
        for (i, ref) in stages.staff_inputs.enumerated() where i < r.staffSymbols.count {
            let dRaw = edit(r.staffSymbols[i].map(sym), ref.symbols)
            let dFil = edit(r.filteredStaffSymbols[i].map(sym), ref.symbols_after_position_filter)
            if dRaw != 0 || dFil != 0 { tokensOK = false }
            out("  staff[\(i)] symbols edit=\(dRaw) (\(r.staffSymbols[i].count) vs \(ref.symbols.count)), "
                + "after position filter edit=\(dFil)")
        }
        for (v, ref) in stages.voices.enumerated() {
            let got = v < r.voices.count ? r.voices[v].map(sym) : []
            let d = edit(got, ref)
            if d != 0 { tokensOK = false }
            out("  voice[\(v)] edit=\(d) (\(got.count) vs \(ref.count))")
        }
        if stages.voices.count != r.voices.count { tokensOK = false }
        // Canvas / token differences are reported (SegNet or decoder float noise can flip them); the gate is
        // structural: same staffs, valid SMF.
        out(canvasesOK && tokensOK && !failed ? "PASS identical to homr" : (failed ? "FAIL" : "DIFF (see above)"))
        return failed ? 1 : (canvasesOK && tokensOK ? 0 : 1)
    }
}

/// Minimal SHA-256 (FIPS 180-4) for fixture hashes; CryptoKit is Apple-only.
enum SHA256 {
    static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

    static func hex(_ message: [UInt8]) -> String {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var m = message
        let bitLen = UInt64(message.count) * 8
        m.append(0x80)
        while m.count % 64 != 56 { m.append(0) }
        for i in (0..<8).reversed() { m.append(UInt8(truncatingIfNeeded: bitLen >> (UInt64(i) * 8))) }
        var w = [UInt32](repeating: 0, count: 64)
        for chunk in stride(from: 0, to: m.count, by: 64) {
            for i in 0..<16 {
                let b0 = UInt32(m[chunk + 4 * i]) << 24
                let b1 = UInt32(m[chunk + 4 * i + 1]) << 16
                let b2 = UInt32(m[chunk + 4 * i + 2]) << 8
                let b3 = UInt32(m[chunk + 4 * i + 3])
                w[i] = b0 | b1 | b2 | b3
            }
            for i in 16..<64 {
                let s0: UInt32 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1: UInt32 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                let t: UInt32 = w[i - 16] &+ s0
                w[i] = t &+ w[i - 7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let S1: UInt32 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch: UInt32 = (e & f) ^ (~e & g)
                let t1a: UInt32 = hh &+ S1 &+ ch
                let t1: UInt32 = t1a &+ k[i] &+ w[i]
                let S0: UInt32 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj: UInt32 = (a & b) ^ (a & c) ^ (b & c)
                let t2: UInt32 = S0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
        }
        return h.map { String(format: "%08x", $0) }.joined()
    }
}
