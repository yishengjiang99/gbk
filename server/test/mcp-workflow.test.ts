// Remote MCP end-to-end music workflows (mission §12, Tests A–E). Rendering happens ONLY in a connected
// Studio tab (a node TestTab running the real BrowserToolBridge + offline renderer); with no tab the render
// tool returns an "open the studio to render" link and creates no job.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer, openStudio } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { McpStore } from "../src/mcp/store.ts";
import { CompositionService } from "../src/mcp/service.ts";
import { RenderService, DEFAULT_RENDER_CONFIG } from "../src/mcp/browser-render.ts";
import { ShareStore } from "../src/persistence/shares.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = () => new ScriptModel([() => reply("x")]);
const asUser = (s: { base: string }, user: string) => new McpClient(s.base, { "x-gbk-test-user": user });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Created { compositionId: string; revision: number; noteCount: number; tracks: { id: string; name: string; notes: number }[]; tempoBpm: number; bars: number; projectUrl: string }
interface Rendered { status: string; jobId: string; artifacts: { kind: string; sha256: string; sizeBytes: number; meta: { validated?: boolean; durationSeconds?: number; sampleRate?: number; channels?: number } }[] }

async function fugue(mcp: McpClient): Promise<Created> {
  return mcp.call<Created>("gbk_create_composition", {
    title: "Test Fugue in D minor", style: "baroque", key: "D minor", tempo: 108, bars: 8, seed: 7,
    instrumentation: ["organ", "organ", "organ", "organ"], idempotencyKey: "create-fugue-0001",
  });
}

test("A: composition with no tab; render asks to open the studio, then renders in the connected Studio tab; artifacts download and verify", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    assert.equal(s.hub.registry.size, 0, "no browser clients connected (Test C precondition)");
    const alice = asUser(s, "alice"); await alice.initialize();
    const c = await fugue(alice);
    assert.ok(c.compositionId.startsWith("cmp_"));
    assert.ok(c.tracks.length >= 3, `expected a multi-voice fugue, got ${c.tracks.length} tracks`);
    assert.ok(c.noteCount > 40, `expected real musical content, got ${c.noteCount} notes`);
    assert.equal(c.tempoBpm, 108);
    assert.ok(c.revision >= 1);

    // Idempotent replay: same key + same args returns the same composition instead of creating a second one.
    const replay = await fugue(alice);
    assert.equal(replay.compositionId, c.compositionId);
    const list = await alice.call<{ items: unknown[] }>("gbk_list_compositions", {});
    assert.equal(list.items.length, 1);

    const none = await alice.call<{ status: string; studioUrl: string; message: string }>("gbk_render_composition", { compositionId: c.compositionId, waitSeconds: 5 });
    assert.equal(none.status, "studio_required");
    assert.equal(none.studioUrl, "http://composer.test/studio");
    assert.match(none.message, /Open the studio to render/);
    const tab = await openStudio(s, "code-a");
    const r = await alice.call<Rendered>("gbk_render_composition", { compositionId: c.compositionId, waitSeconds: 120, tailSeconds: 1 });
    assert.equal(r.status, "completed", JSON.stringify(r));
    assert.ok(tab.executed.includes("gbk_mcp_render_job"), "the Studio tab did the render");
    assert.equal((r as unknown as { config: { executor: string } }).config.executor, "browser");
    const wav = r.artifacts.find((a) => a.kind === "wav")!, mid = r.artifacts.find((a) => a.kind === "midi")!;
    assert.ok(wav && mid, "both WAV and MIDI artifacts exist");
    assert.equal(wav.meta.validated, true);
    assert.equal(wav.meta.sampleRate, 44100); assert.equal(wav.meta.channels, 2);
    // 8 bars of 4/4 at 108 BPM ≈ 17.8 s of music + 1 s tail.
    assert.ok(Math.abs((wav.meta.durationSeconds ?? 0) - 18.8) < 2.5, `duration ${wav.meta.durationSeconds}`);

    const arts = await alice.call<{ latest: { wav: { downloadUrl: string }; midi: { downloadUrl: string } } }>("gbk_get_artifacts", { compositionId: c.compositionId });
    const wavUrl = new URL(arts.latest.wav.downloadUrl), midUrl = new URL(arts.latest.midi.downloadUrl);
    const wavRes = await fetch(`${s.base}${wavUrl.pathname}${wavUrl.search}`);
    assert.equal(wavRes.status, 200);
    assert.match(wavRes.headers.get("content-type") ?? "", /audio\/wav/);
    const wavBytes = new Uint8Array(await wavRes.arrayBuffer());
    assert.equal(String.fromCharCode(...wavBytes.subarray(0, 4)), "RIFF");
    assert.equal(sha(wavBytes), wav.sha256, "downloaded WAV matches the recorded SHA-256");
    assert.equal(wavBytes.length, wav.sizeBytes);
    // Range request (streamed playback support).
    const ranged = await fetch(`${s.base}${wavUrl.pathname}${wavUrl.search}`, { headers: { range: "bytes=0-99" } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const midRes = await fetch(`${s.base}${midUrl.pathname}${midUrl.search}`);
    const midBytes = new Uint8Array(await midRes.arrayBuffer());
    assert.equal(String.fromCharCode(...midBytes.subarray(0, 4)), "MThd", "valid Standard MIDI File");
    assert.equal(sha(midBytes), mid.sha256);
    tab.close();
  } finally { await s.app.close(); }
});

test("B: follow-up edit keeps the composition, bumps the revision, leaves untouched bars unchanged, re-renders differently", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const c = await fugue(alice);
    const before = await alice.call<Created & { notes?: { items: { tick: number }[] } }>("gbk_get_composition", { compositionId: c.compositionId, includeNotes: true, limit: 1000 });
    await openStudio(s, "code-a");
    const firstRender = await alice.call<Rendered>("gbk_render_composition", { compositionId: c.compositionId, waitSeconds: 120, tailSeconds: 1 });
    const firstSha = firstRender.artifacts.find((a) => a.kind === "wav")!.sha256;

    const src = c.tracks[0], tgt = c.tracks[c.tracks.length - 1];
    const edited = await alice.call<{ compositionId: string; revision: number; previousRevision: number; untouchedSectionsUnchanged: boolean | null }>("gbk_edit_composition", {
      compositionId: c.compositionId, expectedRevision: c.revision, idempotencyKey: "edit-fugue-0001",
      operations: [
        { type: "orchestrate", sourceTrack: src.id, targetTrack: tgt.id, startBar: 5, endBar: 8, semitones: -12 },
        { type: "cc_curve", trackIds: c.tracks.map((t) => t.id), controller: 11, startBar: 5, endBar: 8, shape: "crescendo", from: 55, to: 125 },
        { type: "set_mix", track: tgt.id, expression: 121 },
      ],
    });
    assert.equal(edited.compositionId, c.compositionId, "same composition");
    assert.equal(edited.previousRevision, c.revision);
    assert.ok(edited.revision > c.revision, "revision incremented");
    assert.equal(edited.untouchedSectionsUnchanged, true, "notes outside bars 5–8 are byte-identical");

    // A stale write is rejected with the current revision attached.
    await assert.rejects(
      alice.call("gbk_edit_composition", { compositionId: c.compositionId, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 90 }] }),
      (e: Error & { payload?: { error?: { code?: string; details?: { currentRevision?: number } } } }) => e.payload?.error?.code === "STALE_REVISION" && e.payload.error.details?.currentRevision === edited.revision,
    );
    // The pre-edit revision is still recoverable.
    const hist = await alice.call<{ revisions: { revision: number }[] }>("gbk_get_composition", { compositionId: c.compositionId });
    assert.ok(hist.revisions.some((r) => r.revision === c.revision));

    const second = await alice.call<Rendered>("gbk_render_composition", { compositionId: c.compositionId, waitSeconds: 120, tailSeconds: 1 });
    assert.equal(second.status, "completed");
    assert.notEqual(second.artifacts.find((a) => a.kind === "wav")!.sha256, firstSha, "revised render differs");
    void before;
  } finally { await s.app.close(); }
});

test("B2: fugue-section edit op (canonical schema has no baseRevision) applies cleanly", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const c = await alice.call<Created>("gbk_create_composition", { title: "Fugue edit target", style: "baroque", key: "D minor", bars: 8, seed: 12 });
    const edited = await alice.call<{ revision: number }>("gbk_edit_composition", {
      compositionId: c.compositionId, expectedRevision: c.revision,
      operations: [{ type: "generate_fugue_section", key: "D minor", voices: 4, atBar: 5, maxBars: 4, seed: 3 }],
    });
    assert.ok(edited.revision > c.revision);
  } finally { await s.app.close(); }
});

test("D: concurrent users are isolated — no project or artifact leakage", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const bob = asUser(s, "bob"); await bob.initialize();
    const [ca, cb] = await Promise.all([
      alice.call<Created>("gbk_create_composition", { title: "Alice piece", style: "classical", bars: 4, seed: 3 }),
      bob.call<Created>("gbk_create_composition", { title: "Bob piece", style: "ambient", bars: 4, seed: 4 }),
    ]);
    assert.notEqual(ca.compositionId, cb.compositionId);
    await assert.rejects(bob.call("gbk_get_composition", { compositionId: ca.compositionId }),
      (e: Error & { payload?: { error?: { code?: string } } }) => e.payload?.error?.code === "NOT_FOUND");
    await assert.rejects(bob.call("gbk_get_artifacts", { compositionId: ca.compositionId }),
      (e: Error & { payload?: { error?: { code?: string } } }) => e.payload?.error?.code === "NOT_FOUND");
    await openStudio(s, "code-a");
    const render = await alice.call<Rendered>("gbk_render_composition", { compositionId: ca.compositionId, waitSeconds: 120, tailSeconds: 0 });
    assert.equal(render.status, "completed");
    const artId = (render as unknown as { artifacts: { artifactId: string }[] }).artifacts[0].artifactId;
    // Bob's own credentials do not open Alice's artifact (no signature, wrong owner).
    const res = await fetch(`${s.base}/api/mcp/artifacts/${artId}`, { headers: { "x-gbk-test-user": "bob" } });
    assert.equal(res.status, 404);
    const bobList = await bob.call<{ items: { compositionId: string }[] }>("gbk_list_compositions", {});
    assert.deepEqual(bobList.items.map((i) => i.compositionId), [cb.compositionId]);
  } finally { await s.app.close(); }
});

test("E: worker interruption fails explicitly (no false completion); an empty project render fails with no artifacts", async () => {
  // Jobs left "running" by a dead process are failed on store open, never completed.
  const dir = mkdtempSync(join(tmpdir(), "gbk-mcp-e-"));
  const file = join(dir, "mcp.sqlite");
  const st1 = new McpStore(file, dir);
  const job = st1.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
  st1.patchJob(job.id, { status: "running" });
  st1.close();
  const st2 = new McpStore(file, dir);
  const after = st2.getJob(job.id, "alice")!;
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /WORKER_INTERRUPTED/);
  assert.equal(st2.listArtifacts("cmp_x", "alice").length, 0, "no partial artifact was published");
  st2.close();

  // Rendering a project whose notes were all removed fails cleanly.
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const c = await alice.call<Created>("gbk_create_composition", { title: "Soon empty", style: "classical", bars: 4, seed: 5 });
    // Remove every note in bounded chunks (one note_patch operation per edit).
    let revision = c.revision;
    for (let guard = 0; guard < 20; guard++) {
      const page = await alice.call<{ notes: { items: { id: string }[]; total: number } }>("gbk_get_composition", { compositionId: c.compositionId, includeNotes: true, limit: 50 });
      if (page.notes.total === 0) break;
      const step = await alice.call<{ revision: number }>("gbk_edit_composition", {
        compositionId: c.compositionId, expectedRevision: revision,
        operations: [{ type: "note_patch", remove: page.notes.items.map((n) => n.id) }],
      });
      revision = step.revision;
    }
    const emptied = { revision };
    await openStudio(s, "code-a");
    const r = await alice.call<{ status: string; error: { code: string } | null; artifacts: unknown[] }>("gbk_render_composition", { compositionId: c.compositionId, revision: emptied.revision, waitSeconds: 60 });
    assert.equal(r.status, "failed");
    assert.ok(r.error?.code, "failure carries a machine-readable code");
    assert.equal(r.artifacts.length, 0);
  } finally { await s.app.close(); }
});

test("F: the per-account daily render limit is enforced on MCP renders", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", MCP_MAX_RENDERS_PER_DAY: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const c = await alice.call<Created>("gbk_create_composition", { title: "Limit", style: "classical", bars: 2, seed: 3 });
    await openStudio(s, "code-a");
    const r = await alice.call<Rendered>("gbk_render_composition", { compositionId: c.compositionId, waitSeconds: 120, tailSeconds: 0 });
    assert.equal(r.status, "completed");
    await assert.rejects(alice.call("gbk_render_composition", { compositionId: c.compositionId }), /QUOTA_EXCEEDED/);
  } finally { await s.app.close(); }
});

test("G: queued jobs left by a restart fail explicitly; terminal states are final; artifact publication is atomic", async () => {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test" });
  const dir = mkdtempSync(join(tmpdir(), "gbk-mcp-f-"));
  const file = join(dir, "mcp.sqlite");

  // Phase 1: a composition plus a QUEUED job row, exactly as a process dying before the
  // worker picked the job up would leave it — plus a queued job for a vanished composition.
  const st1 = new McpStore(file, dir);
  const svc = new CompositionService(cfg, st1, new ShareStore(":memory:"));
  const { row } = await svc.create("alice", { title: "Restart Fugue", style: "baroque", key: "D minor", tempo: 108, bars: 4, seed: 3,
    instrumentation: ["organ", "organ", "organ", "organ"] }, new AbortController().signal);
  const job = st1.createJob({ compositionId: row.id, owner: "alice", revision: row.revision, config: { ...DEFAULT_RENDER_CONFIG } });
  const orphan = st1.createJob({ compositionId: "cmp_missing", owner: "alice", revision: 0, config: { ...DEFAULT_RENDER_CONFIG } });
  st1.close();

  // Phase 2: a fresh store + render service on the same files (the "restart"). Renders need a live Studio
  // tab handoff that did not survive the restart, so leftover queued jobs fail explicitly (never stick).
  const st2 = new McpStore(file, dir);
  const renders = new RenderService(cfg, st2, () => null);
  await renders.start();
  try {
    const orphanAfter = st2.getJob(orphan.id, "alice")!;
    assert.equal(orphanAfter.status, "failed", "orphaned queued job fails instead of sticking at queued");
    const after = st2.getJob(job.id, "alice")!;
    assert.equal(after.status, "failed");
    assert.match(after.error ?? "", /JOB_INTERRUPTED/);
    assert.equal(st2.listArtifacts(row.id, "alice").length, 0);
  } finally { await renders.stop(); st2.close(); }

  // Terminal states are final: a guarded transition out of a terminal state changes nothing.
  const st3 = new McpStore(join(dir, "other.sqlite"), dir);
  const j3 = st3.createJob({ compositionId: "cmp_x", owner: "alice", revision: 0, config: {} });
  assert.equal(st3.transitionJob(j3.id, ["queued", "running"], { status: "cancelled", finished_at: Date.now() }), true);
  assert.equal(st3.transitionJob(j3.id, ["queued", "running"], { status: "failed", error: "late worker exit" }), false,
    "a late failure must not overwrite a cancellation");
  assert.equal(st3.getJob(j3.id, "alice")!.status, "cancelled");

  // Atomic publication: a failing second insert rolls the whole batch back.
  assert.throws(() => st3.addArtifacts([
    { job_id: j3.id, composition_id: "cmp_x", owner: "alice", revision: 0, kind: "wav", filename: "a.wav", mime_type: "audio/wav", size_bytes: 1, sha256: "x", rel_path: "a.wav", meta_json: "{}" },
    { job_id: j3.id, composition_id: "cmp_x", owner: "alice", revision: 0, kind: null as never, filename: "b.mid", mime_type: "audio/midi", size_bytes: 1, sha256: "y", rel_path: "b.mid", meta_json: "{}" },
  ]));
  assert.equal(st3.listArtifacts("cmp_x", "alice").length, 0, "no partial artifact batch survives a failed publication");
  st3.close();
});
