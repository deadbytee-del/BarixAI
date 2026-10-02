// Brain worker: runs the whole Barix core off the UI thread — OPFS filesystem, indexing, retrieval, context
// engine, memory, agent loop, tools, verification. Inference lives in infer.worker.js (reached via MessagePort).
import { serve } from "./rpc.js";
import {
  createBarix, OPFSBackend, MemoryBackend, browserTreeSitter, browserCodec, RemoteWorker, messagePortTransport, GitHubClient, githubTools,
  OpenAICompatProvider, WorkerPool, connectWebSocket, isBinary, detectSecrets, HashEmbedder, webTools,
} from "@barix/core";
import { bridgeWeb, fallbackWeb } from "./web-access.js";
import { browserTools } from "./browser-tools.js";
import { buildPreviewDoc } from "./preview-doc.js";
import { hasBrowserTests } from "./browser-tools.js";

let ghToken = "", webImpl = fallbackWeb(), B = null, base = "./", abort = null, askSeq = 0, github = null, pool = null, inferPort = null;
const pendingCaps = new Map();
// Route GitHub + web access through the local Barix Bridge (or back to the direct/limited browser path). Mutates the live client so no restart is needed.
function applyBridge(b) {
  if (b?.url && b?.token) { const base = b.url.replace(/\/$/, ""); Object.assign(github, { apiBase: base + "/gh", rawBase: base + "/ghraw", token: () => b.token }); webImpl = bridgeWeb(b); }
  else { Object.assign(github, { apiBase: "https://api.github.com", rawBase: "https://raw.githubusercontent.com", token: () => ghToken || undefined }); webImpl = fallbackWeb(); }
  github.cache?.clear?.(); if (B) B.ctx.web = webImpl; return { web: webImpl.kind };
}
let emitRef = () => {};

async function makeRuntime() {
  return browserTreeSitter({ baseUrl: `${base}wasm/`, loadModule: () => import("@vscode/tree-sitter-wasm/wasm/tree-sitter.js") });
}
async function backendFor(project) {
  if (project.kind === "handle") return new OPFSBackend(project.handle);
  if (project.kind === "memory" || !navigator.storage?.getDirectory) return new MemoryBackend();
  return OPFSBackend.create(`barix-project-${project.id}`);
}
const provenance = (b) => b ? { files: b.fs.files().length, rev: b.fs.rev } : null;

const handlers = {
  async init({ project, inferPort: port, base: b, githubToken, endpoints = [], bridge = null }, { emit }) {
    emitRef = emit; base = b; B?.intel.dispose();
    ghToken = githubToken; github = new GitHubClient({ token: () => githubToken || undefined }); if (bridge) applyBridge(bridge);
    const providers = [];
    if (port) { inferPort = port; const w = await new RemoteWorker(messagePortTransport(port), { name: "barix-brain", timeoutMs: 20000 }).connect(); providers.push(w.provider({ kind: "browser-local", id: "browser-local" })); }
    for (const e of endpoints) providers.push(new OpenAICompatProvider({ baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey, window: e.window, vision: !!e.vision, kind: e.local ? "local-machine" : "public-inference", quality: e.quality ?? 0.6, id: e.id }));
    B = await createBarix({
      backend: await backendFor(project), runtime: await makeRuntime(), providers, tools: [...githubTools, ...webTools, ...browserTools], capabilities: { github: true, exec: true, web: true }, env: "browser", projectId: project.id,
      runners: { test: async () => hasBrowserTests(B.fs), build: async () => !["src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js", "src/index.ts", "src/index.js", "index.js", "main.js"].every((p) => !B.fs.exists(p)) },
      codec: browserCodec(), embedder: new HashEmbedder(),
      browser: { screenshot: async ({ target, width, height }) => screenshot(target, width, height) },
      extraCtx: { github, base, web: webImpl, sandbox: { run: (o) => sandboxRun(o) } },
    });
    pool = new WorkerPool(B.router);
    B.fs.on("change", (e) => emit("fs", e));
    emit("ready", { files: B.fs.files().length, health: B.intel.health(), providers: B.router.status() });
    return { files: B.fs.files(), health: B.intel.health() };
  },

  async ask({ id: askId, text, images = [], reasoning = "auto" }, { emit }) {
    if (!B) throw new Error("project not initialised");
    const id = askId ?? ++askSeq; abort = new AbortController();
    const imgs = images.map((i) => ({ bytes: new Uint8Array(i.bytes), name: i.name }));
    try {
      const r = await B.agent.run(text, { reasoning, images: imgs, signal: abort.signal, onEvent: (e) => emit("agent", { id, ...slim(e) }) });
      return { id, text: r.text, answer: r.answer, ok: r.ok, plan: r.plan, steps: r.steps, usage: r.usage, routes: r.routes, changedFiles: r.changedFiles, ms: r.ms, verification: { ok: r.verification.ok, verified: r.verification.verified.length, unverified: r.verification.unverified.map((c) => ({ type: c.type, path: c.path, reason: c.reason })), contradicted: r.verification.contradicted.map((c) => ({ type: c.type, path: c.path, reason: c.reason })) } };
    } catch (e) { if (e.name === "AbortError") return { id, aborted: true }; throw e; } finally { abort = null; }
  },
  cancel() { abort?.abort(); return true; },

  // ---- filesystem (the UI sees exactly the tree Barix reasons about) ----
  "fs.tree": () => B.fs.list("", { recursive: true }).map((e) => ({ path: e.path, type: e.type, size: e.size })),
  async "fs.read"({ path }) { const bytes = await B.fs.readBytes(path); if (isBinary(bytes)) return { binary: true, size: bytes.length, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; return { text: new TextDecoder().decode(bytes), size: bytes.length }; },
  async "fs.write"({ path, text, bytes }) { await B.fs.writeFile(path, bytes ? new Uint8Array(bytes) : text); await B.intel.sync(); return { size: (bytes?.byteLength ?? text.length) }; },
  async "fs.delete"({ path, dir }) { dir ? await B.fs.deleteDir(path, { recursive: true }) : await B.fs.deleteFile(path); return true; },
  async "fs.move"({ from, to }) { await B.fs.move(from, to); return true; },
  async "fs.mkdir"({ path }) { await B.fs.mkdir(path); return true; },
  async "fs.import"({ files }, { emit }) {
    let n = 0; for (const f of files) { await B.fs.writeFile(f.path, new Uint8Array(f.bytes)); if (++n % 20 === 0) emit("import-progress", { done: n, total: files.length }); }
    await B.intel.indexAll(); const prof = await B.intel.getProfile(); await B.memory.setProjectProfile(prof, { importantFiles: await B.intel.importantFiles() }); return { imported: n, summary: prof.summary };
  },
  async "fs.export"() { const out = []; for (const p of B.fs.files()) out.push({ path: p, bytes: (await B.fs.readBytes(p)).slice().buffer }); return { files: out }; },
  "fs.history": ({ path }) => B.fs.history(path),
  async "fs.restore"({ path, version }) { await B.fs.restore(path, version); await B.intel.sync(); return true; },
  async "fs.audit"() { return B.fs.audit(); },
  async "project.search"({ query }) { const r = await B.intel.retrieve(query, { budgetTokens: 3000, k: 8 }); return r.items.map((i) => ({ path: i.path, startLine: i.startLine, endLine: i.endLine, reason: i.reason, preview: i.text.split("\n").slice(0, 6).join("\n") })); },
  async "project.profile"() { return B.intel.getProfile(); },
  async "project.secrets"() { const hits = []; for (const p of B.fs.files()) { const t = await B.fs.readFile(p).catch(() => null); if (t) for (const s of detectSecrets(t)) hits.push({ path: p, ...s }); } return hits; },

  // ---- status / memory ----
  status() {
    const rt = B.intel.symbols.runtime; return { parsers: { loaded: rt ? [...rt.parsers.keys()] : [], failed: rt ? [...rt.failed] : [], error: rt?.lastError ? String(rt.lastError.message ?? rt.lastError) : null }, store: B.store.stats(), health: B.intel.health(), providers: B.router.status(), capacity: B.router.capacity(), workers: pool?.list() ?? [], prefix: B.engine.history, task: B.memory.task, evidence: B.ledger.records.slice(-30).map((r) => ({ id: r.id, kind: r.kind, tool: r.tool, ok: r.ok, data: r.data })) };
  },
  "memory.list": () => ({ longTerm: B.memory.list("long-term"), project: B.memory.list("project"), task: B.memory.task }),
  "memory.forget": ({ id }) => B.memory.forget(id),
  async "memory.remember"({ text }) { return B.memory.remember(text, { force: true, source: "user-ui" }); },
  async "context.compact"() { return B.compactor.compact(0); },
  "usage.summary": () => B.usage.summary(),

  // ---- providers / peers ----
  "github.token": ({ token }) => { ghToken = token; if (webImpl.kind !== "bridge") github.token = () => token || undefined; return { authenticated: !!token }; },
  "bridge.set": (b) => applyBridge(b),
  async "github.import"({ repo, ref, path }) { const { parseGitHubUrl } = await import("@barix/core"); const p = parseGitHubUrl(repo); if (!p) throw new Error("not a GitHub repository URL"); const r = await github.importRepo(B.fs, { owner: p.owner, repo: p.repo, ref: ref ?? p.ref, path: path ?? p.path, prefix: "" }); await B.intel.indexAll(); return r; },
  async "provider.addEndpoint"(e) { const p = new OpenAICompatProvider({ baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey, window: e.window, vision: !!e.vision, kind: e.local ? "local-machine" : "public-inference", quality: e.quality ?? 0.6, id: e.id }); B.router.register(p, e.limits ? { limits: e.limits } : undefined); return B.router.status(); },
  "provider.remove": ({ id }) => { B.router.unregister(id); return B.router.status(); },
  async "peer.attach"({ port, name, token }) { const r = await pool.add(messagePortTransport(port, name ?? "peer"), { name: "barix-browser", token }); return { id: r.id, advert: r.worker.advert }; },
  async "peer.connectWebSocket"({ url, token }) { const r = await pool.add(connectWebSocket(url, { label: url }), { name: "barix-browser", token }); return { id: r.id, advert: r.worker.advert }; },
  "peer.remove": ({ id }) => { pool.remove(id); return pool.list(); },
  "peer.list": () => pool?.list() ?? [],
  "router.setStrategy": ({ strategy }) => { B.router.strategy = strategy; return true; },
  "router.enable": ({ id, enabled }) => { B.router.setEnabled(id, enabled); return B.router.status(); },

  // ---- capability round-trip: page renders HTML to PNG for us ----
  "cap.result": ({ id, bytes, result, error }) => { const p = pendingCaps.get(id); if (!p) return false; pendingCaps.delete(id); error ? p.rej(new Error(error)) : p.res(result ?? new Uint8Array(bytes)); return true; },
};

function sandboxRun({ code, timeoutMs = 20000 }) {
  const id = `cap${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((res, rej) => { pendingCaps.set(id, { res: (r) => res(r), rej }); setTimeout(() => { if (pendingCaps.delete(id)) rej(new Error("sandbox did not respond")); }, timeoutMs + 5000); emitRef("cap:run", { id, code, timeoutMs }); });
}
async function screenshot(target, width = 1280, height = 800) {
  if (/^https?:/i.test(target)) throw new Error("the browser preview can only render project files (not remote URLs)");
  const html = await buildPreviewDoc(B.fs, target); const id = `cap${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((res, rej) => { pendingCaps.set(id, { res, rej }); setTimeout(() => { if (pendingCaps.delete(id)) rej(new Error("preview timed out")); }, 30000); emitRef("cap:screenshot", { id, html, width, height }); });
}
const slim = (e) => { const { ts, ...r } = e; if (r.type === "context") return { type: "context", step: r.step, report: { promptTokens: r.report.promptTokens, window: r.report.window, sections: r.report.sections, retrieved: r.report.retrieved, prefixReuse: r.report.prefixReuse, buildMs: r.report.buildMs, compaction: r.report.compaction && { compacted: r.report.compaction.compacted, ratio: r.report.compaction.ratio } } }; if (r.type === "done") return { type: "done" }; if (r.type === "tool-start" || r.type === "tool-end") return { type: r.type, tool: r.call?.tool }; return r; };

serve(self, handlers, { onError: (e) => console.error("[brain]", e) });
