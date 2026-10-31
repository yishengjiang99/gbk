import Foundation

/// Port of src/music/keys.ts: key signature parsing ("C", "G major", "A minor", "F#", "Bb"...).

struct ParsedKey: Sendable { var tonicPc: Int; var mode: String; var label: String; var sf: Int }

private let pcNames: [String: Int] = [
    "C": 0, "B#": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "Fb": 4, "E#": 5,
    "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11, "Cb": 11,
]
private let pcLabel = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
/// Sharps/flats count by tonic pitch class for MAJOR keys (circle of fifths).
private let majorSf: [Int: Int] = [0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -6, 5: -1, 10: -2, 3: -3, 8: -4]

func parseKey(_ input: String?) -> ParsedKey? {
    guard let input else { return nil }
    let s = input.trimmingCharacters(in: .whitespaces)
    if s.isEmpty { return nil }
    // "<note> [major|minor|maj|min|m]"
    let parts = s.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    guard let head = parts.first else { return nil }
    var note = head
    var mode = "major"
    if parts.count > 1 {
        let m = parts[1].lowercased()
        if m == "minor" || m == "min" || m == "m" { mode = "minor" }
        else if m == "major" || m == "maj" { mode = "major" }
        else { return nil }
    } else if note.hasSuffix("m") && note.count > 1 && pcNames[String(note.dropLast())] != nil {
        mode = "minor"; note = String(note.dropLast())
    }
    // Normalize accidental spelling: first letter upper, rest as-is ("bb" -> "Bb").
    let normalized = note.prefix(1).uppercased() + note.dropFirst()
    guard let pc = pcNames[normalized] else { return nil }
    let sfTonic = mode == "minor" ? (pc + 3) % 12 : pc
    let sf = majorSf[sfTonic] ?? 0
    return ParsedKey(tonicPc: pc, mode: mode, label: "\(pcLabel[pc]) \(mode)", sf: sf)
}
