// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): checks the OpenCV 5.0.0
// shape primitives homr's staff detection uses (Page/CVShapes.swift) against cv2 outputs exported by
// tools/oracle/export_cvshapes_refs.py.
import XCTest
@testable import OMRHomrIOS

final class CVShapesTests: XCTestCase {
    struct Refs: Decodable {
        struct Rect: Decodable { var pts: [[Int]]; var hull: [[Int]]; var rect: [Double] }
        struct BoxPts: Decodable { var rect: [Double]; var pts: [[Double]] }
        struct Ell: Decodable { var c: [Int]; var ax: [Int]; var a: Int; var poly: [[Int]] }
        struct Fit: Decodable { var pts: [[Int]]; var rect: [Double] }
        struct ICC: Decodable { var p: [[Int]]; var q: [[Int]]; var area: Double }
        struct RRI: Decodable { var a: [Double]; var b: [Double]; var hit: Bool }
        struct PPT: Decodable { var poly: [[Int]]; var pt: [Int]; var r: Double }
        struct Kernel: Decodable { var k: [Int]; var m: [[Int]] }
        struct Morph: Decodable { var k: [Int]; var w: Int; var h: Int; var src: String; var erode: String; var dilate: String }
        struct Fill: Decodable { var pts: [[Int]]; var rows: [Int] }
        struct Noise: Decodable { var w: Int; var h: Int; var img: String; var grid: [[Int]] }
        var opencv: String
        var rect: [Rect]
        var boxpts: [BoxPts]
        var ellpoly: [Ell]
        var fit: [Fit]
        var icc: [ICC]
        var rri: [RRI]
        var ppt: [PPT]
        var kernels: [Kernel]
        var morph: [Morph]
        var fill: [Fill]
        var noise: [Noise]
    }

    static let refs: Refs = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/page_cv2/shapes.json")
        return try! JSONDecoder().decode(Refs.self, from: Data(contentsOf: url))
    }()

    typealias P = CVContours.Point
    static func pts(_ a: [[Int]]) -> [P] { a.map { P(x: $0[0], y: $0[1]) } }
    static func rrect(_ r: [Double]) -> CVShapes.RotatedRect {
        CVShapes.RotatedRect(cx: Float(r[0]), cy: Float(r[1]), w: Float(r[2]), h: Float(r[3]), angle: Float(r[4]))
    }
    static func bytes(_ s: String) -> [UInt8] { [UInt8](Data(base64Encoded: s)!) }

    func testRefsAreOpenCV5() { XCTAssertEqual(Self.refs.opencv, "5.0.0") }

    func testConvexHullAndMinAreaRectExact() {
        var bad = 0
        for (i, c) in Self.refs.rect.enumerated() {
            let p = Self.pts(c.pts)
            let hull = CVShapes.convexHull(p)
            if hull != Self.pts(c.hull) {
                bad += 1
                if bad < 5 { XCTFail("hull \(i): \(hull) vs \(c.hull) for \(c.pts)") }
            }
            let r = CVShapes.minAreaRect(p)
            if r != Self.rrect(c.rect) {
                bad += 1
                if bad < 5 { XCTFail("rect \(i): \(r) vs \(c.rect) for \(c.pts)") }
            }
        }
        XCTAssertEqual(bad, 0)
    }

    func testBoxPointsExact() {
        for c in Self.refs.boxpts {
            let p = CVShapes.boxPoints(Self.rrect(c.rect))
            for k in 0..<4 {
                XCTAssertEqual(p[k].x, Float(c.pts[k][0]), "\(c.rect)")
                XCTAssertEqual(p[k].y, Float(c.pts[k][1]), "\(c.rect)")
            }
        }
    }

    func testEllipse2PolyExact() {
        for c in Self.refs.ellpoly {
            let p = CVShapes.ellipse2Poly(center: P(x: c.c[0], y: c.c[1]), axes: (c.ax[0], c.ax[1]), angle: c.a)
            XCTAssertEqual(p, Self.pts(c.poly), "\(c.c) \(c.ax) \(c.a)")
        }
    }

    func testFitEllipseClose() {
        var rng = CVShapes.RNG()
        var worst = 0.0
        for c in Self.refs.fit {
            let r = CVShapes.fitEllipse(Self.pts(c.pts), rng: &rng)
            let e = Self.rrect(c.rect)
            if c.pts.count == 5 && abs(e.w * e.h) < 8 {
                // fitEllipseDirect on a near-degenerate 5-point contour: OpenCV accepts an eigenvector
                // made of rounding noise (complex eigenvalue pair); only homr's (4, 4) filter must agree.
                XCTAssertEqual(r.w >= 4 && r.h >= 4, e.w >= 4 && e.h >= 4, "\(c.pts)")
                continue
            }
            let dcx: Double = Double(abs(r.cx - e.cx))
            let dcy: Double = Double(abs(r.cy - e.cy))
            let dw: Double = Double(abs(r.w - e.w))
            let dh: Double = Double(abs(r.h - e.h))
            let d: Double = max(max(dcx, dcy), max(dw, dh))
            var da = Double(abs(r.angle - e.angle))
            da = min(da, abs(da - 180))
            worst = max(worst, d)
            XCTAssertLessThan(d, 1e-3, "\(c.pts): \(r) vs \(c.rect)")
            XCTAssertLessThan(da, 1e-2, "\(c.pts): \(r) vs \(c.rect)")
        }
        print("fitEllipse worst abs diff \(worst) over \(Self.refs.fit.count) contours")
    }

    func testIntersectConvexConvexExact() {
        for c in Self.refs.icc {
            let a = CVShapes.intersectConvexConvexArea(Self.pts(c.p), Self.pts(c.q))
            XCTAssertEqual(a, Float(c.area), "\(c.p) \(c.q)")
        }
    }

    func testRotatedRectangleIntersectionExact() {
        for c in Self.refs.rri {
            XCTAssertEqual(CVShapes.rotatedRectsIntersect(Self.rrect(c.a), Self.rrect(c.b)), c.hit, "\(c.a) \(c.b)")
        }
    }

    func testPointPolygonTestExact() {
        for c in Self.refs.ppt {
            let r = CVShapes.pointPolygonTest(Self.pts(c.poly), P(x: c.pt[0], y: c.pt[1]))
            XCTAssertEqual(Double(r), c.r, "\(c.poly) \(c.pt)")
        }
    }

    func testEllipseKernelsAndMorphologyExact() {
        for k in Self.refs.kernels {
            let spans = CVShapes.ellipseKernel(kw: k.k[0], kh: k.k[1])
            let m = spans.map { s in (0..<k.k[0]).map { $0 >= s.0 && $0 < s.1 ? 1 : 0 } }
            XCTAssertEqual(m, k.m, "\(k.k)")
        }
        for c in Self.refs.morph {
            let spans = CVShapes.ellipseKernel(kw: c.k[0], kh: c.k[1])
            let src = Self.bytes(c.src)
            XCTAssertEqual(CVShapes.morph(src, width: c.w, height: c.h, kernel: spans, kw: c.k[0], erode: true),
                           Self.bytes(c.erode), "erode \(c.k) \(c.w)x\(c.h)")
            XCTAssertEqual(CVShapes.morph(src, width: c.w, height: c.h, kernel: spans, kw: c.k[0], erode: false),
                           Self.bytes(c.dilate), "dilate \(c.k) \(c.w)x\(c.h)")
        }
    }

    func testFilledRowWidthsExact() {
        for c in Self.refs.fill {
            let p = Self.pts(c.pts)
            let br = CVContours.boundingRect(p)
            let shifted = p.map { P(x: $0.x - br.x, y: $0.y - br.y) }
            XCTAssertEqual(CVShapes.filledRowWidths(shifted, width: br.width, height: br.height), c.rows, "\(c.pts)")
        }
    }

    func testNoiseGridExact() {
        for c in Self.refs.noise {
            let g = CVShapes.noiseGrid(Self.bytes(c.img), width: c.w, height: c.h)
            XCTAssertEqual(g.rows, c.grid.count)
            XCTAssertEqual(g.grid.map(Int.init), c.grid.flatMap { $0 })
        }
    }
}
