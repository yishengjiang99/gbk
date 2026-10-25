// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — page SegNet class map -> staffs (page pipeline, milestone 2).
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): the part of
// homr/main.py detect_staffs_in_image and staff_parsing.parse_staffs between the SegNet split and
// prepare_staff_image: noise_filtering (create_noise_grid / filter_predictions), make_lines_stronger,
// symbol boxes, break_wide_fragments, note_detection.combine_noteheads_with_stems, bar-line filtering
// (bar_line_detection), detect_staff, brace/grand-staff grouping, _ensure_same_number_of_staffs and
// StaffRegions, producing the per-staff StaffGeometry homr feeds to prepare_staff_image.

import Foundation

/// Staffs found on a page, in homr's decode order (voice-major: every row's first staff, then every
/// row's second staff, ...), each with the `StaffGeometry` `prepare_staff_image` needs.
public struct PageStaffLayout: Sendable {
    public struct Staff: Sendable {
        public var geometry: StaffGeometry
        public var isGrandstaff: Bool
        /// Voice index (position inside its row) and row index.
        public var voice: Int
        public var row: Int
    }

    /// One detected staff as homr's `Staff` (for oracle comparisons).
    public struct StaffInfo: Sendable {
        public var grid: [StaffGeometry.Point]
        public var minX: Double, maxX: Double, minY: Double, maxY: Double
        public var averageUnitSize: Double
        public var isGrandstaff: Bool
    }

    public var staffs: [Staff]
    public var voices: Int
    /// Noise-filter mask (0 / 255, page size) when homr's filter applied, else nil. homr ANDs it into the
    /// preprocessed page the staffs are cropped from.
    public var noiseMask: [UInt8]?
    /// Intermediate homr boxes `[cx, cy, w, h, angle]` keyed like stages.json `symbols`.
    public var symbols: [String: [[Double]]]
    public var averageNoteHeadHeight: Double
    public var detectedStaffs: [StaffInfo]
    public var multiStaffs: [[StaffInfo]]
    public var ensuredRows: [Int]
}

public enum PageStaffDetectionError: Error, CustomStringConvertible {
    case noNoteheads
    case noStaffs

    public var description: String {
        switch self {
        case .noNoteheads: return "page staff detection: no noteheads found (homr: 'No noteheads found')"
        case .noStaffs: return "page staff detection: no staffs found"
        }
    }
}

enum PageStaffDetection {
    struct Masks {
        var staff: [UInt8], symbols: [UInt8], stems: [UInt8], notehead: [UInt8], clefs: [UInt8]
    }

    static func split(_ seg: [UInt8]) -> Masks {
        func cls(_ c: UInt8) -> [UInt8] { seg.map { $0 == c ? 1 : 0 } }
        return Masks(staff: cls(4), symbols: cls(5), stems: cls(1), notehead: cls(2), clefs: cls(3))
    }

    /// create_noise_grid(255 * staff) + handle_filter_results.
    static func noiseMask(staff: [UInt8], width w: Int, height h: Int) -> [UInt8]? {
        let g = CVShapes.noiseGrid(staff.map { $0 == 0 ? 0 : 255 }, width: w, height: h)
        guard g.rows > 0, g.cols > 0 else { return nil }
        var mask = [UInt8](repeating: 0, count: w * h)
        var filtered = 0, total = 0
        let limit = 50
        for i in 0..<g.rows {
            for j in 0..<g.cols {
                let noise = Int(g.grid[i * g.cols + j])
                var nb: [Int] = []
                if i > 0 { nb.append(Int(g.grid[(i - 1) * g.cols + j])) }
                if j > 0 { nb.append(Int(g.grid[i * g.cols + j - 1])) }
                if i < g.rows - 1 { nb.append(Int(g.grid[(i + 1) * g.cols + j])) }
                if j < g.cols - 1 { nb.append(Int(g.grid[i * g.cols + j + 1])) }
                if noise > limit && nb.contains(where: { $0 > limit }) {
                    filtered += 1
                } else {
                    let y1 = i * g.m, x1 = j * g.n
                    for y in y1..<min(y1 + g.m, h) {
                        for x in x1..<min(x1 + g.n, w) { mask[y * w + x] = 255 }
                    }
                }
                total += 1
            }
        }
        if Double(filtered) / Double(total) > 0.5 { return nil }
        return filtered > 0 ? mask : nil
    }

    struct NoteheadWithStem { var notehead: HBox; var stem: HBox?; var up: Bool? }

    static func combineNoteheadsWithStems(_ noteheads: [HBox], _ stems: [HBox]) -> [NoteheadWithStem] {
        let sorted = noteheads.enumerated().sorted {
            $0.element.cy != $1.element.cy ? $0.element.cy < $1.element.cy : $0.offset < $1.offset
        }.map { $0.element }
        return sorted.map { nh in
            let thick = nh.makeThicker(15)
            if let stem = stems.first(where: { $0.isOverlapping(thick) }) {
                return NoteheadWithStem(notehead: nh, stem: stem, up: stem.cy < nh.cy)
            }
            return NoteheadWithStem(notehead: nh, stem: nil, up: nil)
        }
    }

    static func info(_ s: HStaff) -> PageStaffLayout.StaffInfo {
        PageStaffLayout.StaffInfo(grid: s.grid.map { StaffGeometry.Point(x: $0.x, y: $0.y, angle: $0.angle) },
                                  minX: s.minX, maxX: s.maxX, minY: s.minY, maxY: s.maxY,
                                  averageUnitSize: s.averageUnitSize, isGrandstaff: s.isGrandstaff)
    }

    /// SegNet class map (0..5, `width x height`) -> staff layout.
    static func detect(segmentation seg: [UInt8], width w: Int, height h: Int) throws -> PageStaffLayout {
        var m = split(seg)
        let mask = noiseMask(staff: m.staff, width: w, height: h)
        if let mk = mask {
            for i in 0..<(w * h) where mk[i] == 0 {
                m.staff[i] = 0; m.symbols[i] = 0; m.stems[i] = 0; m.notehead[i] = 0; m.clefs[i] = 0
            }
        }
        // make_lines_stronger(staff, (1, 2))
        m.staff = CVShapes.morph(m.staff, width: w, height: h, kernel: CVShapes.ellipseKernel(kw: 1, kh: 2), kw: 1, erode: false)

        var rng = CVShapes.RNG()
        let noteheads = HomrBoxes.ellipses(m.notehead, width: w, height: h, minSize: (4, 4), rng: &rng)
        let fragmentsRaw = HomrBoxes.rotatedBoxes(m.staff, width: w, height: h, skipMerging: true,
                                                  minSize: (5, 1), maxSize: (10000, 100))
        let clefs = HomrBoxes.rotatedBoxes(m.clefs, width: w, height: h, minSize: (20, 40), maxSize: (1000, 1000))
        let stems = HomrBoxes.rotatedBoxes(m.stems, width: w, height: h)
        var barImg = m.stems.map { Int8($0) }
        barImg.withUnsafeMutableBufferPointer {
            BinaryMorph.rect($0.baseAddress!, width: w, height: h, stride: w, kw: 3, kh: 5, erode: false)
        }
        let barLinesRaw = HomrBoxes.rotatedBoxes(barImg.map { UInt8($0) }, width: w, height: h, skipMerging: true,
                                                 minSize: (1, 5))
        let fragments = StaffDetection.breakWideFragments(fragmentsRaw)
        let nws = combineNoteheadsWithStems(noteheads, stems)
        if nws.isEmpty { throw PageStaffDetectionError.noNoteheads }
        let avgH = NP.median(nws.map { $0.notehead.h })
        let allNH = nws.map { $0.notehead }
        let allStems = nws.compactMap { $0.stem }
        let blr = barLinesRaw.filter { !$0.isOverlappingWithAny(allNH) && !$0.isOverlappingWithAny(allStems) }
        let barBoxes = blr.filter { !($0.h < 3 * avgH) && !($0.w > 2 * avgH) }
        let staffs = StaffDetection.detectStaff(image: m.staff, width: w, height: h, fragments: fragments,
                                                clefsKeys: clefs, barLines: barBoxes)
        let braceImg = BraceDetection.braceDotImage(symbols: m.symbols, staff: m.staff, width: w, height: h)
        let braceDot = HomrBoxes.rotatedBoxes(braceImg, width: w, height: h, skipMerging: true, maxSize: (100, -1))
        if staffs.isEmpty { throw PageStaffDetectionError.noStaffs }
        let grouped = BraceDetection.findBracesAndGrandStaffs(staffs, braceDot)
        let homrRows = BraceDetection.ensureSameNumberOfStaffs(grouped.multi)
        // homr's regions (all staffs, homr row order) for prepare_staff_image parity.
        let regions: [[Double]] = homrRows.flatMap { $0.staffs.map { [$0.minY, $0.maxY] } }
        // Stacked piano systems -> one grand-staff voice, systems in sequence (see the function doc).
        let rows = BraceDetection.splitStackedGrandStaffSystems(homrRows)
        let voices = rows.first?.staffs.count ?? 0
        var out: [PageStaffLayout.Staff] = []
        for v in 0..<voices {
            for (r, row) in rows.enumerated() where v < row.staffs.count {
                let s = row.staffs[v]
                let geo = StaffGeometry(grid: s.grid.map { StaffGeometry.Point(x: $0.x, y: $0.y, angle: $0.angle) },
                                        regions: regions)
                out.append(.init(geometry: geo, isGrandstaff: s.isGrandstaff, voice: v, row: r))
            }
        }
        // Defensive: if brace detection collapsed to one row (every staff its own voice),
        // all staffs start at tick 0. Reinterpret consecutive pairs as piano systems:
        // even-indexed -> treble voice 0, odd-indexed -> bass voice 1, rows sequence.
        // NOTE: keep `out` in place (do NOT reorder) — callers zip it with staffSymbols.
        var finalVoices = voices
        if voices >= 4, out.count >= 4, out.count % 2 == 0,
           Set(out.map { $0.voice }).count == out.count {
            for i in 0..<out.count {
                let pairIdx = i / 2
                if i % 2 == 0 {
                    out[i].voice = 0
                    out[i].row = pairIdx
                } else {
                    out[i].voice = 1
                    out[i].row = pairIdx
                }
                out[i].isGrandstaff = true
            }
            finalVoices = 2
        }
        let symbols: [String: [[Double]]] = [
            "noteheads": noteheads.map { $0.box },
            "staff_fragments_raw": fragmentsRaw.map { $0.box },
            "clefs_keys": clefs.map { $0.box },
            "stems_rest": stems.map { $0.box },
            "bar_lines_raw": barLinesRaw.map { $0.box },
            "staff_fragments": fragments.map { $0.box },
            "bar_lines_or_rests": blr.map { $0.box },
            "bar_line_boxes": barBoxes.map { $0.box },
            "brace_dot": braceDot.map { $0.box },
        ]
        return PageStaffLayout(staffs: out, voices: finalVoices, noiseMask: mask, symbols: symbols,
                               averageNoteHeadHeight: avgH, detectedStaffs: staffs.map(info),
                               multiStaffs: grouped.multi.map { $0.staffs.map(info) },
                               ensuredRows: homrRows.map { $0.staffs.count })
    }
}
