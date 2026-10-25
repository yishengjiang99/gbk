// SPDX-License-Identifier: AGPL-3.0-or-later
import XCTest
import OMRPNG
@testable import OMRHomrIOS

/// homr `prepare_staff_image` (crop + dewarp) ported to Swift (`StaffPrepare`): the page oracle
/// (`fixtures/oracle.c_scale_prepare`, homr 7d97c3c + OpenCV 5.0.0) must be reproduced byte for byte,
/// and each OpenCV primitive must match cv2 / homr references (`tools/oracle/export_dewarp_refs.py`).
final class StaffPrepareTests: XCTestCase {
    struct Refs: Decodable {
        struct Warp: Decodable { var src_w: Int; var src_h: Int; var src: String; var M: [Double]; var w: Int; var h: Int; var border: Int; var dst: String }
        struct Affine: Decodable { var src: [Float]; var dst: [Float]; var M: [Double] }
        struct Poly: Decodable { var w: Int; var h: Int; var pts: [Int]; var mask: String }
        struct Delaunay: Decodable { var points: [Float]; var simplices: [[Int]]? }
        struct Contours: Decodable { var w: Int; var h: Int; var unit: Double; var src: String; var dst: String }
        var opencv: String
        var warp: [Warp]
        var affine: [Affine]
        var poly: [Poly]
        var delaunay: [Delaunay]
        var contours: [Contours]
    }

    static let refs: Refs = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/staff_prepare_cv2/refs.json")
        return try! JSONDecoder().decode(Refs.self, from: Data(contentsOf: url))
    }()

    static func bytes(_ s: String) -> [UInt8] { [UInt8](Data(base64Encoded: s)!) }
    static func pts(_ f: [Float]) -> [CVGeometry.Point2f] {
        stride(from: 0, to: f.count, by: 2).map { CVGeometry.Point2f(x: f[$0], y: f[$0 + 1]) }
    }
    static func oracleDir() throws -> URL {
        try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.c_scale_prepare")
    }

    // MARK: OpenCV primitives vs cv2 5.0.0

    func testRefsAreOpenCV5() { XCTAssertEqual(Self.refs.opencv, "5.0.0") }

    func testWarpAffineLinearMatchesCV2() {
        var tails = Set<Int>()
        for (i, c) in Self.refs.warp.enumerated() {
            let view = CVGeometry.GrayView(pixels: Self.bytes(c.src), offset: 0, stride: c.src_w, width: c.src_w, height: c.src_h)
            let got = CVGeometry.warpAffineLinear(view, c.M, dstWidth: c.w, dstHeight: c.h, borderValue: UInt8(c.border))
            let want = Self.bytes(c.dst)
            let bad = zip(got, want).filter { $0 != $1 }.count
            XCTAssertEqual(bad, 0, "warp case \(i) (\(c.w)x\(c.h), M \(c.M)): \(bad) pixels differ")
            tails.insert(c.w % 16)
        }
        XCTAssertEqual(tails.count, 16, "every scalar-tail length is covered")
    }

    func testGetAffineTransformMatchesCV2Exactly() {
        for (i, c) in Self.refs.affine.enumerated() {
            XCTAssertEqual(CVGeometry.getAffineTransform(Self.pts(c.src), Self.pts(c.dst)), c.M, "affine case \(i)")
        }
    }

    func testFillConvexPolyMatchesCV2() {
        for (i, c) in Self.refs.poly.enumerated() {
            var m = [UInt8](repeating: 0, count: c.w * c.h)
            let v = stride(from: 0, to: 6, by: 2).map { (x: c.pts[$0], y: c.pts[$0 + 1]) }
            CVGeometry.fillConvexPoly(&m, width: c.w, height: c.h, v, value: 255)
            XCTAssertEqual(m, Self.bytes(c.mask), "poly case \(i): \(c.w)x\(c.h) \(c.pts)")
        }
    }

    func testDelaunayMatchesHomrSubdiv2D() throws {
        for (i, c) in Self.refs.delaunay.enumerated() {
            let got = try? StaffPrepare.PiecewiseAffine.triangulate(Self.pts(c.points))
            XCTAssertEqual(got, c.simplices, "delaunay case \(i)")
        }
    }

    func testRemoveBlackContoursMatchesHomr() {
        var changed = 0
        for (i, c) in Self.refs.contours.enumerated() {
            var g = Self.bytes(c.src)
            StaffPrepare.removeBlackContoursAtEdges(&g, width: c.w, height: c.h, unitSize: c.unit)
            let want = Self.bytes(c.dst)
            XCTAssertEqual(g, want, "contours case \(i)")
            if want != Self.bytes(c.src) { changed += 1 }
        }
        XCTAssertGreaterThan(changed, 5, "the refs must exercise the removal branch")
    }

    func testNumpyReductions() {
        XCTAssertEqual(numpyPairwiseSum([1.0, 1e16, 1.0, -1e16][...]), 0) // sequential below 8
        XCTAssertEqual(numpyMedian([3, 1, 2, 10]), 2.5)
        XCTAssertEqual(numpyMedian([3, 1, 2]), 2)
    }

    // MARK: page oracle (homr prepare_staff_image)

    func runOracle(_ dir: URL) throws -> (StaffPrepare.Result, (pixels: [UInt8], width: Int, height: Int)) {
        let page = try PNGDecoder.decode(contentsOf: dir.appendingPathComponent("page.png"))
        let geo = try StaffPrepare.loadGeometry(dir.appendingPathComponent("geometry.json"))
        let r = try StaffPrepare.prepareStaffImage(page: page.grayscale(), width: page.width, height: page.height, geometry: geo)
        let want = try StaffPrepare.loadGrayNPY(dir.appendingPathComponent("prepared.npy"))
        return (r, want)
    }

    func testCScalePageMatchesPrepareStaffImageOracle() throws {
        let dir = try Self.oracleDir()
        let (r, want) = try runOracle(dir)
        XCTAssertEqual([r.width, r.height], [want.width, want.height])
        XCTAssertEqual([r.canvasWidth, r.canvasHeight], [817, 256])
        XCTAssertEqual(r.pixels, want.pixels, "prepared image differs from homr's")
        // canvas == the Gate-1 staff.png, tensor == staff.npy
        let canvas = try StaffPrepare.canvas(r)
        let gate = try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.c_scale_staff")
        XCTAssertEqual(canvas, try PNGDecoder.decode(contentsOf: gate.appendingPathComponent("staff.png")).grayscale())
        let page = try PNGDecoder.decode(contentsOf: dir.appendingPathComponent("page.png"))
        let t = try StaffTensor.fromPage(grayscale: page.grayscale(), width: page.width, height: page.height,
                                         geometry: StaffPrepare.loadGeometry(dir.appendingPathComponent("geometry.json")))
        XCTAssertEqual(StaffTensorDiff(t, try StaffTensor.loadNPY(gate.appendingPathComponent("staff.npy"))).maxAbs, 0)
    }

    func testWarpedGeometryMatchesPrepareStaffImageOracle() throws {
        let dir = try Self.oracleDir().appendingPathComponent("warped")
        let (r, want) = try runOracle(dir)
        XCTAssertEqual([r.width, r.height], [want.width, want.height])
        XCTAssertEqual(r.pixels, want.pixels, "prepared image differs from homr's")
    }

    func testGeometryDerivedValuesMatchHomr() throws {
        struct Derived: Decodable {
            struct D: Decodable { var min_x: Double; var max_x: Double; var min_y: Double; var max_y: Double
                var average_unit_size: Double; var region: [Int]; var canvas_size: [Int] }
            var derived: D
        }
        for sub in ["", "warped"] {
            let url = try Self.oracleDir().appendingPathComponent(sub).appendingPathComponent("geometry.json")
            let d = try JSONDecoder().decode(Derived.self, from: Data(contentsOf: url)).derived
            let geo = try StaffPrepare.loadGeometry(url)
            let staff = try HomrStaff(geo.grid.map { HomrStaffPoint(x: $0.x, y: $0.y) })
            XCTAssertEqual([staff.minX, staff.maxX, staff.minY, staff.maxY, staff.averageUnitSize],
                           [d.min_x, d.max_x, d.min_y, d.max_y, d.average_unit_size])
            XCTAssertEqual(StaffPrepare.calculateRegion(staff, geo.regions.map { ($0[0], $0[1]) }), d.region)
        }
    }

    func testBadGeometryThrows() {
        XCTAssertThrowsError(try StaffPrepare.prepareStaffImage(page: [255], width: 1, height: 1,
                                                                geometry: StaffGeometry(grid: [], regions: [])))
        XCTAssertThrowsError(try StaffPrepare.prepareStaffImage(
            page: [255], width: 1, height: 1,
            geometry: StaffGeometry(grid: [.init(x: 0, y: [1, 2, 3])], regions: [])))
    }
}
