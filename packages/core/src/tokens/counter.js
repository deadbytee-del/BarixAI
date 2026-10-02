// Token accounting. Barix never tokenizes the same content twice (LRU by content hash) and
// distinguishes *estimated* counts from *exact* counts taken from a real tokenizer.
import { hash53 } from "../util/hash.js";
import { LRU } from "../util/lru.js";

// Pre-tokenizer approximating BPE piece boundaries: words, numbers, punctuation runs, whitespace.
const PIECE = /[A-Za-zÀ-ɏ]+|\d{1,3}|\s+|[^\sA-Za-z\dÀ-ɏ]+|[Ѐ-鿿가-힯]/gu;

/** Calibrated per-piece estimate. `scale` is fitted against a real tokenizer (see scripts/calibrate-tokens.mjs). */
export function estimateTokens(text, scale = 1) {
  if (!text) return 0;
  let n = 0;
  for (const m of text.matchAll(PIECE)) {
    const p = m[0], c = p.charCodeAt(0);
    if (c > 0x2e7f) n += 1.5;                       // CJK etc.: ~1-2 tokens per char
    else if (/^\s+$/.test(p)) n += p.includes("\n") ? Math.max(1, Math.ceil(p.length / 8)) * 0.5 + 0.5 : (p.length > 1 ? 0.5 : 0);
    else if (/^[A-Za-zÀ-ɏ]+$/.test(p)) n += p.length <= 5 ? 1 : 1 + (p.length - 5) / 4.2; // long identifiers split
    else if (/^\d+$/.test(p)) n += 1;
    else n += Math.ceil(p.length / 2.2);            // punctuation runs merge pairwise-ish
  }
  return Math.max(1, Math.round(n * scale));
}

export class TokenCounter {
  /** @param {{exact?:(text:string)=>number|Promise<number>, scale?:number, cacheSize?:number}} o */
  constructor({ exact = null, scale = 1, cacheSize = 2_000_000 } = {}) {
    this.exact = exact; this.scale = scale; this.cache = new LRU(cacheSize, () => 1);
    this.computed = 0; this.cached = 0;
  }
  /** Sync estimate with content-hash memoization. */
  count(text) {
    if (!text) return 0;
    if (text.length < 24) return estimateTokens(text, this.scale);
    const k = hash53(text) + ":" + text.length;
    const hit = this.cache.get(k);
    if (hit !== undefined) { this.cached++; return hit; }
    const n = estimateTokens(text, this.scale); this.computed++;
    this.cache.set(k, n); return n;
  }
  /** Exact count if a real tokenizer is attached, else estimate. Result is flagged. */
  async countExact(text) {
    if (!this.exact) return { tokens: this.count(text), exact: false };
    const k = "x" + hash53(text) + ":" + text.length;
    const hit = this.cache.get(k);
    if (hit !== undefined) { this.cached++; return { tokens: hit, exact: true }; }
    const n = await this.exact(text); this.computed++; this.cache.set(k, n);
    return { tokens: n, exact: true };
  }
  /** Fit `scale` so estimates match the real tokenizer over sample texts. */
  async calibrate(samples) {
    if (!this.exact) return this.scale;
    let est = 0, real = 0;
    for (const s of samples) { est += estimateTokens(s, 1); real += await this.exact(s); }
    this.scale = real / Math.max(1, est); this.cache.clear(); return this.scale;
  }
  /** Truncate text to ~`max` tokens at a line/word boundary (head). */
  truncate(text, max) {
    if (this.count(text) <= max) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.count(text.slice(0, mid)) <= max) lo = mid; else hi = mid - 1; }
    const cut = text.slice(0, lo); const nl = cut.lastIndexOf("\n");
    return nl > lo * 0.6 ? cut.slice(0, nl) : cut;
  }
}
