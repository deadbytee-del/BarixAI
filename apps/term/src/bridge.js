// Barix Bridge: a small LOCAL server that gives the browser app what a web page cannot have —
//   • the internet (any public site, search) through the SSRF-guarded Node fetcher
//   • your GitHub account (your `gh` login / GITHUB_TOKEN), read-only, with the token never leaving this machine
// Security model: listens on 127.0.0.1 only; every request needs the pairing token; only allow-listed web origins may call it (CORS +
// Private-Network-Access); GitHub is GET-only; web fetches refuse private/local addresses; responses are size- and time-limited.
import http from "node:http";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createNodeWeb } from "./web-node.js";

export const DEFAULT_PORT = 8799;
export const DEFAULT_ORIGINS = ["https://deadbytee-del.github.io"];
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o);
const GH_API = "https://api.github.com", GH_RAW = "https://raw.githubusercontent.com";
const PASS_HEADERS = ["etag", "link", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-limit", "content-type"];

export async function loadOrCreateToken(file = path.join(os.homedir(), ".barix", "bridge.json")) {
  try { const j = JSON.parse(await readFile(file, "utf8")); if (typeof j.token === "string" && j.token.length >= 16) return j.token; } catch { /* create */ }
  const token = "barix-" + crypto.randomBytes(9).toString("base64url"); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ token }), { mode: 0o600 }); try { await chmod(file, 0o600); } catch { /* windows */ }
  return token;
}

/**
 * llm: { baseUrl, model, window, name } of a local OpenAI-compatible server (Ollama / llama.cpp / LM Studio) to expose to the web app, or null.
 * @param {{token:string, port?:number, origins?:string[], githubToken?:()=>Promise<string|undefined>|string|undefined, web?:object, fetchImpl?:Function, ghApi?:string, ghRaw?:string, log?:Function, version?:string}} o
 */
export function createBridge({ token, port = DEFAULT_PORT, origins = DEFAULT_ORIGINS, githubToken = () => undefined, llm = null, web = createNodeWeb(), fetchImpl = (...a) => fetch(...a), ghApi = GH_API, ghRaw = GH_RAW, log = () => {}, version = "0.1.0" } = {}) {
  if (!token || token.length < 12) throw new Error("bridge needs a pairing token of at least 12 characters");
  const allowed = (o) => !!o && (origins.includes(o) || isLocalOrigin(o));
  const stats = { requests: 0, web: 0, github: 0, rejected: 0 }; const rate = new Map();
  const tokensEqual = (a) => { const x = Buffer.from(String(a ?? "")), y = Buffer.from(token); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const tooFast = (key, limit = 240, windowMs = 60_000) => { const now = Date.now(); const r = rate.get(key); if (!r || now - r.t > windowMs) { rate.set(key, { t: now, n: 1 }); return false; } return ++r.n > limit; };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin; const send = (code, body, extra = {}) => { const b = typeof body === "string" ? body : JSON.stringify(body); res.writeHead(code, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors, ...extra }); res.end(b); };
    const cors = allowed(origin) ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-private-network": "true", "access-control-expose-headers": PASS_HEADERS.join(", ") } : {};
    try {
      if (origin && !allowed(origin)) { stats.rejected++; return send(403, { error: "origin not allowed (start the bridge with --origin <url> to allow another web app)" }); }
      if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, x-barix-token, accept, if-none-match, x-github-api-version", "access-control-max-age": "600" }); return res.end(); }
      const url = new URL(req.url, "http://127.0.0.1"); stats.requests++;
      if (url.pathname === "/" ) return send(200, "Barix Bridge is running. Connect to it from the Barix web app (Settings → Barix Bridge).");
      const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || req.headers["x-barix-token"];
      if (!tokensEqual(given)) { stats.rejected++; return send(401, { error: "missing or wrong pairing token" }); }
      if (tooFast(origin ?? "local")) return send(429, { error: "too many requests" });

      if (url.pathname === "/v1/status") {
        let login = null; const gt = await githubToken(); if (gt) { try { const r = await fetchImpl(`${ghApi}/user`, { headers: { authorization: `Bearer ${gt}`, accept: "application/vnd.github+json", "user-agent": "BarixBridge" }, signal: AbortSignal.timeout(6000) }); if (r.ok) login = (await r.json()).login; } catch { /* offline */ } }
        return send(200, { name: "Barix Bridge", version, web: true, github: { available: !!gt, login }, llm: llm ? { name: llm.name, model: llm.model, window: llm.window } : null, stats });
      }
      if (url.pathname === "/v1/web/search" && req.method === "POST") { stats.web++; const b = await readJson(req); const q = String(b.query ?? "").slice(0, 300); if (q.length < 2) return send(400, { error: "query required" }); const results = await web.search(q, { max: Math.min(10, +b.max || 6) }); return send(200, { results, engine: results.engine }); }
      if (url.pathname === "/v1/web/fetch" && req.method === "POST") { stats.web++; const b = await readJson(req); try { return send(200, await web.fetchPage(String(b.url ?? ""), { maxChars: Math.min(40_000, +b.maxChars || 12_000) })); } catch (e) { return send(422, { error: e.message }); } }
      if (url.pathname === "/v1/llm/models" || url.pathname === "/v1/llm/chat/completions") { // local model server, streamed through (the upstream address is never exposed)
        if (!llm) return send(404, { error: "no local model server is configured on the bridge" });
        const isChat = url.pathname.endsWith("/chat/completions"); if (isChat && req.method !== "POST") return send(405, { error: "POST required" });
        const body = isChat ? await readRaw(req, 16_000_000) : undefined; const ac = new AbortController(); res.on("close", () => ac.abort());
        const up = await fetchImpl(`${llm.baseUrl.replace(/\/$/, "")}${isChat ? "/chat/completions" : "/models"}`, { method: isChat ? "POST" : "GET", headers: isChat ? { "content-type": "application/json" } : {}, body, signal: ac.signal });
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...cors });
        if (!up.body) return res.end(); return void Readable.fromWeb(up.body).on("error", () => res.end()).pipe(res);
      }
      const gh = url.pathname.startsWith("/gh/") ? ghApi + url.pathname.slice(3) : url.pathname.startsWith("/ghraw/") ? ghRaw + url.pathname.slice(6) : null;
      if (gh) { // read-only GitHub proxy: the real token is attached here, never sent to the page
        if (req.method !== "GET") { stats.rejected++; return send(405, { error: "the bridge's GitHub access is read-only (GET)" }); }
        stats.github++; const gt = await githubToken(); const isApi = url.pathname.startsWith("/gh/");
        const headers = { "user-agent": "BarixBridge", accept: req.headers.accept ?? "application/vnd.github+json", ...(isApi ? { "x-github-api-version": "2022-11-28" } : {}), ...(gt ? { authorization: `Bearer ${gt}` } : {}) }; if (req.headers["if-none-match"]) headers["if-none-match"] = req.headers["if-none-match"];
        const up = await fetchImpl(gh + url.search, { headers, signal: AbortSignal.timeout(30_000), redirect: "follow" });
        const buf = Buffer.from(await up.arrayBuffer()); if (buf.length > 25_000_000) return send(413, { error: "response too large" });
        const out = {}; for (const h of PASS_HEADERS) { const v = up.headers.get(h); if (v) out[h] = v; } if (out.link) out.link = out.link.replaceAll(ghApi, "");
        res.writeHead(up.status, { ...out, "cache-control": "no-store", ...cors }); return res.end(buf);
      }
      return send(404, { error: "not found" });
    } catch (e) { log(`bridge error: ${e.message}`); try { return send(500, { error: String(e.message).slice(0, 200) }); } catch { /* headers sent */ } }
  });
  async function readRaw(req, max) { let n = 0; const chunks = []; for await (const c of req) { n += c.length; if (n > max) throw new Error("request too large"); chunks.push(c); } return Buffer.concat(chunks); }
  async function readJson(req, max = 20_000) { let n = 0; const chunks = []; for await (const c of req) { n += c.length; if (n > max) throw new Error("request too large"); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw new Error("invalid JSON"); } }
  return {
    server, stats,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server.address().port)); }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
