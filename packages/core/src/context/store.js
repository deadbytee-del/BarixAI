// ConversationStore: every message, tool call/result, file read and summary Barix has seen, as
// *segments*. Text goes to the paged store; RAM holds only small metadata records and the history
// index. Segments are never silently dropped: compaction archives them (still searchable); only the
// hard total-token cap can evict raw text — and then the structured summary survives.
import { uid } from "../util/misc.js";
import { PagedTextStore } from "./paged-store.js";
import { HybridIndex } from "../retrieval/hybrid.js";
import { TokenCounter } from "../tokens/counter.js";

export const LIMITS = Object.freeze({
  conversationTarget: 3_500_000, // engineering target for total retrievable conversation context
  browserCoding: 1_250_000,      // browser coding sessions
});

const INDEX_CHUNK_CHARS = 1800, INDEX_MAX_CHARS = 60_000;

export class ConversationStore {
  /**
   * @param {{counter?:TokenCounter, text?:PagedTextStore, index?:HybridIndex, maxTotalTokens?:number}} o
   */
  constructor({ counter = new TokenCounter(), text = new PagedTextStore(), index = new HybridIndex(), maxTotalTokens = LIMITS.conversationTarget } = {}) {
    this.counter = counter; this.text = text; this.index = index; this.maxTotalTokens = maxTotalTokens;
    this.segs = new Map(); this.order = []; this.nextSeq = 1; this.summaries = new Map();
    this.totals = { all: 0, live: 0, archived: 0, evicted: 0, evictedSegments: 0 };
  }

  /** @returns {Promise<object>} the segment record */
  async append({ role, kind = "message", text, importance = 0.5, tags = [], meta = {} }) {
    const tokens = this.counter.count(text);
    const ref = await this.text.append(text);
    const seg = { id: uid("s"), seq: this.nextSeq++, role, kind, tokens, ts: Date.now(), importance, tags, meta, ref, archived: false, evicted: false, summaryId: null, preview: text.slice(0, 160).replace(/\s+/g, " ") };
    this.segs.set(seg.id, seg); this.order.push(seg.id);
    this.totals.all += tokens; this.totals.live += tokens;
    return seg;
  }
  get(id) { return this.segs.get(id); }
  async readText(id) {
    const s = this.segs.get(id); if (!s) throw new Error(`unknown segment ${id}`);
    if (s.evicted) return `[evicted: ${s.preview}…]`;
    return this.text.read(s.ref);
  }
  live() { return this.order.map((id) => this.segs.get(id)).filter((s) => !s.archived); }
  bySeqRange(from, to) { return this.order.map((id) => this.segs.get(id)).filter((s) => s.seq >= from && s.seq <= to); }

  /** Archive segments under a summary node and index them for retrieval. */
  async archive(segIds, summaryId, { embed = false } = {}) {
    for (const id of segIds) {
      const s = this.segs.get(id); if (!s || s.archived) continue;
      s.archived = true; s.summaryId = summaryId; this.totals.live -= s.tokens; this.totals.archived += s.tokens;
      await this.#indexSegment(s);
    }
    if (embed) await this.index.flush();
    await this.enforceLimit();
  }
  async #indexSegment(s) {
    const text = (await this.text.read(s.ref)).slice(0, INDEX_MAX_CHARS);
    const header = `#${s.seq} ${s.role}${s.meta.tool ? " " + s.meta.tool : ""}${s.meta.path ? " " + s.meta.path : ""}`;
    for (let off = 0, k = 0; off < text.length; off += INDEX_CHUNK_CHARS, k++) {
      this.index.add({ id: k ? `${s.id}~${k}` : s.id, text: text.slice(off, off + INDEX_CHUNK_CHARS), header, names: s.meta.path ? [s.meta.path] : [], meta: { kind: "segment", segId: s.id, seq: s.seq, role: s.role, summaryId: s.summaryId } });
    }
  }
  addSummary(node) {
    this.summaries.set(node.id, node);
    this.index.add({ id: node.id, text: node.text, header: `summary L${node.level} #${node.from}-${node.to}`, meta: { kind: "summary", level: node.level, from: node.from, to: node.to } });
    return node;
  }
  /** Drop a summary node from retrieval (it was merged into a higher level). */
  retireSummary(id) { const n = this.summaries.get(id); if (n) { n.retired = true; this.index.remove(id); } }
  activeSummaries() { return [...this.summaries.values()].filter((n) => !n.retired).sort((a, b) => a.from - b.from); }

  /** Hard cap: evict raw text of the least valuable archived segments. Summaries stay. */
  async enforceLimit() {
    const total = this.totals.all - this.totals.evicted;
    if (total <= this.maxTotalTokens) return 0;
    let need = total - this.maxTotalTokens * 0.95, freed = 0;
    const cand = this.order.map((id) => this.segs.get(id)).filter((s) => s.archived && !s.evicted)
      .map((s) => ({ s, value: s.importance * 2 + (s.kind === "message" ? 0.3 : 0) - (this.nextSeq - s.seq) / this.nextSeq * 0.5 + (s.tags.includes("pinned") ? 10 : 0) }))
      .sort((a, b) => a.value - b.value);
    for (const { s } of cand) {
      if (need <= 0) break;
      s.evicted = true; this.totals.evicted += s.tokens; this.totals.evictedSegments++; need -= s.tokens; freed += s.tokens;
      for (let k = 0; k < 40; k++) this.index.remove(k ? `${s.id}~${k}` : s.id);
    }
    return freed;
  }
  stats() { return { ...this.totals, segments: this.segs.size, summaries: this.activeSummaries().length, retrievable: this.totals.all - this.totals.evicted, residentChars: this.text.residentChars, pagesSealed: this.text.sealed }; }

  // ---- persistence of metadata (text pages persist themselves) ----
  toJSON() { return { v: 1, nextSeq: this.nextSeq, totals: this.totals, segs: this.order.map((id) => this.segs.get(id)), summaries: [...this.summaries.values()], text: this.text.state() }; }
  async restore(j, { reindex = true } = {}) {
    this.nextSeq = j.nextSeq; this.totals = j.totals; this.segs.clear(); this.order = [];
    for (const s of j.segs) { this.segs.set(s.id, s); this.order.push(s.id); }
    this.summaries = new Map(j.summaries.map((n) => [n.id, n])); await this.text.restore(j.text);
    if (reindex) { for (const s of this.segs.values()) if (s.archived && !s.evicted) await this.#indexSegment(s); for (const n of this.summaries.values()) if (!n.retired) this.addSummary(n); }
  }
}
