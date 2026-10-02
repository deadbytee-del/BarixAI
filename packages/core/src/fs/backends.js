// Low-level storage backends. All expose the same async interface (paths are POSIX, root-relative):
//   stat(p) -> {type:"file"|"dir", size, mtime} | null
//   readFile(p) -> Uint8Array          writeFile(p, bytes)       remove(p)  (file)
//   mkdir(p)    rmdir(p)  (empty dir)  readdir(p) -> [{name,type}]  rename(from,to)
// Barix's own FS layer (BarixFS) owns semantics (tree, versions, events); backends just move bytes.
import { BarixError, posixPath, dirname, basename } from "../util/misc.js";

export class MemoryBackend {
  constructor() { this.files = new Map(); this.dirs = new Set([""]); this.kind = "memory"; }
  async stat(p) {
    if (this.files.has(p)) { const f = this.files.get(p); return { type: "file", size: f.bytes.length, mtime: f.mtime }; }
    if (this.dirs.has(p)) return { type: "dir", size: 0, mtime: 0 };
    return null;
  }
  async readFile(p) { const f = this.files.get(p); if (!f) throw new BarixError("ENOENT", `no such file: ${p}`); return f.bytes; }
  async writeFile(p, bytes) {
    if (!this.dirs.has(dirname(p))) throw new BarixError("ENOENT", `parent directory missing: ${dirname(p)}`);
    this.files.set(p, { bytes: bytes.slice(), mtime: Date.now() });
  }
  async remove(p) { if (!this.files.delete(p)) throw new BarixError("ENOENT", `no such file: ${p}`); }
  async mkdir(p) { if (!this.dirs.has(dirname(p))) throw new BarixError("ENOENT", `parent directory missing: ${dirname(p)}`); this.dirs.add(p); }
  async rmdir(p) {
    const pre = p + "/";
    for (const k of [...this.files.keys(), ...this.dirs]) if (k.startsWith(pre)) throw new BarixError("ENOTEMPTY", `directory not empty: ${p}`);
    this.dirs.delete(p);
  }
  async readdir(p) {
    const pre = p ? p + "/" : "", out = new Map();
    for (const k of this.files.keys()) if (k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.set(k.slice(pre.length), "file");
    for (const k of this.dirs) if (k && k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.set(k.slice(pre.length), "dir");
    return [...out].map(([name, type]) => ({ name, type }));
  }
  async rename(a, b) {
    if (this.files.has(a)) { this.files.set(b, this.files.get(a)); this.files.delete(a); return; }
    if (!this.dirs.has(a)) throw new BarixError("ENOENT", `no such path: ${a}`);
    const pa = a + "/";
    this.dirs.delete(a); this.dirs.add(b);
    for (const d of [...this.dirs]) if (d.startsWith(pa)) { this.dirs.delete(d); this.dirs.add(b + "/" + d.slice(pa.length)); }
    for (const [k, v] of [...this.files]) if (k.startsWith(pa)) { this.files.delete(k); this.files.set(b + "/" + k.slice(pa.length), v); }
  }
}

/** Real disk, confined to `root`. Used by BarixTerm. */
export class NodeBackend {
  constructor(root, nodeFs, nodePath) { this.root = root; this.fs = nodeFs; this.path = nodePath; this.kind = "node-disk"; }
  static async create(root) {
    const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const abs = path.resolve(root); await fs.mkdir(abs, { recursive: true });
    return new NodeBackend(abs, fs, path);
  }
  #abs(p) {
    const abs = this.path.resolve(this.root, p);
    if (abs !== this.root && !abs.startsWith(this.root + this.path.sep)) throw new BarixError("EPATH", `path escapes project root: ${p}`);
    return abs;
  }
  async stat(p) {
    try { const s = await this.fs.lstat(this.#abs(p)); return { type: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtimeMs, symlink: s.isSymbolicLink() }; }
    catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; }
  }
  async readFile(p) { try { return new Uint8Array(await this.fs.readFile(this.#abs(p))); } catch (e) { throw wrap(e, p); } }
  async writeFile(p, bytes) { try { await this.fs.writeFile(this.#abs(p), bytes); } catch (e) { throw wrap(e, p); } }
  async remove(p) { try { await this.fs.unlink(this.#abs(p)); } catch (e) { throw wrap(e, p); } }
  async mkdir(p) { try { await this.fs.mkdir(this.#abs(p)); } catch (e) { if (e.code !== "EEXIST") throw wrap(e, p); } }
  async rmdir(p) { try { await this.fs.rmdir(this.#abs(p)); } catch (e) { throw wrap(e, p); } }
  async readdir(p) {
    try { return (await this.fs.readdir(this.#abs(p), { withFileTypes: true })).map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" })); }
    catch (e) { throw wrap(e, p); }
  }
  async rename(a, b) { try { await this.fs.rename(this.#abs(a), this.#abs(b)); } catch (e) { throw wrap(e, a); } }
}
const wrap = (e, p) => (e instanceof BarixError ? e : new BarixError(e.code || "EIO", `${e.code || "error"}: ${p}`));

/** Origin Private File System (browser). Works inside Workers via the async API. */
export class OPFSBackend {
  constructor(rootHandle) { this.root = rootHandle; this.kind = "opfs"; }
  static async create(name = "barix-project") {
    const top = await navigator.storage.getDirectory();
    return new OPFSBackend(await top.getDirectoryHandle(name, { create: true }));
  }
  async #dir(p, create = false) {
    let h = this.root;
    for (const seg of p.split("/").filter(Boolean)) h = await h.getDirectoryHandle(seg, { create });
    return h;
  }
  async stat(p) {
    if (!p) return { type: "dir", size: 0, mtime: 0 };
    try {
      const d = await this.#dir(dirname(p));
      try { const f = await (await d.getFileHandle(basename(p))).getFile(); return { type: "file", size: f.size, mtime: f.lastModified }; }
      catch (e) { if (e.name === "TypeMismatchError") return { type: "dir", size: 0, mtime: 0 }; if (e.name !== "NotFoundError") throw e; }
      try { await d.getDirectoryHandle(basename(p)); return { type: "dir", size: 0, mtime: 0 }; } catch (e) { if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null; throw e; }
    } catch (e) { if (e.name === "NotFoundError") return null; throw e; }
  }
  async readFile(p) {
    try { return new Uint8Array(await (await (await (await this.#dir(dirname(p))).getFileHandle(basename(p))).getFile()).arrayBuffer()); }
    catch (e) { throw domErr(e, p); }
  }
  async writeFile(p, bytes) {
    try {
      const fh = await (await this.#dir(dirname(p))).getFileHandle(basename(p), { create: true });
      const w = await fh.createWritable(); await w.write(bytes); await w.close();
    } catch (e) { throw domErr(e, p); }
  }
  async remove(p) { try { await (await this.#dir(dirname(p))).removeEntry(basename(p)); } catch (e) { throw domErr(e, p); } }
  async mkdir(p) { try { await (await this.#dir(dirname(p))).getDirectoryHandle(basename(p), { create: true }); } catch (e) { throw domErr(e, p); } }
  async rmdir(p) { try { await (await this.#dir(dirname(p))).removeEntry(basename(p)); } catch (e) { throw domErr(e, p); } }
  async readdir(p) {
    const out = []; try { for await (const [name, h] of (await this.#dir(p)).entries()) out.push({ name, type: h.kind === "directory" ? "dir" : "file" }); } catch (e) { throw domErr(e, p); }
    return out;
  }
  async rename(a, b) {
    const st = await this.stat(a); if (!st) throw new BarixError("ENOENT", `no such path: ${a}`);
    if (st.type === "file") { await this.writeFile(b, await this.readFile(a)); await this.remove(a); return; }
    await this.mkdir(b);
    for (const e of await this.readdir(a)) await this.rename(`${a}/${e.name}`, `${b}/${e.name}`);
    await this.rmdir(a);
  }
}
const domErr = (e, p) => (e instanceof BarixError ? e : new BarixError(e.name === "NotFoundError" ? "ENOENT" : e.name === "InvalidModificationError" ? "ENOTEMPTY" : "EIO", `${e.name}: ${p}`));

/** IndexedDB fallback (browsers without OPFS, or for sync-friendly small projects). Flat path -> record store. */
export class IDBBackend {
  constructor(db) { this.db = db; this.kind = "indexeddb"; }
  static async create(name = "barix-project") {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("e");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const b = new IDBBackend(db);
    if (!(await b.#get(""))) await b.#put("", { type: "dir", mtime: 0 });
    return b;
  }
  #tx(mode) { return this.db.transaction("e", mode).objectStore("e"); }
  #get(k) { return new Promise((res, rej) => { const r = this.#tx("readonly").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  #put(k, v) { return new Promise((res, rej) => { const r = this.#tx("readwrite").put(v, k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  #del(k) { return new Promise((res, rej) => { const r = this.#tx("readwrite").delete(k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  #keys() { return new Promise((res, rej) => { const r = this.#tx("readonly").getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async stat(p) { const r = await this.#get(p); return r ? { type: r.type, size: r.bytes?.length ?? 0, mtime: r.mtime } : null; }
  async readFile(p) { const r = await this.#get(p); if (!r || r.type !== "file") throw new BarixError("ENOENT", `no such file: ${p}`); return r.bytes; }
  async writeFile(p, bytes) {
    const par = await this.#get(dirname(p)); if (!par) throw new BarixError("ENOENT", `parent directory missing: ${dirname(p)}`);
    await this.#put(p, { type: "file", bytes: bytes.slice(), mtime: Date.now() });
  }
  async remove(p) { if (!(await this.#get(p))) throw new BarixError("ENOENT", `no such file: ${p}`); await this.#del(p); }
  async mkdir(p) { if (!(await this.#get(dirname(p)))) throw new BarixError("ENOENT", `parent directory missing: ${dirname(p)}`); await this.#put(p, { type: "dir", mtime: Date.now() }); }
  async rmdir(p) { if ((await this.readdir(p)).length) throw new BarixError("ENOTEMPTY", `directory not empty: ${p}`); await this.#del(p); }
  async readdir(p) {
    const pre = p ? p + "/" : "", out = [];
    for (const k of await this.#keys()) if (k && k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.push({ name: k.slice(pre.length), type: (await this.#get(k)).type });
    return out;
  }
  async rename(a, b) {
    const pre = a + "/";
    for (const k of await this.#keys()) {
      if (k === a || k.startsWith(pre)) { const v = await this.#get(k); await this.#put(b + k.slice(a.length), v); await this.#del(k); }
    }
  }
}

export { posixPath };
