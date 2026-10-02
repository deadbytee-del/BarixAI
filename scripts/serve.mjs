// Static file server for apps/web/dist, mountable under a sub-path to mimic GitHub Pages project sites.
// usage: node scripts/serve.mjs [--port 8080] [--base /BarixAI/] [--dir apps/web/dist]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".map": "application/json", ".png": "image/png" };
export function serve({ dir, base = "/", port = 0, headers = {} }) {
  base = base.endsWith("/") ? base : base + "/";
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (!p.startsWith(base)) { if (p === base.slice(0, -1)) { res.writeHead(301, { location: base }); return res.end(); } res.writeHead(404); return res.end("not under base"); }
      p = p.slice(base.length) || "index.html"; let f = path.join(dir, p); if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
      let s = await stat(f).catch(() => null); if (s?.isDirectory()) { f = path.join(f, "index.html"); s = await stat(f).catch(() => null); }
      if (!s) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("404 " + p); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream", "content-length": s.size, "cache-control": "no-cache", ...headers }); res.end(await readFile(f));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}${base}`, close: () => new Promise((c) => server.close(c)) })));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const s = await serve({ dir: path.resolve(get("--dir", "apps/web/dist")), base: get("--base", "/"), port: +get("--port", 8080) }); console.log("serving", s.url);
}
