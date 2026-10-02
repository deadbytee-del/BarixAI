// Incremental project symbol index: definitions, outlines, identifier references, and a resolved import graph.
// Files are re-parsed only when their content hash changes. The index never holds file text.
import { hash53 } from "../util/hash.js";
import { dirname, joinPath } from "../util/misc.js";
import { extractFile } from "./extract.js";
import { languageFor } from "./languages.js";

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
const IDENT = /[A-Za-z_$][\w$]{2,}/g;

export class SymbolIndex {
  constructor({ runtime = null } = {}) {
    this.runtime = runtime; this.files = new Map(); this.byName = new Map(); this.idents = new Map(); this.identsOf = new Map();
    this._graph = null; this.parseCount = 0; this.skipCount = 0;
  }

  /** Index (or re-index) one file. No-op if the content hash is unchanged. */
  async updateFile(path, text) {
    const h = hash53(text);
    const prev = this.files.get(path);
    if (prev && prev.hash === h) { this.skipCount++; return { changed: false }; }
    const lang = languageFor(path);
    if (!lang) return { changed: false };
    const r = await extractFile(this.runtime, path, text); this.parseCount++;
    if (prev) this.#unlink(path);
    const idents = new Set(text.match(IDENT) ?? []);
    this.files.set(path, { hash: h, language: r.language, parser: r.parser, symbols: r.symbols, imports: r.imports, exports: r.exports, errors: r.errors, lines: text.split("\n").length });
    for (const s of r.symbols) { const k = s.name.toLowerCase(); (this.byName.get(k) ?? this.byName.set(k, []).get(k)).push({ ...s, path }); }
    for (const id of idents) (this.idents.get(id) ?? this.idents.set(id, new Set()).get(id)).add(path);
    this.identsOf.set(path, idents); this._graph = null;
    return { changed: true, symbols: r.symbols.length, parser: r.parser, errors: r.errors };
  }
  removeFile(path) { if (!this.files.has(path)) return; this.#unlink(path); this.files.delete(path); this._graph = null; }
  renameFile(from, to) {
    const f = this.files.get(from); if (!f) return;
    this.#unlink(from); this.files.delete(from);
    this.files.set(to, f);
    for (const s of f.symbols) { const k = s.name.toLowerCase(); (this.byName.get(k) ?? this.byName.set(k, []).get(k)).push({ ...s, path: to }); }
    const ids = new Set(); // identifier postings: re-link under new path
    for (const [id, set] of this.idents) if (set.has(from)) { set.delete(from); set.add(to); ids.add(id); }
    this.identsOf.set(to, ids); this.identsOf.delete(from); this._graph = null;
  }
  #unlink(path) {
    const f = this.files.get(path);
    for (const s of f?.symbols ?? []) { const k = s.name.toLowerCase(); const arr = this.byName.get(k)?.filter((x) => x.path !== path); if (arr?.length) this.byName.set(k, arr); else this.byName.delete(k); }
    for (const id of this.identsOf.get(path) ?? []) { const set = this.idents.get(id); set?.delete(path); if (set && !set.size) this.idents.delete(id); }
    this.identsOf.delete(path);
  }

  // ---------- queries ----------
  outline(path) { return (this.files.get(path)?.symbols ?? []).map((s) => ({ ...s })); }
  definitions(name) { return (this.byName.get(name.toLowerCase()) ?? []).filter((s) => s.name === name); }
  /** Ranked symbol search: exact > prefix > camel/snake-token match > substring. */
  find(query, { kind, limit = 25, path } = {}) {
    const q = query.toLowerCase(), qt = splitIdent(query);
    const hits = [];
    for (const [k, arr] of this.byName) {
      let score = 0;
      if (k === q) score = 100; else if (k.startsWith(q)) score = 70 - Math.min(20, k.length - q.length);
      else if (qt.length && qt.every((t) => k.includes(t))) score = 50; else if (k.includes(q)) score = 40;
      if (!score) continue;
      for (const s of arr) { if ((kind && s.kind !== kind) || (path && !s.path.startsWith(path))) continue; hits.push({ ...s, score: score + (s.exported ? 3 : 0) + (s.parent ? 0 : 2) }); }
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
  /** Files that mention identifier `name` (cheap posting-list lookup), definitions first. */
  referencingFiles(name) {
    const defs = new Set(this.definitions(name).map((d) => d.path));
    return [...(this.idents.get(name) ?? [])].sort((a, b) => (defs.has(b) - defs.has(a)) || a.localeCompare(b));
  }
  /** Line-accurate references, given a text loader. */
  async references(name, readFile, { max = 100 } = {}) {
    const out = []; const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
    for (const p of this.referencingFiles(name)) {
      const lines = (await readFile(p)).split("\n");
      lines.forEach((l, i) => { if (re.test(l) && out.length < max) out.push({ path: p, line: i + 1, text: l.trim().slice(0, 200) }); });
      if (out.length >= max) break;
    }
    return out;
  }
  symbolAt(path, line) {
    let best = null;
    for (const s of this.files.get(path)?.symbols ?? []) if (s.startLine <= line && s.endLine >= line && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) best = s;
    return best;
  }
  syntaxErrors() { const out = []; for (const [path, f] of this.files) for (const e of f.errors) out.push({ path, ...e }); return out; }

  // ---------- import graph ----------
  #build() {
    if (this._graph) return this._graph;
    const deps = new Map(), rdeps = new Map(), external = new Map();
    for (const [path, f] of this.files) {
      const d = new Set(), ex = new Set();
      for (const imp of f.imports) { const r = this.resolve(path, imp.spec); if (r) d.add(r); else if (!/^[./]/.test(imp.spec)) ex.add(pkgName(imp.spec)); }
      deps.set(path, d); external.set(path, ex);
      for (const t of d) (rdeps.get(t) ?? rdeps.set(t, new Set()).get(t)).add(path);
    }
    return (this._graph = { deps, rdeps, external });
  }
  resolve(from, spec) {
    const lang = languageFor(from); if (!lang) return null;
    const has = (p) => this.files.has(p);
    if (lang.family === "js") {
      if (!/^[./]/.test(spec)) return null;
      const base = spec.startsWith("/") ? joinPath(spec) : joinPath(dirname(from), spec);
      const stripped = base.replace(/\.(m|c)?jsx?$/, "");
      for (const c of [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => stripped + e), ...JS_EXTS.map((e) => `${base}/index${e}`)]) if (has(c)) return c;
      return null;
    }
    if (lang.family === "py") {
      let rel = 0; while (spec[rel] === ".") rel++;
      const mod = spec.slice(rel).replace(/\./g, "/");
      const roots = rel ? [joinPathSafe(dirname(from), "../".repeat(Math.max(0, rel - 1)))] : ["", dirname(from), "src"];
      for (const r of roots) for (const c of [joinPath(r, mod) + ".py", joinPath(r, mod, "__init__.py")]) if (has(c)) return c;
      return null;
    }
    if (lang.family === "c") {
      for (const c of [joinPath(dirname(from), spec), joinPath(spec), joinPath("include", spec), joinPath("src", spec)]) if (has(c)) return c;
      return null;
    }
    if (lang.family === "rb") { for (const c of [joinPath(dirname(from), spec) + ".rb", joinPath("lib", spec) + ".rb", joinPath(spec) + ".rb"]) if (has(c)) return c; return null; }
    return null;
  }
  dependencies(path) { return [...(this.#build().deps.get(path) ?? [])]; }
  dependents(path) { return [...(this.#build().rdeps.get(path) ?? [])]; }
  externalPackages(path) { return [...(this.#build().external.get(path) ?? [])]; }
  /** Transitive blast radius: everything that (indirectly) imports `path`. */
  impactOf(path, depth = 4) {
    const { rdeps } = this.#build(); const seen = new Map([[path, 0]]); const q = [path];
    while (q.length) { const p = q.shift(); const d = seen.get(p); if (d >= depth) continue; for (const n of rdeps.get(p) ?? []) if (!seen.has(n)) { seen.set(n, d + 1); q.push(n); } }
    seen.delete(path); return [...seen].map(([p, d]) => ({ path: p, distance: d })).sort((a, b) => a.distance - b.distance);
  }
  /** Most-depended-on files: a cheap, real "importance" signal for ranking and project memory. */
  hubs(n = 10) { const { rdeps } = this.#build(); return [...rdeps].map(([p, s]) => ({ path: p, dependents: s.size })).sort((a, b) => b.dependents - a.dependents).slice(0, n); }
  stats() { let symbols = 0, ts = 0, sc = 0; for (const f of this.files.values()) { symbols += f.symbols.length; if (f.parser === "tree-sitter") ts++; else sc++; } return { files: this.files.size, symbols, treeSitterFiles: ts, scannerFiles: sc, parses: this.parseCount, skipped: this.skipCount }; }

  // ---------- persistence ----------
  toJSON() { return { v: 1, files: [...this.files] }; }
  static fromJSON(j, { runtime } = {}) {
    const idx = new SymbolIndex({ runtime });
    for (const [path, f] of j.files) {
      idx.files.set(path, f);
      for (const s of f.symbols) { const k = s.name.toLowerCase(); (idx.byName.get(k) ?? idx.byName.set(k, []).get(k)).push({ ...s, path }); }
    }
    return idx; // identifier postings are rebuilt lazily as files are re-hashed
  }
}

export function splitIdent(s) { return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./$]+/g, " ").toLowerCase().split(/\s+/).filter(Boolean); }
const pkgName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0].split(".")[0]);
const joinPathSafe = (...a) => { try { return joinPath(...a); } catch { return ""; } };
