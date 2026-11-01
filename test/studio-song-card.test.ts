// Card mapping: a finished compose/render tool result in the studio chat -> what the chat shows (text + song card).
// Pure logic only: no ffmpeg, no audio; the "render" is a stubbed artifact ref like the server sends.
import test from "node:test";
import assert from "node:assert/strict";
import { WorkstationController } from "../src/workstation/controller.ts";
import { VersionLog, latestArtifactItemId, publishedFeedPath, songCardFor, stripArtifactIds, type SongCardItem } from "../src/components/studio/studio-logic.ts";
import { parseRoute } from "../src/agent/routes.ts";

const wav = (id: string) => ({ artifactId: id, kind: "wav" as const });
const reply = (id: string, text: string, o: Partial<SongCardItem> = {}): SongCardItem => ({ id, role: "assistant", text, ...o });
const song = () => { const c = new WorkstationController(); c.edit([{ op: "addTrack", id: "t1", name: "Piano", channel: 0 }, { op: "addNotes", notes: [{ trackId: "t1", channel: 0, tick: 0, duration: 96, pitch: 60, velocity: 90 }] }]); return c; };

test("stripArtifactIds removes raw ids and their byte/hash noise, keeps the sentence", () => {
  assert.equal(stripArtifactIds("Done! WAV artifact **wav_mvwujpwp85on5h** is ready.", ["wav_mvwujpwp85on5h"]), "Done! The WAV is ready.");
  const fugue = 'Composed "Fugue in D minor": 4 voices. Rendered WAV artifact wav_ab12cd34ef (12.5 s, 2205044 bytes, sha256 0123456789ab).';
  const out = stripArtifactIds(fugue);
  assert.doesNotMatch(out, /wav_|bytes|sha256|artifact/i);
  assert.equal(out, 'Composed "Fugue in D minor": 4 voices.');
  assert.equal(stripArtifactIds("I rendered a WAV artifact wav_ab12cd34ef for you"), "I rendered the WAV for you");
  assert.equal(stripArtifactIds("Here's your song. WAV artifact **wav_bbbbbbbb22**"), "Here's your song.");
  assert.equal(stripArtifactIds("Here is `midi_9x8y7z6w5v` too"), "Here is too");
  assert.equal(stripArtifactIds("No ids here."), "No ids here.");
});

test("a run that made a version maps to that version's card; the text never shows the id", () => {
  const c = song(); const log = new VersionLog(); const v = log.record("r1", c.project)!;
  const m = reply("a1", "Rendered WAV artifact **wav_mvwujpwp85on5h**", { runId: "r1", artifacts: [wav("wav_mvwujpwp85on5h")] });
  const r = songCardFor(m, { version: log.forRun(c.project.id, "r1"), hasSong: true, latestArtifactId: latestArtifactItemId([m]), enabled: true });
  assert.deepEqual(r.card, { kind: "version", version: v });
  assert.doesNotMatch(r.text, /wav_/);
  assert.ok(r.text.length > 0);
});

test("a render with no recorded version (e.g. restored history) shows the current song's card, only on the newest render", () => {
  const older = reply("h1", "First take: WAV artifact wav_aaaaaaaa11", { artifacts: [wav("wav_aaaaaaaa11")] });
  const newer = reply("h3", "WAV artifact **wav_bbbbbbbb22**", { artifacts: [wav("wav_bbbbbbbb22")] });
  const items = [older, { id: "u2", role: "user" as const, text: "again" }, newer];
  const latest = latestArtifactItemId(items); assert.equal(latest, "h3");
  const o = { version: null, hasSong: true, latestArtifactId: latest, enabled: true };
  assert.equal(songCardFor(older, o).card, null, "older render: text only, no duplicate card");
  assert.doesNotMatch(songCardFor(older, o).text, /wav_/);
  const r = songCardFor(newer, o);
  assert.deepEqual(r.card, { kind: "current" });
  assert.equal(r.text, "Your song is ready.", "an id-only reply becomes a short line, never the id");
});

test("no song yet / plain chat replies / user and error items: no card", () => {
  const m = reply("a1", "WAV artifact wav_cccccccc33", { artifacts: [wav("wav_cccccccc33")] });
  assert.equal(songCardFor(m, { version: null, hasSong: false, latestArtifactId: "a1", enabled: true }).card, null);
  assert.equal(songCardFor(reply("a2", "Sure, which key?"), { version: null, hasSong: true, latestArtifactId: null, enabled: true }).card, null);
  assert.equal(songCardFor({ id: "u", role: "user", text: "wav_dddddddd44" }, { version: null, hasSong: true, latestArtifactId: null, enabled: true }).text, "wav_dddddddd44");
});

test("STUDIO_SONG_CARD=0 (enabled: false) restores the old behaviour", () => {
  const c = song(); const log = new VersionLog(); const v = log.record("r1", c.project)!;
  const text = "WAV artifact **wav_eeeeeeee55**";
  const m = reply("a1", text, { runId: "r1", artifacts: [wav("wav_eeeeeeee55")] });
  assert.deepEqual(songCardFor(m, { version: v, hasSong: true, latestArtifactId: "a1", enabled: false }), { card: { kind: "version", version: v }, text });
  assert.deepEqual(songCardFor(reply("a2", text, { artifacts: [wav("wav_eeeeeeee55")] }), { version: null, hasSong: true, latestArtifactId: "a2", enabled: false }), { card: null, text });
});

test("Publish lands on /feed?pin=<slug>, which pins that song first; bad slugs are ignored", () => {
  assert.equal(publishedFeedPath("my-song-ab12"), "feed?pin=my-song-ab12");
  assert.deepEqual(parseRoute("/feed", "?pin=my-song-ab12"), { view: "feed", sort: undefined, label: undefined, focus: "my-song-ab12" });
  assert.equal((parseRoute("/feed", "?pin=../x") as { focus?: string }).focus, undefined);
  assert.equal((parseRoute("/feed", "") as { focus?: string }).focus, undefined, "no pin: normal ranking");
});
