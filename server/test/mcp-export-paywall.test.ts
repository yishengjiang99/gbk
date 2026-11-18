// ChatGPT / MCP exports are Pro only: tool results must not hand a free user a MIDI or WAV download URL;
// they get the same 402 body (pricing_url included) instead. Playing and listening stay free.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { IapStore } from "../src/persistence/iap.ts";
import { presentArtifact, withExportGate, exportPaywall, exportUpgradeMessage } from "../src/mcp/export-gate.ts";
import type { ArtifactRow } from "../src/mcp/store.ts";
import { composerUiHtml } from "../src/mcp/ui.ts";

const model = () => new ScriptModel([() => reply("x")]);
const MIDI = Buffer.from("MThd\u0000\u0000\u0000\u0006\u0000\u0000\u0000\u0001\u0001\u00e0");
const row = (over: Partial<ArtifactRow> & { id: string; kind: "wav" | "midi" }): ArtifactRow => ({
  job_id: null, composition_id: "cmp_x", owner: "u", revision: 1, filename: over.kind === "wav" ? "s.wav" : "s.mid",
  mime_type: over.kind === "wav" ? "audio/wav" : "audio/midi", size_bytes: 1, sha256: "x", rel_path: over.id, meta_json: "{}", created_at: 1, ...over,
});

test("presentArtifact / withExportGate: Pro gets a signed download URL; free gets the 402 body and no link; playUrl is WAV-only", () => {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test" });
  const wav = row({ id: "art_w", kind: "wav" }); const mid = row({ id: "art_m", kind: "midi" });
  const proWav = presentArtifact(cfg, wav, { pro: true });
  assert.match(proWav.downloadUrl ?? "", /\/api\/mcp\/artifacts\/art_w\?exp=\d+&sig=/);
  assert.ok(proWav.downloadUrlExpiresAt);
  assert.equal((proWav as { playUrl?: string }).playUrl, undefined);
  const freeWav = presentArtifact(cfg, wav, { pro: false });
  assert.equal((freeWav as { downloadUrl?: string }).downloadUrl, undefined);
  assert.equal((freeWav as { playUrl?: string }).playUrl, undefined);
  const play = presentArtifact(cfg, wav, { pro: false, play: true });
  assert.match(play.playUrl ?? "", /\/api\/mcp\/artifacts\/art_w\?/);
  assert.equal((play as { downloadUrl?: string }).downloadUrl, undefined);
  assert.equal((presentArtifact(cfg, mid, { pro: false, play: true }) as { playUrl?: string }).playUrl, undefined, "MIDI is never a play URL");
  const gated = withExportGate(cfg.publicOrigin, "guest:abc", false, { compositionId: "cmp_x" });
  assert.equal(gated.canExport, false);
  assert.deepEqual(gated.export, exportPaywall("http://composer.test", false));
  assert.equal(gated.export?.code, "PRO_REQUIRED"); assert.equal(gated.export?.reason, "export");
  assert.equal(gated.export?.signed_in, false);
  assert.equal(gated.export?.paywall.pricing_url, "http://composer.test/pricing?plan=pro_yearly&reason=export");
  assert.match(exportUpgradeMessage("http://composer.test", true), /pricing\?plan=pro_yearly&reason=export/);
  assert.deepEqual(withExportGate(cfg.publicOrigin, "acct", true, { compositionId: "cmp_x" }), { compositionId: "cmp_x", canExport: true });
});

test("in-chat player HTML: download buttons are Pro-gated; playback uses playUrl; upgrade points at pricing_url", () => {
  const html = composerUiHtml("http://composer.test");
  assert.match(html, /id="dlUpgrade"[^>]*>Downloads are Pro</);
  assert.match(html, /function canExport\(d\)\{ return !!\(d&&d.canExport\); \}/);
  assert.match(html, /art\.wav\.playUrl\|\|art\.wav\.downloadUrl/);
  assert.match(html, /d\.export\.paywall\.pricing_url/);
  assert.match(html, /els\.upgrade\.setAttribute\("href",url\)/);
});

test("gbk_get_artifacts and gbk_show_composition_ui: non-Pro gets the 402 upgrade message, Pro gets the download URL", { timeout: 60_000 }, async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const freeAcc = s.accounts.upsertOAuth("google", "g-mcp-free", "g-mcp-free", "mcp-free@example.com").account;
    const proAcc = s.accounts.upsertOAuth("google", "g-mcp-pro", "g-mcp-pro", "mcp-pro@example.com").account;
    new IapStore(s.shares.database).upsert({ original_tx: "orig-mcp-pro", last_tx: "tx-mcp-pro", user: proAcc.id, app_token: null,
      product_id: "com.grepawk.moviefone.pro_lifetime", environment: "Production", expires_at: null, revoked_at: null });
    const asUser = (id: string) => new McpClient(s.base, { "x-gbk-test-user": id });
    const seed = async (owner: string) => {
      const mcp = asUser(owner); await mcp.initialize();
      const c = await mcp.call<{ compositionId: string }>("gbk_create_composition", { title: "Export gate", style: "classical", bars: 2, seed: 2 });
      const add = (kind: "midi" | "wav", filename: string, mime: string) => {
        const art = s.mcp.store.addArtifact({ job_id: null, composition_id: c.compositionId, owner, revision: 1, kind, filename, mime_type: mime,
          size_bytes: MIDI.length, sha256: "x", rel_path: `${owner}-${filename}`, meta_json: kind === "wav" ? JSON.stringify({ sampleRate: 44100, channels: 2, durationSeconds: 1 }) : "{}" });
        const path = s.mcp.store.artifactAbsPath(art); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, MIDI);
        return art;
      };
      add("midi", "song.mid", "audio/midi"); add("wav", "song.wav", "audio/wav");
      return { mcp, compositionId: c.compositionId };
    };
    const free = await seed(freeAcc.id); const pro = await seed(proAcc.id);

    const freeArts = await free.mcp.call<{ canExport: boolean; message: string; export: { code: string; reason: string; signed_in: boolean; paywall: { reason: string; hard: boolean; default_plan: string; trial_days: number; pricing_url: string } }; latest: { wav: { downloadUrl?: string; playUrl?: string; artifactId: string }; midi: { downloadUrl?: string } } }>("gbk_get_artifacts", { compositionId: free.compositionId });
    assert.equal(freeArts.canExport, false);
    assert.equal(freeArts.latest.wav.downloadUrl, undefined);
    assert.equal(freeArts.latest.midi.downloadUrl, undefined);
    assert.equal(freeArts.latest.wav.playUrl, undefined, "get_artifacts does not leak a stream URL to the model");
    assert.equal(freeArts.export.code, "PRO_REQUIRED"); assert.equal(freeArts.export.reason, "export");
    assert.equal(freeArts.export.signed_in, true);
    assert.deepEqual(freeArts.export.paywall, { reason: "export", hard: true, default_plan: "pro_yearly", trial_days: 7, pricing_url: "http://composer.test/pricing?plan=pro_yearly&reason=export" });
    assert.match(freeArts.message, /http:\/\/composer\.test\/pricing\?plan=pro_yearly&reason=export/);
    assert.ok(!JSON.stringify(freeArts).includes("/api/mcp/artifacts/"), "free get_artifacts result contains no artifact URL");

    const proArts = await pro.mcp.call<{ canExport: boolean; export?: unknown; latest: { wav: { downloadUrl: string }; midi: { downloadUrl: string } } }>("gbk_get_artifacts", { compositionId: pro.compositionId });
    assert.equal(proArts.canExport, true); assert.equal(proArts.export, undefined);
    assert.match(proArts.latest.wav.downloadUrl, /\/api\/mcp\/artifacts\//);
    assert.match(proArts.latest.midi.downloadUrl, /\/api\/mcp\/artifacts\//);
    const proUrl = new URL(proArts.latest.midi.downloadUrl);
    const dl = await fetch(`${s.base}${proUrl.pathname}${proUrl.search}&download=1`, { headers: { "x-gbk-test-user": proAcc.id } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment;/);

    const ui = await free.mcp.call<{ canExport: boolean; export: { code: string; paywall: { pricing_url: string } }; artifacts: { wav: { playUrl?: string; downloadUrl?: string; durationSeconds: number }; midi: { downloadUrl?: string } } }>("gbk_show_composition_ui", { compositionId: free.compositionId });
    assert.equal(ui.canExport, false);
    assert.equal(ui.export.code, "PRO_REQUIRED");
    assert.equal(ui.artifacts.wav.downloadUrl, undefined);
    assert.equal(ui.artifacts.midi.downloadUrl, undefined);
    assert.match(ui.artifacts.wav.playUrl ?? "", /\/api\/mcp\/artifacts\//, "the widget can still stream the WAV");
    const play = await fetch(ui.artifacts.wav.playUrl!.replace("http://composer.test", s.base));
    assert.equal(play.status, 200);
    assert.match(play.headers.get("content-disposition") ?? "", /^inline/);
    const blocked = await fetch(`${s.base}/api/mcp/artifacts/${freeArts.latest.wav.artifactId}?download=1`, { headers: { "x-gbk-test-user": freeAcc.id } });
    assert.equal(blocked.status, 402);

    const proUi = await pro.mcp.call<{ canExport: boolean; artifacts: { wav: { downloadUrl: string; playUrl?: string }; midi: { downloadUrl: string } } }>("gbk_show_composition_ui", { compositionId: pro.compositionId });
    assert.equal(proUi.canExport, true);
    assert.match(proUi.artifacts.wav.downloadUrl, /\/api\/mcp\/artifacts\//);
    assert.match(proUi.artifacts.midi.downloadUrl, /\/api\/mcp\/artifacts\//);
    assert.equal(proUi.artifacts.wav.playUrl, undefined, "Pro widgets use downloadUrl for both play and save");
  } finally { await s.app.close(); }
});
