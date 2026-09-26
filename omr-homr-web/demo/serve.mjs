/* Minimal static server for the isolated browser demo. Serves the package
 * root so /demo, /models, /fixtures and /node_modules/onnxruntime-web/dist
 * are all reachable. No COOP/COEP (single-thread WASM fallback). */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.DEMO_PORT ?? 8901);

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".csv": "text/csv",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = normalize(url.pathname).replace(/^\/+/, "");
    if (path === "" || path.endsWith("/")) path += "index.html";
    if (path.includes("..")) throw new Error("bad path");
    const file = join(root, path);
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(port, () => console.log(`demo server on http://localhost:${port}/demo/`));
