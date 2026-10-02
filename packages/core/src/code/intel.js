// ProjectIntelligence: the Barix code-understanding service for one project.
// Subscribes to BarixFS change events, so the symbol index and retrieval index are updated
// incrementally (only changed files are re-parsed/re-embedded) and `sync()` guarantees freshness
// before every retrieval. Retrieval is hybrid (lexical + semantic + symbol) with import-graph expansion.
import { HybridIndex } from "../retrieval/hybrid.js";
import { HashEmbedder } from "../retrieval/embeddings.js";
import { SymbolIndex, splitIdent } from "./symbol-index.js";
import { chunkFile } from "./chunker.js";
import { analyzeProject } from "./analyzer.js";
import { languageFor } from "./languages.js";
import { isBinary } from "../fs/barixfs.js";
import { hash53 } from "../util/hash.js";
import { basename } from "../util/misc.js";

const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock)$|\.min\.(js|css)$|\.map$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|wasm|onnx|bin|gguf|safetensors)$/i;
const MAX_FILE_BYTES = 1_000_000;

export class ProjectIntelligence {
  /** @param {{fs:import("../fs/barixfs.js").BarixFS, runtime?:any, embedder?:any, counter:any, chunkTokens?:number}} o */
  constructor({ fs, runtime = null, embedder = new HashEmbedder(), counter, chunkTokens = 400 }) {
    this.fs = fs; this.counter = counter; this.chunkTokens = chunkTokens;
    this.symbols = new SymbolIndex({ runtime }); this.search = new HybridIndex({ embedder });
    this.chunksByPath = new Map(); this.fileHash = new Map(); this.dirty = new Set(); this.removed = new Set();
    this.profile = null; this.stats = { indexed: 0, skipped: 0, removed: 0, indexMs: 0 };
    this._off = fs.on("change", (e) => this.#onChange(e)); this._syncing = null;
  }
  dispose() { this._off?.(); }
  #indexable(p) { return !SKIP.test(p) && !!languageFor(p) || /\.(md|txt|json|ya?ml|toml|html|css)$/i.test(p) && !SKIP.test(p); }
  #onChange(e) {
    if (e.kind === "mkdir" || e.kind === "rmdir") return;
    if (e.kind === "delete") { this.removed.add(e.path); this.dirty.delete(e.path); }
    else if (e.kind === "rename") { this.removed.add(e.from); this.dirty.add(e.path); for (const p of this.fs.files()) if (p.startsWith(e.path + "/")) this.dirty.add(p); }
    else { this.dirty.add(e.path); this.removed.delete(e.path); }
    this.profile = null;
  }
  /** Index every file (initial) — unchanged files are skipped by content hash. */
  async indexAll({ onProgress, concurrency = 8 } = {}) {
    for (const p of this.fs.files()) if (this.#indexable(p)) this.dirty.add(p);
    return this.sync({ onProgress, concurrency });
  }
  /** Bring indexes up to date with the filesystem. Safe to call concurrently. */
  async sync({ onProgress, concurrency = 8, embed = true } = {}) {
    if (this._syncing) await this._syncing;
    if (!this.dirty.size && !this.removed.size) return { changed: 0 };
    this._syncing = this.#run({ onProgress, concurrency, embed }).finally(() => { this._syncing = null; });
    return this._syncing;
  }
  async #run({ onProgress, concurrency, embed }) {
    const t0 = performance.now();
    for (const p of this.removed) { this.#drop(p); this.stats.removed++; } this.removed.clear();
    const todo = [...this.dirty].filter((p) => this.#indexable(p)); this.dirty.clear();
    let done = 0, changed = 0;
    const worker = async () => {
      while (todo.length) {
        const p = todo.pop(); const st = this.fs.statSync(p);
        if (!st || st.type !== "file" || st.size > MAX_FILE_BYTES) { this.#drop(p); continue; }
        let bytes; try { bytes = await this.fs.readBytes(p); } catch { this.#drop(p); continue; }
        if (isBinary(bytes)) { this.#drop(p); continue; }
        const text = new TextDecoder().decode(bytes), h = hash53(text);
        if (this.fileHash.get(p) === h) { this.stats.skipped++; done++; continue; }
        await this.#indexFile(p, text); this.fileHash.set(p, h); changed++; done++; this.stats.indexed++;
        onProgress?.({ done, remaining: todo.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));
    if (embed) await this.search.flush();
    this.stats.indexMs += performance.now() - t0; return { changed, ms: performance.now() - t0 };
  }
  async #indexFile(path, text) {
    await this.symbols.updateFile(path, text);
    const syms = this.symbols.outline(path);
    for (const c of this.chunksByPath.get(path) ?? []) this.search.remove(c.id);
    const chunks = chunkFile(path, text, { symbols: syms, counter: this.counter, maxTokens: this.chunkTokens });
    this.chunksByPath.set(path, chunks.map((c) => ({ id: c.id, start: c.startLine, end: c.endLine })));
    for (const c of chunks) this.search.add({ id: c.id, text: c.text, header: c.header, names: c.names, meta: { path, startLine: c.startLine, endLine: c.endLine, tokens: c.tokens, language: c.language, kind: "code" } });
  }
  #drop(path) {
    for (const c of this.chunksByPath.get(path) ?? []) this.search.remove(c.id);
    this.chunksByPath.delete(path); this.fileHash.delete(path); this.symbols.removeFile(path);
  }

  async getProfile() { return (this.profile ??= await analyzeProject(this.fs)); }

  /** Chunk that contains a given symbol (for symbol -> chunk boosting). */
  #chunkAt(path, line) { return (this.chunksByPath.get(path) ?? []).find((c) => c.start <= line && c.end >= line)?.id; }

  /**
   * Retrieve the most useful code for a task within a token budget.
   * @returns {Promise<{items:object[], tokens:number, considered:number, mentioned:string[]}>}
   */
  async retrieve(query, { budgetTokens = 4000, k = 12, mentionedFiles = [], exclude = new Set(), expandGraph = true } = {}) {
    await this.sync();
    const mentioned = this.#resolveMentions(query, mentionedFiles);
    const idents = [...new Set(query.match(/[A-Za-z_$][\w$]{3,}/g) ?? [])];
    const symbolHits = new Map(), reasons = new Map();
    const why = (id, r) => { const a = reasons.get(id) ?? reasons.set(id, []).get(id); if (!a.includes(r)) a.push(r); };
    for (const id of idents) for (const s of this.symbols.find(id, { limit: 6 })) {
      if (s.score < 70 && !/[a-z][A-Z]|_/.test(id)) continue; // plain words only count on strong matches
      const cid = this.#chunkAt(s.path, s.startLine); if (!cid) continue;
      symbolHits.set(cid, Math.max(symbolHits.get(cid) ?? 0, s.score)); why(cid, `defines ${s.kind} ${s.name}`);
    }
    const hits = await this.search.search(query, { k: k * 2, symbolHits, filter: (id, m) => m?.kind === "code" && !exclude.has(id) });
    const items = []; const seen = new Set(); let tokens = 0;
    const take = async (id, meta, reason, score) => {
      if (seen.has(id) || exclude.has(id)) return false; const t = meta.tokens ?? 200;
      if (tokens + t > budgetTokens) return false;
      const text = await this.fs.readFile(meta.path, { startLine: meta.startLine, endLine: meta.endLine });
      seen.add(id); tokens += t; items.push({ id, path: meta.path, startLine: meta.startLine, endLine: meta.endLine, text, tokens: t, score, reason }); return true;
    };
    // 1) files the user named explicitly always lead (their outline-level chunks, in file order)
    for (const p of mentioned) for (const c of this.chunksByPath.get(p) ?? []) { const m = this.search.meta.get(c.id); if (m && !(await take(c.id, m, `named in request: ${p}`, 10))) break; }
    // 2) ranked hybrid hits
    for (const h of hits) { await take(h.id, h, [...(reasons.get(h.id) ?? []), ...Object.keys(h.sources).map((s) => `${s} #${h.sources[s].rank}`)].join("; "), h.score); if (items.length >= k) break; }
    // 3) import-graph neighbours of the best files (definitions/dependents often explain the hit)
    if (expandGraph && items.length) {
      const top = [...new Set(items.slice(0, 3).map((i) => i.path))];
      for (const p of top) for (const dep of this.symbols.dependencies(p).slice(0, 2)) {
        const c = this.chunksByPath.get(dep)?.[0]; const m = c && this.search.meta.get(c.id);
        if (m && tokens + 150 < budgetTokens) await take(c.id, m, `imported by ${p}`, 0.01);
      }
    }
    return { items, tokens, considered: hits.length, mentioned };
  }
  #resolveMentions(query, extra) {
    const files = this.fs.files(); const out = new Set(extra.filter((p) => this.fs.exists(p)));
    for (const m of query.matchAll(/[\w./@-]+\.[A-Za-z0-9]{1,6}\b/g)) {
      const q = m[0].replace(/^\.\//, ""); if (this.fs.exists(q)) { out.add(q); continue; }
      const hit = files.filter((f) => f === q || f.endsWith("/" + q)); if (hit.length === 1) out.add(hit[0]);
    }
    return [...out];
  }

  // ---- convenient passthroughs used by tools ----
  outline(path) { return this.symbols.outline(path); }
  findSymbol(name, o) { return this.symbols.find(name, o); }
  async references(name, o) { await this.sync(); return this.symbols.references(name, (p) => this.fs.readFile(p), o); }
  impactOf(path, depth) { return this.symbols.impactOf(path, depth); }
  async importantFiles(n = 8) {
    await this.sync(); const hubs = this.symbols.hubs(n); const prof = await this.getProfile();
    const seen = new Set(); const out = [];
    for (const e of [...prof.entryPoints, ...hubs.map((h) => h.path)]) if (this.fs.exists(e) && !seen.has(e)) { seen.add(e); out.push(e); }
    return out.slice(0, n);
  }
  health() { return { ...this.symbols.stats(), chunks: this.search.size, pendingEmbeds: this.search.pending.length, ...this.stats }; }
  static splitIdent = splitIdent;
  static basename = basename;
}
