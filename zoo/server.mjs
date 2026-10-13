// Tiny static server for the jank zoo, with a slow save endpoint and an items endpoint.
// Usage: node zoo/server.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const types = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png",
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function startZoo(port = 4173, dir = root) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/save") {
      await wait(300);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (url.pathname === "/api/items") {
      await wait(250);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(["Invoice 1042", "Invoice 1043", "Invoice 1044"]));
    }
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    if (path.includes("..")) { res.writeHead(400); return res.end(); }
    // the report typeface lives with the package's other assets
    const file = path.startsWith("/fonts/") ? join(dir, "..", "assets", path) : join(dir, path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
  startZoo(port).then(() => console.log(`Jank zoo on http://localhost:${port}`));
}
