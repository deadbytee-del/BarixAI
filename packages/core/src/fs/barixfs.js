// BarixFS: the filesystem Barix reasons about. It owns the *authoritative in-memory project tree*,
// versioned history, events and search on top of any backend. Every mutation goes through one
// serialized queue and updates the tree before resolving, so tool results and the tree never disagree.
// `audit()` re-scans the backend and reports any divergence (the anti-hallucination ground truth).
import { BarixError, posixPath, dirname, basename, extname } from "../util/misc.js";
import { Emitter } from "../util/events.js";
import { hash53, sha256Hex } from "../util/hash.js";
import { applyEdits } from "./edits.js";
import { unifiedDiff, applyUnifiedDiff, diffLines, diffStats } from "./diff.js";

const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: false });
export const DEFAULT_IGNORE = [".git", "node_modules", ".barix", "dist", ".DS_Store", "__pycache__", ".cache"];
const META = ".barix";

export function isBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function globToRegExp(glob) {
  let re = "", i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { i += 2; if (glob[i] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; continue; }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, j).split(",").map(esc).join("|") + ")"; i = j; }
    else re += esc(c);
    i++;
  }
  return new RegExp("^" + re + "$");
}
const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export class BarixFS extends Emitter {
  /**
   * @param {object} backend  storage backend
   * @param {{ignore?:string[], versioning?:boolean, maxVersionsPerFile?:number}} [opts]
   */
  constructor(backend, { ignore = DEFAULT_IGNORE, versioning = true, maxVersionsPerFile = 200 } = {}) {
    super();
    this.backend = backend; this.ignore = new Set(ignore); this.versioning = versioning; this.maxVersions = maxVersionsPerFile;
    this.nodes = new Map([["", { type: "dir", size: 0, mtime: 0 }]]); // authoritative project tree
    this.rev = 0; this.log = [];      // log: [{rev, kind, path, from?}] for incremental consumers
    this.versions = new Map();        // path -> [{id, sha, size, op, ts, deleted?}]
    this.snapshots = [];              // [{id,label,ts,files:{path:sha}}]
    this._q = Promise.resolve(); this._vdirty = false; this.ready = false;
  }

  // ---------- lifecycle ----------
  async init() {
    await this.#scan("");
    if (this.versioning) await this.#loadVersions();
    this.ready = true; return this;
  }
  #ignored(path) { return path.split("/").some((s) => this.ignore.has(s)); }
  async #scan(dir) {
    for (const e of await this.backend.readdir(dir)) {
      if (this.ignore.has(e.name)) continue;
      const p = dir ? `${dir}/${e.name}` : e.name;
      const st = await this.backend.stat(p); if (!st) continue;
      if (st.symlink) continue; // never follow symlinks out of the project
      this.nodes.set(p, { type: st.type, size: st.size, mtime: st.mtime });
      if (st.type === "dir") await this.#scan(p);
    }
  }
  #serial(fn) { const r = this._q.then(fn, fn); this._q = r.catch(() => {}); return r; }
  #bump(kind, path, extra = {}) { this.rev++; const e = { rev: this.rev, kind, path, ...extra }; this.log.push(e); if (this.log.length > 50000) this.log.splice(0, 25000); this.emit("change", e); return e; }
  changesSince(rev) { return this.log.filter((e) => e.rev > rev); }
  #norm(p) { return posixPath(p); }

  // ---------- reads ----------
  exists(p) { return this.nodes.has(this.#norm(p)); }
  statSync(p) { const n = this.nodes.get(this.#norm(p)); return n ? { ...n, path: this.#norm(p) } : null; }
  async stat(p) { return this.statSync(p); }
  async readBytes(p) {
    p = this.#norm(p); const n = this.nodes.get(p);
    if (!n) throw new BarixError("ENOENT", `no such file: ${p}`, { path: p });
    if (n.type !== "file") throw new BarixError("EISDIR", `is a directory: ${p}`);
    return this.backend.readFile(p);
  }
  async readFile(p, { startLine, endLine, maxBytes } = {}) {
    const bytes = await this.readBytes(p);
    if (isBinary(bytes)) throw new BarixError("EBINARY", `binary file (${bytes.length} bytes): ${this.#norm(p)}`);
    let text = dec.decode(maxBytes ? bytes.subarray(0, maxBytes) : bytes);
    if (startLine || endLine) { const L = text.split("\n"); text = L.slice((startLine ?? 1) - 1, endLine ?? L.length).join("\n"); }
    return text;
  }
  /** Read with 1-based line numbers (for the model to cite exact lines). */
  async readNumbered(p, { startLine = 1, endLine } = {}) {
    const L = (await this.readFile(p)).split("\n"); const e = Math.min(endLine ?? L.length, L.length);
    return { total: L.length, text: L.slice(startLine - 1, e).map((l, i) => `${String(startLine + i).padStart(5)}  ${l}`).join("\n") };
  }
  list(dir = "", { recursive = false } = {}) {
    dir = this.#norm(dir); const pre = dir ? dir + "/" : ""; const out = [];
    if (!this.nodes.has(dir)) throw new BarixError("ENOENT", `no such directory: ${dir}`);
    for (const [p, n] of this.nodes) {
      if (!p || !p.startsWith(pre)) continue;
      const rest = p.slice(pre.length);
      if (!recursive && rest.includes("/")) continue;
      out.push({ path: p, name: basename(p), ...n });
    }
    return out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
  }
  files({ glob } = {}) {
    const re = glob ? globToRegExp(glob) : null; const out = [];
    for (const [p, n] of this.nodes) if (n.type === "file" && (!re || re.test(p))) out.push(p);
    return out.sort();
  }
  /** Compact ASCII tree for prompts, bounded by entries. */
  renderTree({ dir = "", maxEntries = 200, maxDepth = 6 } = {}) {
    dir = this.#norm(dir); const lines = []; let count = 0;
    const walk = (d, prefix, depth) => {
      for (const e of this.list(d)) {
        if (count++ >= maxEntries) return;
        lines.push(`${prefix}${e.name}${e.type === "dir" ? "/" : ` (${fmtSize(e.size)})`}`);
        if (e.type === "dir" && depth < maxDepth) walk(e.path, prefix + "  ", depth + 1);
      }
    };
    walk(dir, "", 1); if (count > maxEntries) lines.push(`… (${count - maxEntries}+ more entries)`);
    return lines.join("\n");
  }

  // ---------- writes (serialized; tree updated before resolve) ----------
  async mkdir(p, { recursive = true } = {}) {
    p = this.#norm(p);
    return this.#serial(async () => {
      const parts = p.split("/").filter(Boolean); let cur = "";
      for (const seg of parts) {
        cur = cur ? `${cur}/${seg}` : seg; const n = this.nodes.get(cur);
        if (n?.type === "file") throw new BarixError("EEXIST", `file exists where directory needed: ${cur}`);
        if (n) continue;
        if (!recursive && cur !== p) throw new BarixError("ENOENT", `parent missing: ${dirname(cur)}`);
        await this.backend.mkdir(cur); this.nodes.set(cur, { type: "dir", size: 0, mtime: Date.now() }); this.#bump("mkdir", cur);
      }
      return { path: p };
    });
  }
  async writeFile(p, content, { op = "write", createDirs = true } = {}) {
    p = this.#norm(p); if (!p) throw new BarixError("EPATH", "empty path");
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    return this.#serial(async () => {
      const existing = this.nodes.get(p);
      if (existing?.type === "dir") throw new BarixError("EISDIR", `is a directory: ${p}`);
      const parent = dirname(p);
      if (parent && !this.nodes.has(parent)) { if (!createDirs) throw new BarixError("ENOENT", `parent missing: ${parent}`); await this.#mkdirUnlocked(parent); }
      const before = existing ? await this.backend.readFile(p).catch(() => null) : null;
      if (before && this.versioning && !this.versions.get(p)?.length) await this.#recordVersion(p, before, "baseline");
      await this.backend.writeFile(p, bytes);
      const st = await this.backend.stat(p);
      this.nodes.set(p, { type: "file", size: st?.size ?? bytes.length, mtime: st?.mtime ?? Date.now() });
      const sha = this.versioning ? await this.#recordVersion(p, bytes, existing ? op : "create") : undefined;
      return this.#bump(existing ? "modify" : "create", p, { size: bytes.length, sha });
    });
  }
  async #mkdirUnlocked(p) {
    let cur = "";
    for (const seg of p.split("/").filter(Boolean)) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (this.nodes.has(cur)) continue;
      await this.backend.mkdir(cur); this.nodes.set(cur, { type: "dir", size: 0, mtime: Date.now() }); this.#bump("mkdir", cur);
    }
  }
  /** Search/replace edits. Returns the unified diff actually written. */
  async patchFile(p, edits) {
    const before = await this.readFile(p);
    const { content, applied } = applyEdits(before, edits);
    const r = await this.writeFile(p, content, { op: "patch" });
    return { ...r, applied, diff: unifiedDiff(before, content, { path: this.#norm(p) }), ...diffStats(diffLines(before, content)) };
  }
  async applyPatch(p, unified) {
    const before = await this.readFile(p);
    let content; try { content = applyUnifiedDiff(before, unified); } catch (e) { throw new BarixError("EPATCH", e.message); }
    const r = await this.writeFile(p, content, { op: "patch" });
    return { ...r, diff: unifiedDiff(before, content, { path: this.#norm(p) }) };
  }
  async deleteFile(p) {
    p = this.#norm(p);
    return this.#serial(async () => {
      const n = this.nodes.get(p); if (!n) throw new BarixError("ENOENT", `no such file: ${p}`);
      if (n.type !== "file") throw new BarixError("EISDIR", `is a directory (use deleteDir): ${p}`);
      if (this.versioning) { const b = await this.backend.readFile(p).catch(() => null); if (b) await this.#recordVersion(p, b, "delete", true); }
      await this.backend.remove(p); this.nodes.delete(p); return this.#bump("delete", p);
    });
  }
  async deleteDir(p, { recursive = false } = {}) {
    p = this.#norm(p);
    return this.#serial(async () => {
      const n = this.nodes.get(p); if (!n) throw new BarixError("ENOENT", `no such directory: ${p}`);
      if (n.type !== "dir") throw new BarixError("ENOTDIR", `not a directory: ${p}`);
      const pre = p + "/", kids = [...this.nodes.keys()].filter((k) => k.startsWith(pre)).sort((a, b) => b.length - a.length);
      if (kids.length && !recursive) throw new BarixError("ENOTEMPTY", `directory not empty: ${p}`);
      for (const k of kids) {
        if (this.nodes.get(k).type === "file") {
          if (this.versioning) { const b = await this.backend.readFile(k).catch(() => null); if (b) await this.#recordVersion(k, b, "delete", true); }
          await this.backend.remove(k);
        } else await this.backend.rmdir(k);
        this.nodes.delete(k); this.#bump("delete", k);
      }
      await this.backend.rmdir(p); this.nodes.delete(p); return this.#bump("rmdir", p);
    });
  }
  async move(from, to) {
    from = this.#norm(from); to = this.#norm(to);
    return this.#serial(async () => {
      const n = this.nodes.get(from); if (!n) throw new BarixError("ENOENT", `no such path: ${from}`);
      if (this.nodes.has(to)) throw new BarixError("EEXIST", `destination exists: ${to}`);
      if (to.startsWith(from + "/")) throw new BarixError("EINVAL", "cannot move a directory into itself");
      const parent = dirname(to); if (parent && !this.nodes.has(parent)) await this.#mkdirUnlocked(parent);
      await this.backend.rename(from, to);
      const pre = from + "/";
      for (const [k, v] of [...this.nodes]) {
        if (k === from) { this.nodes.delete(k); this.nodes.set(to, v); }
        else if (k.startsWith(pre)) { this.nodes.delete(k); this.nodes.set(to + "/" + k.slice(pre.length), v); }
      }
      for (const [k, v] of [...this.versions]) if (k === from || k.startsWith(pre)) { this.versions.delete(k); this.versions.set(to + k.slice(from.length), v); }
      this._vdirty = true;
      return this.#bump("rename", to, { from });
    });
  }
  rename(a, b) { return this.move(a, b); }
  async copy(from, to) { return this.writeFile(to, await this.readBytes(from)); }

  // ---------- versions ----------
  async #recordVersion(p, bytes, op, deleted = false) {
    const sha = await sha256Hex(bytes);
    if (!(await this.backend.stat(`${META}/objects/${sha}`))) {
      await this.#ensureMeta(); await this.backend.writeFile(`${META}/objects/${sha}`, bytes);
    }
    const list = this.versions.get(p) ?? this.versions.set(p, []).get(p);
    const last = list[list.length - 1];
    if (!(last && last.sha === sha && !deleted && !last.deleted)) {
      list.push({ id: `${p}@${list.length + 1}`, n: list.length + 1, sha, size: bytes.length, op, ts: Date.now(), deleted });
      if (list.length > this.maxVersions) list.splice(0, list.length - this.maxVersions);
    }
    this._vdirty = true; this.#scheduleFlush(); return sha;
  }
  async #ensureMeta() {
    for (const d of [META, `${META}/objects`]) if (!(await this.backend.stat(d))) await this.backend.mkdir(d);
  }
  #scheduleFlush() { if (this._ft) return; this._ft = setTimeout(() => { this._ft = null; this.flush().catch(() => {}); }, 250); this._ft.unref?.(); }
  async flush() {
    if (!this._vdirty || !this.versioning) return;
    await this.#ensureMeta(); this._vdirty = false;
    await this.backend.writeFile(`${META}/versions.json`, enc.encode(JSON.stringify({ v: 1, versions: [...this.versions], snapshots: this.snapshots })));
  }
  async #loadVersions() {
    try {
      if (!(await this.backend.stat(`${META}/versions.json`))) return;
      const j = JSON.parse(dec.decode(await this.backend.readFile(`${META}/versions.json`)));
      this.versions = new Map(j.versions); this.snapshots = j.snapshots ?? [];
    } catch { /* corrupt history never blocks the project */ }
  }
  history(p) { return [...(this.versions.get(this.#norm(p)) ?? [])].reverse(); }
  async readVersion(p, n) {
    const v = this.versions.get(this.#norm(p))?.find((x) => x.n === n || x.id === n);
    if (!v) throw new BarixError("ENOVERSION", `no version ${n} of ${p}`);
    return dec.decode(await this.backend.readFile(`${META}/objects/${v.sha}`));
  }
  async diffVersions(p, a, b = "current") {
    const A = await this.readVersion(p, a), B = b === "current" ? await this.readFile(p) : await this.readVersion(p, b);
    return unifiedDiff(A, B, { path: this.#norm(p) });
  }
  async restore(p, n) {
    const text = await this.readVersion(p, n); const r = await this.writeFile(p, text, { op: "restore" });
    this.#bump("restore", this.#norm(p), { version: n }); return r;
  }
  async snapshot(label = "") {
    await this.flush();
    const files = {};
    for (const [p, n] of this.nodes) if (n.type === "file") files[p] = await sha256Hex(await this.backend.readFile(p));
    for (const [p, sha] of Object.entries(files)) if (!(await this.backend.stat(`${META}/objects/${sha}`))) { await this.#ensureMeta(); await this.backend.writeFile(`${META}/objects/${sha}`, await this.backend.readFile(p)); }
    const s = { id: `snap_${this.snapshots.length + 1}`, label, ts: Date.now(), files };
    this.snapshots.push(s); this._vdirty = true; await this.flush(); return { id: s.id, label, files: Object.keys(files).length };
  }
  async restoreSnapshot(id) {
    const s = this.snapshots.find((x) => x.id === id); if (!s) throw new BarixError("ENOVERSION", `no snapshot ${id}`);
    for (const [p, n] of [...this.nodes]) if (n.type === "file" && !(p in s.files)) await this.deleteFile(p);
    for (const [p, sha] of Object.entries(s.files)) await this.writeFile(p, await this.backend.readFile(`${META}/objects/${sha}`), { op: "restore" });
    return { restored: Object.keys(s.files).length };
  }

  // ---------- search ----------
  async grep(pattern, { regex = false, ignoreCase = false, glob, maxResults = 200, context = 0, maxFileBytes = 1_000_000 } = {}) {
    const re = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
    const gre = glob ? globToRegExp(glob) : null; const out = [];
    for (const [p, n] of this.nodes) {
      if (n.type !== "file" || n.size > maxFileBytes || (gre && !gre.test(p))) continue;
      const bytes = await this.backend.readFile(p).catch(() => null); if (!bytes || isBinary(bytes)) continue;
      const lines = dec.decode(bytes).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({ path: p, line: i + 1, text: lines[i].slice(0, 300), ...(context ? { before: lines.slice(Math.max(0, i - context), i), after: lines.slice(i + 1, i + 1 + context) } : {}) });
          if (out.length >= maxResults) return out;
        }
      }
    }
    return out;
  }

  // ---------- ground truth ----------
  /** Re-scan the backend and diff against the in-memory tree. Empty result == tree is accurate. */
  async audit() {
    const fresh = new BarixFS(this.backend, { ignore: [...this.ignore], versioning: false });
    await fresh.#scan("");
    const missing = [], extra = [], changed = [];
    for (const [p, n] of fresh.nodes) { const m = this.nodes.get(p); if (!m) extra.push(p); else if (m.type !== n.type || (n.type === "file" && m.size !== n.size)) changed.push(p); }
    for (const p of this.nodes.keys()) if (!fresh.nodes.has(p)) missing.push(p);
    return { ok: !missing.length && !extra.length && !changed.length, missingOnDisk: missing, untracked: extra, changed };
  }
  /** Re-sync the tree from the backend (e.g. after an external command like a build modified files). */
  async refresh() {
    const before = new Map(this.nodes); this.nodes = new Map([["", { type: "dir", size: 0, mtime: 0 }]]); await this.#scan("");
    const changes = [];
    for (const [p, n] of this.nodes) { const b = before.get(p); if (!b) changes.push(this.#bump("create", p, { external: true })); else if (n.type === "file" && (b.size !== n.size || b.mtime !== n.mtime)) changes.push(this.#bump("modify", p, { external: true })); }
    for (const p of before.keys()) if (!this.nodes.has(p)) changes.push(this.#bump("delete", p, { external: true }));
    return changes;
  }
  contentHash(text) { return hash53(text); }
  get extname() { return extname; }
}

function fmtSize(n) { return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`; }
