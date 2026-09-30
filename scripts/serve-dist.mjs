// Minimal static server for E2E runs against the production build.
//
// Serves dist/ at the server root: /gbk/ -> dist/index.html (the app's Vite
// base), while /omr-models/ and /ort-runtime/ resolve at the root exactly
// like the app requests them (absolute paths, mirroring production).
// Usage: node scripts/serve-dist.mjs [port]   (default 4173)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.argv[2] || 4173);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
    if (p.startsWith("/gbk/")) p = p.slice(4) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(p)] || "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving dist/ on 127.0.0.1:${port}`));
