// Demo gallery recipes (#72 Phase 4). Each demo is produced by the real engine through the public MCP tools:
// one gbk_create_composition call (fixed seed) plus typed gbk_edit_composition operations. scripts/gallery/build.ts
// replays a recipe against any GBK base URL; the same recipe + seed + server version gives the same notes.
export interface Recipe {
  slug: string; title: string;
  /** What a user would type in ChatGPT to get a piece like this. */
  prompt: string;
  create: Record<string, unknown>;
  /** Each entry is one gbk_edit_composition call. Track names are resolved to ids at build time ("@Name"). */
  edits: Record<string, unknown>[][];
  /** Three of these appear on /chatgpt once the owner makes the gallery public. */
  featured?: boolean;
}

export const RECIPES: Recipe[] = [
  { slug: "baroque-fugue", title: "Baroque Fugue in D minor", featured: true,
    prompt: "Compose a 16-bar four-voice Baroque fugue in D minor for organ, then add a CC11 crescendo into the final entry.",
    create: { title: "Baroque Fugue in D minor", style: "baroque", key: "D minor", tempo: 76, bars: 16, voices: 4, instrumentation: ["organ", "organ", "organ", "organ"], seed: 1720 },
    edits: [[{ type: "cc_curve", trackIds: "@all", controller: 11, startBar: 9, endBar: 16, shape: "crescendo", from: 70, to: 127 }]] },
  { slug: "two-part-invention", title: "Two-Part Invention in F major",
    prompt: "Write a 12-bar two-part invention in F major for harpsichord: a melody in the right hand and imitative counterpoint in the left.",
    create: { title: "Two-Part Invention in F major", style: "classical", key: "F major", tempo: 96, bars: 12, instrumentation: ["harpsichord", "harpsichord"], seed: 1723 },
    edits: [[{ type: "generate_part", track: "@0", startBar: 1, endBar: 12, kind: "melody", seed: 11 },
             { type: "generate_part", track: "@1", startBar: 1, endBar: 12, kind: "counterpoint", againstTrack: "@0", seed: 12 }]] },
  { slug: "orchestral-cue", title: "Orchestral Cue in C minor", featured: true,
    prompt: "Compose a 24-bar orchestral cue in C minor for strings, woodwinds and brass that builds from quiet to a full climax, with a swell in the strings.",
    create: { title: "Orchestral Cue in C minor", style: "classical", key: "C minor", tempo: 84, bars: 24, instrumentation: ["violin", "viola", "cello", "flute", "clarinet", "horn", "trumpet"], seed: 2024,
      sections: [{ name: "Intro", startBar: 1, bars: 8, energy: 0.3 }, { name: "Build", startBar: 9, bars: 8, energy: 0.6 }, { name: "Climax", startBar: 17, bars: 8, energy: 1 }] },
    edits: [[{ type: "cc_curve", trackIds: "@all", controller: 11, startBar: 1, endBar: 24, shape: "crescendo", from: 50, to: 127 },
             { type: "cc_curve", track: "@0", controller: 11, startBar: 9, endBar: 16, shape: "swell", from: 60, peak: 120, to: 90 }]] },
  { slug: "game-soundtrack", title: "Game Soundtrack Loop in E minor",
    prompt: "Make a loopable 16-bar game soundtrack in E minor at 132 BPM with a main theme (A) and a contrasting B section, drums and bass.",
    create: { title: "Game Soundtrack Loop in E minor", style: "pop", key: "E minor", tempo: 132, bars: 16, seed: 3132,
      sections: [{ name: "A (theme)", startBar: 1, bars: 8, energy: 0.8 }, { name: "B (contrast)", startBar: 9, bars: 8, energy: 0.5 }] },
    edits: [] },
  { slug: "ambient-piano", title: "Ambient Piano in A major", featured: true,
    prompt: "Compose a 16-bar ambient piano piece in A major at 64 BPM, then add a CC11 crescendo in bars 9–16.",
    create: { title: "Ambient Piano in A major", style: "ambient", key: "A major", tempo: 64, bars: 16, instrumentation: ["piano"], seed: 6464 },
    edits: [[{ type: "cc_curve", trackIds: "@all", controller: 11, startBar: 9, endBar: 16, shape: "crescendo", from: 60, to: 120 }]] },
  { slug: "jazz-walking-bass", title: "Jazz in F major with Walking Bass",
    prompt: "Write a 24-bar jazz piece in F major at 140 BPM with a walking bass, piano chords and drums, then add a CC11 crescendo in bars 17–24.",
    create: { title: "Jazz in F major with Walking Bass", style: "jazz", key: "F major", tempo: 140, bars: 24, seed: 140 },
    edits: [[{ type: "generate_part", track: "@role:bass", startBar: 1, endBar: 24, kind: "walking_bass", seed: 9 },
             { type: "cc_curve", trackIds: "@all", controller: 11, startBar: 17, endBar: 24, shape: "crescendo", from: 70, to: 127 }]] },
];
