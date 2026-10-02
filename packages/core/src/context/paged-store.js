// Paged, append-only text store. Text lives in fixed-size pages persisted through a backend; only
// a small LRU of pages is resident, so a multi-million-token history costs O(pageSize * cachedPages)
// of RAM, not O(history). Each record is addressed by (page, offset, length).
import { LRU } from "../util/lru.js";

const enc = new TextEncoder(), dec = new TextDecoder();

/** Minimal key->bytes backend. `fsBackend()` adapts any BarixFS backend; memory is the default. */
export class MemoryPages { constructor() { this.m = new Map(); } async get(k) { return this.m.get(k) ?? null; } async put(k, b) { this.m.set(k, b); } async keys() { return [...this.m.keys()]; } }
export function fsPages(backend, dir = ".barix/ctx") {
  let ready = false;
  const ensure = async () => { if (ready) return; for (const d of [".barix", dir]) if (!(await backend.stat(d))) await backend.mkdir(d); ready = true; };
  return {
    async get(k) { await ensure(); return (await backend.stat(`${dir}/${k}`)) ? backend.readFile(`${dir}/${k}`) : null; },
    async put(k, b) { await ensure(); await backend.writeFile(`${dir}/${k}`, b); },
    async keys() { await ensure(); return (await backend.readdir(dir)).map((e) => e.name); },
  };
}

export class PagedTextStore {
  constructor({ pages = new MemoryPages(), pageChars = 256 * 1024, cachePages = 6 } = {}) {
    this.pages = pages; this.pageChars = pageChars; this.cache = new LRU(cachePages);
    this.active = { n: 0, text: "" }; this.sealed = 0; this.totalChars = 0; this.reads = { hit: 0, miss: 0 };
  }
  /** @returns {{page:number, off:number, len:number}} */
  async append(text) {
    if (this.active.text.length + text.length > this.pageChars && this.active.text.length) await this.#seal();
    const ref = { page: this.active.n, off: this.active.text.length, len: text.length };
    this.active.text += text; this.totalChars += text.length; return ref;
  }
  async #seal() {
    await this.pages.put(`page-${this.active.n}`, enc.encode(this.active.text));
    this.cache.set(this.active.n, this.active.text);
    this.active = { n: this.active.n + 1, text: "" }; this.sealed++;
  }
  async read(ref) {
    if (ref.page === this.active.n) return this.active.text.substr(ref.off, ref.len);
    let page = this.cache.get(ref.page);
    if (page === undefined) {
      this.reads.miss++; const b = await this.pages.get(`page-${ref.page}`);
      if (!b) throw new Error(`context page ${ref.page} missing from storage`);
      page = dec.decode(b); this.cache.set(ref.page, page);
    } else this.reads.hit++;
    return page.substr(ref.off, ref.len);
  }
  async flush() { if (this.active.text.length) await this.pages.put(`page-${this.active.n}`, enc.encode(this.active.text)); }
  get residentChars() { return this.active.text.length + [...this.cache.map.values()].reduce((a, s) => a + s.length, 0); }
  state() { return { active: this.active.n, totalChars: this.totalChars }; }
  /** Reopen after a restart: `n` = index of the last page; the last page becomes the active page. */
  async restore({ active, totalChars }) {
    const b = await this.pages.get(`page-${active}`);
    this.active = { n: active, text: b ? dec.decode(b) : "" }; this.totalChars = totalChars;
  }
}
