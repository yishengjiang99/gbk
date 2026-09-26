/* Build the isolated browser demo bundles. */
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;

await build({
  entryPoints: [root + "src/worker.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: root + "demo/dist/worker.bundle.js",
  logLevel: "info",
});

await build({
  entryPoints: [root + "demo/demo.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: root + "demo/dist/demo.bundle.js",
  logLevel: "info",
});
