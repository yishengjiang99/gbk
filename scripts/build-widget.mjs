// Bundles the in-chat player renderer (src/widget/widget-render.ts) and the SF2 AudioWorklet (src/sf2-processor.ts)
// into server/dist/widget/, served by the GBK server at /api/mcp/widget/* with CORS for the ChatGPT widget sandbox.
//   node scripts/build-widget.mjs [outDir]
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "server", "dist", "widget");
let release = process.env.GBK_RELEASE_ID;
if (!release) { try { release = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); } catch { release = "dev"; } }
// offline-context.ts lazily imports the Vite "?worker&url" asset; the widget sets __gbkSf2WorkletUrl instead.
const viteQueryStub = { name: "vite-query-stub", setup(b) {
  b.onResolve({ filter: /\?worker&url$/ }, (a) => ({ path: a.path, namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default '';", loader: "js" }));
} };
const common = { bundle: true, minify: true, target: ["es2020"], define: { __GBK_RELEASE__: JSON.stringify(release) }, logLevel: "warning", legalComments: "none" };
await build({ ...common, entryPoints: [join(root, "src/widget/widget-render.ts")], format: "iife", outfile: join(out, "gbk-widget-render.js"), plugins: [viteQueryStub] });
await build({ ...common, entryPoints: [join(root, "src/sf2-processor.ts")], format: "esm", outfile: join(out, "sf2-processor.js") });
console.log(`widget bundle -> ${out} (${release})`);
