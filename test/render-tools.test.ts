import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup } from "./support/compose-setup.ts";
import { parseWavHeader, validateWav } from "../src/audio/audio-validation.ts";
import { toHostResult } from "../src/webmcp/adapter.ts";
import { artifactStore } from "../src/audio/artifact-store.ts";

async function song(bars = 2, opts: { tempo?: number } = {}) {
  const s = setup();
  await s.call("gbk_create_project", { name: "Byte Test", tempo: opts.tempo ?? 120, key: "D minor" });
  const t = await s.call("gbk_create_track", { name: "Violin", program: 40 });
  const tid = t.data.trackIds[0];
  await s.call("gbk_generate_part", { trackId: tid, range: { unit: "bars", start: 1, end: bars }, kind: "melody", seed: 9 });
  const downloads: string[] = [];
  s.c.host.download = (_d, f) => { downloads.push(f); return true; };
  return { ...s, tid, downloads };
}

test("gbk_render_wav output=artifact, download=false: full WAV via bounded chunks; SHA-256 matches; header + PCM valid", async () => {
  const { call, downloads } = await song(4);
  const r = await call("gbk_render_wav", { output: "artifact", download: false });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.data.status, "completed"); assert.equal(r.data.validated, true);
  assert.equal(downloads.length, 0, "never downloads when download is false");
  assert.ok(r.data.artifactId && r.data.midiArtifactId);
  const parts: Buffer[] = []; let off = 0, calls = 0;
  for (;;) {
    const c = await call("gbk_read_wav_bytes", { artifactId: r.data.artifactId, offset: off, length: 65536 });
    assert.ok(c.ok); parts.push(Buffer.from(c.data.base64, "base64")); calls++;
    assert.equal(c.data.length, Buffer.from(c.data.base64, "base64").length);
    if (c.data.eof) break; off = c.data.nextOffset;
  }
  const wav = Buffer.concat(parts);
  assert.ok(calls > 1);
  assert.equal(wav.length, r.data.bytes);
  assert.equal(createHash("sha256").update(wav).digest("hex"), r.data.sha256);
  const h = parseWavHeader(new Uint8Array(wav));
  assert.equal(h.sampleRate, 44100); assert.equal(h.channels, 2); assert.equal(h.format, "pcm16");
  assert.ok(Math.abs(h.durationSeconds - (8 + 3)) < 0.01, `dur ${h.durationSeconds}`);
  const v = await validateWav(new Uint8Array(wav));
  assert.ok(v.stats.peakDbFS > -40);
  const tooBig = await call("gbk_read_wav_bytes", { artifactId: r.data.artifactId, offset: 0, length: 300000 });
  assert.equal(tooBig.ok, false);
  const list = await call("gbk_list_render_artifacts", {});
  assert.ok(list.data.artifacts.some((x: { artifactId: string }) => x.artifactId === r.data.artifactId));
  const meta = await call("gbk_get_render_artifact", { artifactId: r.data.artifactId });
  assert.equal(meta.data.sha256, r.data.sha256);
});

test("output=bytes inline only when small; output=audio -> content (rich host) or explicit text-only fallback", async () => {
  const { call } = await song(1, { tempo: 240 });
  const small = await call("gbk_render_wav", { output: "bytes", channels: 1, tailSeconds: 0.2 });
  assert.ok(small.ok, JSON.stringify(small.error));
  assert.equal(small.data.output, "bytes");
  assert.equal(createHash("sha256").update(Buffer.from(small.data.base64, "base64")).digest("hex"), small.data.sha256);
  const big = await call("gbk_render_wav", { output: "bytes", tailSeconds: 3 });
  assert.equal(big.data.output, "artifact"); assert.equal(big.data.bytesInline, false); assert.equal(big.data.base64, undefined);
  const au = await call("gbk_render_wav", { output: "audio", channels: 1, tailSeconds: 0.5 });
  assert.equal(au.content![0].type, "audio"); assert.equal(au.content![0].mimeType, "audio/wav");
  const text = toHostResult(au, ["text"]) as string;
  assert.equal(typeof text, "string"); assert.ok(!text.includes(au.content![0].data.slice(0, 64)), "audio never stringified into text");
  assert.match(text, /text only/); assert.equal(JSON.parse(text).data.output, "artifact");
  const rich = toHostResult(au, ["text", "audio"]) as { content: { type: string }[] };
  assert.deepEqual(rich.content.map((x) => x.type), ["text", "audio"]);
});

test("download only when asked; blocked download is reported, artifact survives", async () => {
  const { call, c, downloads } = await song(1);
  const r = await call("gbk_render_wav", { download: true });
  assert.equal(downloads.length, 1); assert.equal(r.data.downloaded.requested, true); assert.equal(r.data.downloaded.confirmed, false);
  c.host.download = () => false;
  const d = await call("gbk_download_render_artifact", { artifactId: r.data.artifactId });
  assert.equal(d.error!.code, "DOWNLOAD_BLOCKED");
  assert.ok((await artifactStore().meta(r.data.artifactId)).bytes > 0);
});

test("async job: waitSeconds 0 returns a real job id; status polling reaches completed; edits after submit don't change it", async () => {
  const { call, c, tid } = await song(2);
  const notes = c.project.notes.length;
  const r = await call("gbk_render_wav", { waitSeconds: 0 });
  assert.ok(r.ok); assert.notEqual(r.data.status, "completed"); assert.ok(r.data.jobId);
  await call("gbk_generate_part", { trackId: tid, range: { unit: "bars", start: 3, end: 6 }, kind: "melody", seed: 2 }); // edit during render
  let s: any;
  for (let i = 0; i < 200; i++) { s = await call("gbk_get_render_status", { jobId: r.data.jobId }); if (["completed", "failed"].includes(s.data.status)) break; await new Promise((res) => setTimeout(res, 50)); }
  assert.equal(s.data.status, "completed");
  assert.ok(Math.abs(s.data.durationSeconds - (4 + 3)) < 0.01, "snapshot: 2 bars + tail, not the edited 6 bars");
  assert.ok(c.project.notes.length > notes);
  const bad = await call("gbk_get_render_status", { jobId: "nope" });
  assert.equal(bad.ok, false);
});

test("empty project render fails with a structured error, never ok", async () => {
  const s = setup();
  await s.call("gbk_create_project", { name: "empty" });
  const r = await s.call("gbk_render_wav", {});
  assert.equal(r.ok, false); assert.equal(r.error!.code, "EMPTY_PROJECT");
});
