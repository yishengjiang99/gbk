// WebKit bug 302253: Safari's AAC AudioEncoder returns an esds body as "description" -> silent MP4 on iPhone.
import test from "node:test";
import assert from "node:assert/strict";
import { aacLcAsc, fixAacMeta } from "../src/video/export-video.ts";

test("AAC-LC ASC for 48 kHz stereo is 0x11 0x90", () => assert.deepEqual([...aacLcAsc(48000, 2)], [0x11, 0x90]));
test("WebKit esds-shaped description is replaced with a real ASC", () => {
  const webkit = new Uint8Array([3, 128, 128, 128, 34, 0, 0, 0, 4, 128, 128, 128, 20, 64, 20, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 128, 128, 128, 2, 17, 136, 6, 128, 128, 128, 1, 2]);
  const r = fixAacMeta({ decoderConfig: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 1, description: webkit } }, 48000, 1);
  assert.equal(r.replaced, true); assert.deepEqual([...(r.meta!.decoderConfig!.description as Uint8Array)], [0x11, 0x88]);
});
test("a correct (Chrome) ASC is kept", () => {
  const r = fixAacMeta({ decoderConfig: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) } }, 48000, 2);
  assert.equal(r.replaced, false);
});
