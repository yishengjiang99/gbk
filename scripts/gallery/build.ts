// Builds the private demo gallery (#72 Phase 4) by replaying scripts/gallery/recipes.ts through the public MCP
// tools of a GBK server: create (fixed seed) -> typed edits -> headless server render -> download + validate the
// WAV and SMF -> explanation computed from the data. Writes <out>/manifest.json and <out>/<slug>/{song.wav,song.mid}.
// Compositions are created private and deleted afterwards with their own edit key; access tokens are never
// written or printed. Nothing is published.
//   node --import tsx/esm scripts/gallery/build.ts https://compose.grepawk.com ./gallery-out --server-commit <sha>
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mcp, wavInfo, midiInfo } from "../acceptance/mcp-acceptance.ts";
import { RECIPES, type Recipe } from "./recipes.ts";
import { explain, type GalleryDemo, type GalleryManifest, type GNote, type GTrack } from "../../server/src/gallery.ts";

/** CC11 events per MIDI channel, read from the exported SMF. */
export function smfCc11(b: Buffer): { channel: number; tick: number; value: number }[] {
  const out: { channel: number; tick: number; value: number }[] = []; let p = 14;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p + 4), end = p + 8 + len; let q = p + 8, tick = 0, status = 0;
    const vlq = () => { let v = 0, c; do { c = b[q++]!; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
    while (q < end) {
      tick += vlq(); let s = b[q]!;
      if (s & 0x80) { status = s; q++; } else s = status;
      if (s === 0xff) { q++; const l = vlq(); q += l; continue; }
      if (s === 0xf0 || s === 0xf7) { const l = vlq(); q += l; continue; }
      const hi = s & 0xf0, d1 = b[q]!, two = hi !== 0xc0 && hi !== 0xd0;
      if (hi === 0xb0 && d1 === 11) out.push({ channel: s & 0x0f, tick, value: b[q + 1]! });
      q += two ? 2 : 1;
    }
    p = end;
  }
  return out;
}

function resolve(ops: Record<string, unknown>[], tracks: GTrack[]) {
  const one = (v: string) => {
    if (v.startsWith("@role:")) { const t = tracks.find((x) => x.role === v.slice(6)); if (!t) throw new Error(`no track with role ${v}`); return t.id; }
    const i = Number(v.slice(1)); if (!tracks[i]) throw new Error(`no track ${v}`); return tracks[i]!.id;
  };
  return ops.map((o) => {
    const r: Record<string, unknown> = { ...o };
    for (const k of ["track", "sourceTrack", "targetTrack", "againstTrack"]) if (typeof r[k] === "string" && (r[k] as string).startsWith("@")) r[k] = one(r[k] as string);
    if (r.trackIds === "@all") r.trackIds = tracks.filter((t) => t.channel !== 9).map((t) => t.id);
    return r;
  });
}

export async function buildDemo(c: Mcp, base: string, r: Recipe, outDir: string, serverCommit: string, log: (s: string) => void): Promise<GalleryDemo> {
  const cr = await c.call("gbk_create_composition", r.create);
  if (!cr.ok) throw new Error(`${r.slug}: create failed ${cr.code}`);
  const id = cr.data.compositionId as string, accessToken = cr.data.accessToken as string;
  try {
    let rev = cr.data.revision as number; let tracks = cr.data.tracks as GTrack[];
    for (const ops of r.edits) {
      const args = { compositionId: id, accessToken, expectedRevision: rev, operations: resolve(ops, tracks) };
      const e = await c.call("gbk_edit_composition", args);
      if (!e.ok) { const raw = await c.send("tools/call", { name: "gbk_edit_composition", arguments: args }); throw new Error(`${r.slug}: edit failed ${e.code}: ${raw.rpc?.result?.content?.[0]?.text?.slice(0, 300) ?? ""}`); }
      rev = e.data.revision as number;
      tracks = ((await c.call("gbk_get_composition", { compositionId: id, accessToken })).data.tracks as GTrack[]) ?? tracks;
    }
    const notes: GNote[] = []; let offset = 0; let comp: Record<string, any> = {};
    for (;;) {
      const g = await c.call("gbk_get_composition", { compositionId: id, accessToken, includeNotes: true, offset, limit: 1000 });
      if (!g.ok) throw new Error(`${r.slug}: get failed ${g.code}`);
      comp = g.data; for (const n of g.data.notes.items) notes.push({ trackId: n.trackId, tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity });
      if (g.data.notes.nextOffset == null || g.data.notes.nextOffset >= g.data.notes.total) break; offset = g.data.notes.nextOffset;
    }
    const rd = await c.call("gbk_render_composition", { compositionId: id, accessToken, waitSeconds: 110 });
    if (!rd.ok || rd.data.status !== "completed") throw new Error(`${r.slug}: render ${rd.code}${rd.data.status ?? ""}`);
    if (rd.data.revision !== rev) throw new Error(`${r.slug}: rendered revision ${rd.data.revision} != ${rev}`);
    const dir = join(outDir, r.slug); mkdirSync(dir, { recursive: true });
    const files: Record<string, { bytes: Buffer; sha256: string }> = {};
    for (const a of rd.data.artifacts as { kind: string; downloadUrl: string; sha256: string }[]) {
      const u = new URL(a.downloadUrl, base); const res = await fetch(new URL(u.pathname + u.search, base));
      const bytes = Buffer.from(await res.arrayBuffer()); const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (res.status !== 200 || sha256 !== a.sha256) throw new Error(`${r.slug}: ${a.kind} download ${res.status} sha mismatch=${sha256 !== a.sha256}`);
      files[a.kind] = { bytes, sha256 };
    }
    const w = wavInfo(files.wav!.bytes), m = midiInfo(files.midi!.bytes);
    if (w.silent || w.seconds < 1) throw new Error(`${r.slug}: WAV is silent or too short`);
    writeFileSync(join(dir, "song.wav"), files.wav!.bytes); writeFileSync(join(dir, "song.mid"), files.midi!.bytes);
    const chan = new Map((comp.tracks as GTrack[]).map((t) => [t.channel, t.id]));
    const cc11 = smfCc11(files.midi!.bytes).filter((e) => chan.has(e.channel)).map((e) => ({ trackId: chan.get(e.channel)!, tick: e.tick, value: e.value }));
    const composition = { title: comp.title, key: comp.key, style: comp.style, seed: comp.seed, ppq: comp.ppq, tempoBpm: comp.tempoBpm, timeSignature: comp.timeSignature,
      bars: comp.bars, durationSec: comp.durationSec, noteCount: comp.noteCount, ccCount: comp.ccCount, sections: comp.sections,
      tracks: (comp.tracks as GTrack[]).map((t) => ({ id: t.id, name: t.name, role: t.role, program: t.program, channel: t.channel, notes: t.notes, controllers: t.controllers })), revision: comp.revision };
    log(`${r.slug}: rev ${rev}, ${notes.length} notes, ${composition.tracks.length} tracks, WAV ${w.seconds.toFixed(1)}s ${w.rate}Hz, SMF ${m.tracks} tracks, CC11 ${cc11.length}`);
    return { slug: r.slug, title: r.title, prompt: r.prompt, featured: r.featured, recipe: { create: r.create, edits: r.edits }, composition, notes, cc11,
      wav: { file: "song.wav", sizeBytes: files.wav!.bytes.length, sha256: files.wav!.sha256, sampleRate: w.rate, channels: w.channels, bits: w.bits, seconds: Number(w.seconds.toFixed(3)) },
      midi: { file: "song.mid", sizeBytes: files.midi!.bytes.length, sha256: files.midi!.sha256, format: m.format, tracks: m.tracks, division: m.division },
      explanation: explain(composition, notes, cc11),
      reproducibility: { builtAt: new Date().toISOString(), server: new URL(base).host, serverCommit, soundFont: String(rd.data.soundFont?.name ?? rd.data.soundFont ?? "default"), renderer: String(rd.data.renderer ?? rd.data.renderedBy ?? "server"), revision: rev } };
  } finally {
    await c.call("gbk_delete_composition", { compositionId: id, accessToken, confirm: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base = "http://127.0.0.1:8787", out = "./gallery-out"] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--server-commit");
  const ci = process.argv.indexOf("--server-commit"); const serverCommit = ci > 0 ? process.argv[ci + 1]! : "unknown";
  const only = process.argv.indexOf("--only") > 0 ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
  mkdirSync(out, { recursive: true });
  const c = await new Mcp(base).init(); const demos: GalleryDemo[] = [];
  for (const r of RECIPES.filter((x) => !only || x.slug === only)) demos.push(await buildDemo(c, base, r, out, serverCommit, console.log));
  const manifest: GalleryManifest = { generatedAt: new Date().toISOString(), demos };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
  console.log(`wrote ${demos.length} demos to ${out}`);
}
