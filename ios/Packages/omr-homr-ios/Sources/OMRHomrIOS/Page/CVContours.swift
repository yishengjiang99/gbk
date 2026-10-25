// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0) support code:
// homr calls cv2.findContours(…, RETR_TREE | RETR_EXTERNAL, CHAIN_APPROX_SIMPLE) in autocrop.py and
// bounding_boxes.py. This is a line-by-line port of OpenCV 5.0.0 imgproc/src/contours_new.cpp +
// contours_common.hpp (Apache-2.0): Suzuki–Abe border following on a 1-px zero-padded schar image,
// same marks (MASK8_NEW / MASK8_RIGHT, nbd wrapping at 127), same parent search, same output order
// (TreeIterator preorder, children newest first), so contours come out point-for-point identical.

import Foundation

enum CVContours {
    enum Mode { case external, tree }

    struct Point: Equatable, Hashable {
        var x: Int
        var y: Int
    }

    /// `cv2.findContours(img, mode, cv2.CHAIN_APPROX_SIMPLE)[0]` for an 8-bit image (nonzero = foreground).
    static func find(_ img: UnsafeBufferPointer<UInt8>, width w: Int, height h: Int, stride: Int? = nil,
                     mode: Mode) -> [[Point]] {
        let st = stride ?? w
        var padded = [Int8](repeating: 0, count: (w + 2) * (h + 2))
        padded.withUnsafeMutableBufferPointer { p in
            for y in 0..<h {
                let src = y * st
                let dst = (y + 1) * (w + 2) + 1
                for x in 0..<w where img[src + x] != 0 { p[dst + x] = 1 }
            }
        }
        return find(padded: &padded, width: w, height: h, mode: mode)
    }

    static func find(_ img: [UInt8], width w: Int, height h: Int, mode: Mode) -> [[Point]] {
        img.withUnsafeBufferPointer { find($0, width: w, height: h, mode: mode) }
    }

    /// Scan an already padded 0/1 image of `(w + 2) x (h + 2)` (zero frame). The buffer is marked in place.
    static func find(padded: inout [Int8], width w: Int, height h: Int, mode: Mode) -> [[Point]] {
        precondition(padded.count == (w + 2) * (h + 2))
        return padded.withUnsafeMutableBufferPointer { buf -> [[Point]] in
            var s = Scanner(image: buf.baseAddress!, width: w + 2, height: h + 2, mode: mode)
            while s.findNext() {}
            return s.results()
        }
    }

    // MARK: - scanner (ContourScanner_)

    struct Node {
        var parent = -1
        var firstChild = -1
        var prev = -1
        var next = -1
        var ctableNext = -1
        var isHole = false
        var brect = (x: 0, y: 0, width: 0, height: 0)
        var origin = Point(x: 0, y: 0)
        var points: [Point] = []
    }

    static let deltas: [(Int, Int)] = [(1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1)]
    static let maskRight: Int8 = -128   // '\x80'
    static let maskNew: Int8 = 2
    static let maskFlags: Int = -2      // '\xFE' as int
    static let maskLVal: Int = 0x7F

    struct Scanner {
        let img: UnsafeMutablePointer<Int8>
        let width: Int   // padded
        let height: Int  // padded
        let mode: Mode
        let offset = Point(x: -1, y: -1)
        var pt = Point(x: 1, y: 1)
        var lnbd = Point(x: 0, y: 1)
        var nbd: Int8 = 2
        var tree: [Node] = []
        var ctable = [Int](repeating: -1, count: 128)
        let delta: [Int]

        init(image: UnsafeMutablePointer<Int8>, width: Int, height: Int, mode: Mode) {
            img = image
            self.width = width
            self.height = height
            self.mode = mode
            delta = CVContours.deltas.map { $0.0 + $0.1 * width }
            var root = Node()
            root.isHole = true
            root.brect = (0, 0, width, height)
            tree.append(root)
        }

        var isSimple: Bool { mode == .external }

        @inline(__always) func at(_ x: Int, _ y: Int) -> Int8 { img[y * width + x] }
        @inline(__always) func d(_ s: Int) -> Int { delta[s & 7] }

        // icvTraceContour<schar>
        func traceContour(start: Point, end: Point, isHole: Bool) -> Bool {
            let stop = end.y * width + end.x
            let i0 = start.y * width + start.x
            let sEnd = isHole ? 0 : 4
            var s = sEnd
            var i1 = 0
            repeat {
                s = (s - 1) & 7
                i1 = i0 + d(s)
            } while img[i1] == 0 && s != sEnd
            var i3 = i0
            var i4 = 0
            if s != sEnd {
                while true {
                    s = min(s, 15)
                    while s < 15 {
                        s += 1
                        i4 = i3 + d(s)
                        if img[i4] != 0 { break }
                    }
                    if i3 == stop {
                        if (img[i3] & CVContours.maskRight) == 0 { return true }
                        var t = s
                        while true {
                            t = (t - 1) & 7
                            let i5 = i3 + d(t)
                            if img[i5] != 0 { break }
                            if t == 0 { return true }
                        }
                    }
                    if i4 == i0 && i3 == i1 { break }
                    i3 = i4
                    s = (s + 4) & 7
                }
            } else {
                return i3 == stop
            }
            return false
        }

        // icvFetchContourEx<schar>, CHAIN_APPROX_SIMPLE (isDirect = false, isChain = false)
        func fetchContour(start: Point, nbd: Int8, node: inout Node) {
            let i0 = start.y * width + start.x
            var pt = node.origin
            var rect = (x: pt.x, y: pt.y, width: pt.x, height: pt.y)
            var sEnd = node.isHole ? 0 : 4
            var s = sEnd
            var i1 = 0
            repeat {
                s = (s - 1) & 7
                i1 = i0 + d(s)
            } while img[i1] == 0 && s != sEnd
            if s == sEnd {
                img[i0] = nbd | CVContours.maskRight
                node.points.append(pt)
            } else {
                var i3 = i0
                var i4 = 0
                var prevS = s ^ 4
                while true {
                    sEnd = s
                    s = min(s, 15)
                    while s < 15 {
                        s += 1
                        i4 = i3 + d(s)
                        if img[i4] != 0 { break }
                    }
                    s &= 7
                    if UInt(bitPattern: s - 1) < UInt(bitPattern: sEnd) {
                        img[i3] = nbd | CVContours.maskRight
                    } else if img[i3] == 1 {
                        img[i3] = nbd
                    }
                    if s != prevS {
                        node.points.append(pt)
                        if pt.x < rect.x { rect.x = pt.x } else if pt.x > rect.width { rect.width = pt.x }
                        if pt.y < rect.y { rect.y = pt.y } else if pt.y > rect.height { rect.height = pt.y }
                    }
                    prevS = s
                    pt.x += CVContours.deltas[s].0
                    pt.y += CVContours.deltas[s].1
                    if i4 == i0 && i3 == i1 { break }
                    i3 = i4
                    s = (s + 4) & 7
                }
            }
            rect.width -= rect.x - 1
            rect.height -= rect.y - 1
            node.brect = rect
        }

        mutating func makeContour(_ nbdIO: inout Int8, isHole: Bool, x: Int, y: Int) -> Int {
            let start = Point(x: x - (isHole ? 1 : 0), y: y)
            var node = Node()
            node.isHole = isHole
            node.origin = Point(x: start.x + offset.x, y: start.y + offset.y)
            let idx = tree.count
            if isSimple {
                fetchContour(start: start, nbd: CVContours.maskNew, node: &node)
            } else {
                let lval = nbdIO
                var n = (Int(nbdIO) + 1) & CVContours.maskLVal  // C: int promotion before the mask
                if n == 0 { n = 3 }
                nbdIO = Int8(n)
                fetchContour(start: start, nbd: lval, node: &node)
                node.brect.x -= offset.x
                node.brect.y -= offset.y
                node.ctableNext = ctable[Int(lval)]
                ctable[Int(lval)] = idx
            }
            node.origin = start
            tree.append(node)
            return idx
        }

        mutating func addChild(_ parentIdx: Int, _ childIdx: Int) {
            let fc = tree[parentIdx].firstChild
            if fc != -1 {
                tree[fc].prev = childIdx
                tree[childIdx].next = fc
            }
            tree[parentIdx].firstChild = childIdx
            tree[childIdx].parent = parentIdx
            tree[childIdx].prev = -1
        }

        func findFirstBoundingContour(_ lastPos: Point, _ y: Int, _ lval: Int, _ par: Int) -> Int {
            let end = Point(x: lastPos.x, y: y)
            var res = par
            var cur = ctable[lval]
            while cur != -1 {
                let e = tree[cur]
                if (lastPos.x - e.brect.x) < e.brect.width && (lastPos.y - e.brect.y) < e.brect.height {
                    if res != -1 {
                        let r = tree[res]
                        if traceContour(start: r.origin, end: end, isHole: r.isHole) { break }
                    }
                    res = cur
                }
                cur = e.ctableNext
            }
            return res
        }

        mutating func contourScan(prev: Int, p: Int, lastPos: inout Point, x: Int, y: Int) -> Bool {
            var isHole = false
            if !(prev == 0 && p == 1) {
                if p != 0 || prev < 1 { return false }
                if prev & CVContours.maskFlags != 0 { lastPos.x = x - 1 }
                isHole = true
            }
            if mode == .external && (isHole || at(lastPos.x, lastPos.y) > 0) { return false }
            var mainParent = -1
            if isSimple || lastPos.x <= 0 {
                mainParent = 0
            } else {
                let lval = Int(at(lastPos.x, lastPos.y)) & CVContours.maskLVal
                mainParent = findFirstBoundingContour(lastPos, y, lval, mainParent)
                // OpenCV dereferences tree.elem(-1) here if nothing bounds the point; cannot happen for
                // valid scans (the frame root is always a candidate chain entry), guard anyway.
                if mainParent < 0 { mainParent = 0 }
                if tree[mainParent].isHole == isHole {
                    mainParent = tree[mainParent].parent != -1 ? tree[mainParent].parent : 0
                }
            }
            lastPos.x = x - (isHole ? 1 : 0)
            var n = nbd
            let idx = makeContour(&n, isHole: isHole, x: x, y: y)
            if tree[idx].parent == -1 { addChild(mainParent, idx) }
            pt = Point(x: x + 1, y: y)
            nbd = n
            return true
        }

        mutating func findNext() -> Bool {
            var x = pt.x
            var y = pt.y
            let w = width - 1
            let h = height - 1
            var lastPos = lnbd
            var prev = Int(at(x - 1, y))
            while y < h {
                var p = 0
                while x < w {
                    // findNextX
                    let row = y * width
                    while x < w {
                        p = Int(img[row + x])
                        if p != prev { break }
                        x += 1
                    }
                    if x >= w { break }
                    if contourScan(prev: prev, p: p, lastPos: &lastPos, x: x, y: y) {
                        lnbd = lastPos
                        return true
                    } else {
                        prev = p
                        if prev & CVContours.maskFlags != 0 { lastPos.x = x }
                    }
                    x += 1
                }
                lastPos = Point(x: 0, y: y + 1)
                x = 1
                prev = 0
                y += 1
            }
            return false
        }

        /// contourTreeToResults: TreeIterator preorder from the root, root itself skipped.
        func results() -> [[Point]] {
            if tree[0].points.isEmpty && tree[0].firstChild == -1 { return [] }
            var out: [[Point]] = []
            out.reserveCapacity(tree.count - 1)
            var stack = [0]
            while let idx = stack.popLast() {
                let e = tree[idx]
                var cur = e.firstChild
                if cur != -1 {
                    while tree[cur].next != -1 { cur = tree[cur].next }
                    while cur != -1 {
                        stack.append(cur)
                        cur = tree[cur].prev
                    }
                }
                if idx != 0 { out.append(e.points) }
            }
            return out
        }
    }

    // MARK: - shape helpers on integer contours

    /// `cv::contourArea(contour, oriented=false)`.
    static func contourArea(_ c: [Point]) -> Double {
        guard c.count >= 3 else { return 0 }
        var a00 = 0.0
        var prev = c[c.count - 1]
        for p in c {
            let t1 = Double(prev.x) * Double(p.y)
            let t2 = Double(prev.y) * Double(p.x)
            a00 += t1 - t2
            prev = p
        }
        return abs(a00 * 0.5)
    }

    /// `cv::boundingRect` of integer points.
    static func boundingRect(_ c: [Point]) -> (x: Int, y: Int, width: Int, height: Int) {
        guard let f = c.first else { return (0, 0, 0, 0) }
        var x0 = f.x, x1 = f.x, y0 = f.y, y1 = f.y
        for p in c {
            x0 = min(x0, p.x); x1 = max(x1, p.x)
            y0 = min(y0, p.y); y1 = max(y1, p.y)
        }
        return (x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }
}
