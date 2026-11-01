#!/usr/bin/env node
// Test stand-in for ffmpeg: copies the checked-in tiny.mp4 to the output path (last arg) and logs each call.
import { appendFileSync, copyFileSync } from "node:fs";
const out = process.argv.at(-1);
if (process.env.FAKE_FFMPEG_LOG) appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
if (process.env.FAKE_FFMPEG_FAIL) process.exit(1);
setTimeout(() => copyFileSync(new URL("./tiny.mp4", import.meta.url), out), 50);
