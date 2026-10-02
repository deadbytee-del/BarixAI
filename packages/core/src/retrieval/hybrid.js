// HybridIndex: lexical (BM25) + semantic (vector) + symbol retrieval, fused by weighted Reciprocal
// Rank Fusion and diversified with MMR. The index stores NO document text — only small metadata —
// so million-token corpora don't live in RAM; callers supply `loadText(id)` when text is needed.
import { BM25Index } from "./bm25.js";
import { VectorIndex, cosine } from "./vector-index.js";
import { LRU } from "../util/lru.js";
import { hash53 } from "../util/hash.js";
import { wordSet, jaccard } from "./text.js";

export class HybridIndex {
  /**
   * @param {{embedder?:{id:string,dim:number,embed:Function}, quantize?:boolean, embedCache?:LRU, weights?:{lexical:number,vector:number,symbol:number}}} o
   */
  constructor({ embedder = null, quantize = true, embedCache, weights } = {}) {
    this.embedder = embedder; this.quantize = quantize; this.w = { lexical: 1, vector: 1, symbol: 1.5, ...weights };
    this.bm25 = new BM25Index(); this.vectors = embedder ? new VectorIndex(embedder.dim, { quantize }) : null;
    this.meta = new Map(); this.pending = []; this.embedCache = embedCache ?? new LRU(200_000);
    this.stats = { embedded: 0, embedCacheHits: 0, searches: 0 };
  }
  get size() { return this.meta.size; }

  /** Add or replace a document. Lexical indexing is immediate; embedding is batched (see flush). */
  add({ id, text, header = "", names = [], meta = {} }) {
    this.meta.set(id, { id, header, names, ...meta, _words: undefined });
    this.bm25.add(id, [{ text: header, boost: 2 }, { text: names.join(" "), boost: 3 }, { text }]);
    if (this.embedder) {
      const key = this.embedder.id + ":" + hash53(header + "\n" + text) + ":" + text.length;
      const hit = this.embedCache.get(key);
      if (hit) { this.#putVec(id, hit); this.stats.embedCacheHits++; }
      else this.pending.push({ id, key, text: (header ? header + "\n" : "") + text });
    }
    return this;
  }
  #putVec(id, v) { if (this.vectors.dim !== v.length) this.vectors = new VectorIndex(v.length, { quantize: this.quantize }); this.vectors.add(id, v); }
  remove(id) { this.meta.delete(id); this.bm25.remove(id); this.vectors?.remove(id); this.pending = this.pending.filter((p) => p.id !== id); }
  /** Embed everything queued. Batches by `batch` docs to bound latency/memory. */
  async flush({ batch = 32, signal, onProgress } = {}) {
    if (!this.embedder) return 0; let n = 0;
    while (this.pending.length) {
      if (signal?.aborted) break;
      const take = this.pending.splice(0, batch);
      const vecs = await this.embedder.embed(take.map((p) => p.text), { query: false });
      take.forEach((p, i) => { if (this.meta.has(p.id)) { this.#putVec(p.id, vecs[i]); this.embedCache.set(p.key, vecs[i]); } });
      n += take.length; this.stats.embedded += take.length; onProgress?.({ done: n, remaining: this.pending.length });
    }
    return n;
  }

  /**
   * @param {string} query
   * @param {{k?:number, filter?:(id:string, meta:object)=>boolean, symbolHits?:Map<string,number>|((q:string)=>Map<string,number>), mmr?:number|false, minScore?:number}} [o]
   */
  async search(query, { k = 10, filter, symbolHits, mmr = 0.75, pool = Math.max(k * 4, 30) } = {}) {
    this.stats.searches++;
    const f = filter ? (id) => filter(id, this.meta.get(id)) : undefined;
    const [lex, vec] = await Promise.all([
      Promise.resolve(this.bm25.search(query, { k: pool, filter: f })),
      this.vectors?.size ? this.embedder.embed([query], { query: true }).then(([qv]) => this.vectors.search(qv, { k: pool, filter: f })) : [],
    ]);
    const sym = typeof symbolHits === "function" ? symbolHits(query) : symbolHits;
    const fused = new Map(); const RRF = 60;
    const bump = (id, rank, w, src, raw) => { const e = fused.get(id) ?? fused.set(id, { id, score: 0, sources: {} }).get(id); e.score += w / (RRF + rank); e.sources[src] = { rank, score: raw }; };
    lex.forEach((r, i) => bump(r.id, i + 1, this.w.lexical, "lexical", r.score));
    vec.forEach((r, i) => bump(r.id, i + 1, this.w.vector, "vector", r.score));
    if (sym) [...sym].sort((a, b) => b[1] - a[1]).forEach(([id, s], i) => { if (this.meta.has(id) && (!f || f(id))) bump(id, i + 1, this.w.symbol, "symbol", s); });
    let ranked = [...fused.values()].sort((a, b) => b.score - a.score);
    if (mmr !== false && ranked.length > 1) ranked = this.#mmr(ranked.slice(0, pool), k, mmr);
    return ranked.slice(0, k).map((r) => ({ ...r, ...this.meta.get(r.id) }));
  }
  #mmr(cands, k, lambda) {
    const top = cands[0].score || 1; const picked = []; const rest = cands.map((c) => ({ ...c, rel: c.score / top }));
    const sim = (a, b) => {
      if (this.vectors?.has(a.id) && this.vectors.has(b.id)) return cosine(this.vectors.get(a.id), this.vectors.get(b.id));
      return jaccard(a._w ??= wordSet(a.id + " " + (this.meta.get(a.id)?.header ?? "")), b._w ??= wordSet(b.id + " " + (this.meta.get(b.id)?.header ?? ""))) * 0.6;
    };
    while (picked.length < k && rest.length) {
      let bi = 0, bs = -Infinity;
      for (let i = 0; i < rest.length; i++) {
        let maxSim = 0; for (const p of picked) maxSim = Math.max(maxSim, sim(rest[i], p));
        if (maxSim > 0.97) { rest[i].rel *= 0.2; }  // near-duplicate => demote hard
        const s = lambda * rest[i].rel - (1 - lambda) * maxSim;
        if (s > bs) { bs = s; bi = i; }
      }
      picked.push(rest.splice(bi, 1)[0]);
    }
    return picked.map(({ rel, _w, ...r }) => r);
  }

  // ---- persistence (index only; text is never stored here) ----
  serialize() { return { v: 1, embedderId: this.embedder?.id ?? null, meta: [...this.meta], bm25: this.bm25.toJSON(), vectors: this.vectors?.toBuffer() ?? null }; }
  static deserialize(s, { embedder } = {}) {
    const x = new HybridIndex({ embedder });
    x.meta = new Map(s.meta); x.bm25 = BM25Index.fromJSON(s.bm25);
    if (s.vectors && embedder && s.embedderId === embedder.id) x.vectors = VectorIndex.fromBuffer(s.vectors);
    else if (embedder) { x.vectors = new VectorIndex(embedder.dim); x.needsReembed = true; }
    return x;
  }
}
