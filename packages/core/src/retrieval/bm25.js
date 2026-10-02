// Incremental BM25 inverted index (Okapi BM25 with field boosting by repetition).
// Documents can be added/removed at any time without rebuilding; postings are Map<term, Map<docNum, tf>>.
import { analyze, analyzeQuery } from "./text.js";

export class BM25Index {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b; this.postings = new Map(); this.docLen = new Map(); this.ids = new Map(); this.nums = new Map();
    this.nextNum = 1; this.totalLen = 0; this.docTerms = new Map();
  }
  get size() { return this.docLen.size; }
  /** @param fields {{text:string, boost?:number}[]|string} */
  add(id, fields) {
    if (this.ids.has(id)) this.remove(id);
    const num = this.nextNum++; this.ids.set(id, num); this.nums.set(num, id);
    const tf = new Map(); let len = 0;
    for (const f of typeof fields === "string" ? [{ text: fields }] : fields) {
      const boost = f.boost ?? 1;
      for (const t of analyze(f.text)) { tf.set(t, (tf.get(t) ?? 0) + boost); len += boost; }
    }
    for (const [t, c] of tf) (this.postings.get(t) ?? this.postings.set(t, new Map()).get(t)).set(num, c);
    this.docLen.set(num, len); this.totalLen += len; this.docTerms.set(num, [...tf.keys()]);
  }
  remove(id) {
    const num = this.ids.get(id); if (num === undefined) return false;
    for (const t of this.docTerms.get(num) ?? []) { const p = this.postings.get(t); p?.delete(num); if (p && !p.size) this.postings.delete(t); }
    this.totalLen -= this.docLen.get(num) ?? 0; this.docLen.delete(num); this.docTerms.delete(num); this.ids.delete(id); this.nums.delete(num); return true;
  }
  has(id) { return this.ids.has(id); }
  search(query, { k = 20, filter } = {}) {
    const terms = analyzeQuery(query); if (!terms.length || !this.size) return [];
    const N = this.size, avg = this.totalLen / N, scores = new Map();
    const qtf = new Map(); for (const t of terms) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    for (const [t, qc] of qtf) {
      const post = this.postings.get(t); if (!post) continue;
      const idf = Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5));
      const w = idf * (1 + Math.log(qc));
      for (const [num, tf] of post) {
        const dl = this.docLen.get(num);
        scores.set(num, (scores.get(num) ?? 0) + w * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * dl / avg)));
      }
    }
    const matched = qtf.size;
    const res = [];
    for (const [num, s] of scores) { const id = this.nums.get(num); if (!filter || filter(id)) res.push({ id, score: s }); }
    res.sort((a, b) => b.score - a.score);
    return res.slice(0, k).map((r) => ({ ...r, matchedTerms: matched }));
  }
  toJSON() { return { v: 1, k1: this.k1, b: this.b, next: this.nextNum, ids: [...this.ids], len: [...this.docLen], post: [...this.postings].map(([t, m]) => [t, [...m]]) }; }
  static fromJSON(j) {
    const x = new BM25Index({ k1: j.k1, b: j.b }); x.nextNum = j.next; x.ids = new Map(j.ids);
    for (const [id, n] of x.ids) x.nums.set(n, id);
    x.docLen = new Map(j.len); x.totalLen = [...x.docLen.values()].reduce((a, c) => a + c, 0);
    for (const [t, arr] of j.post) { const m = new Map(arr); x.postings.set(t, m); for (const n of m.keys()) (x.docTerms.get(n) ?? x.docTerms.set(n, []).get(n)).push(t); }
    return x;
  }
}
