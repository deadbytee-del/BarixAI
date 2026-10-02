// Flat vector index with int8 scalar quantization (4x less memory than Float32) and
// exact cosine search. Rows live in one growable Int8Array (no per-vector objects -> low GC pressure).
// Exact search stays fast to ~10^5-10^6 vectors in a worker; beyond that, shard or swap in an ANN index
// behind the same interface.
export class VectorIndex {
  constructor(dim, { capacity = 1024, quantize = true } = {}) {
    this.dim = dim; this.quantize = quantize; this.cap = capacity; this.count = 0;
    this.data = quantize ? new Int8Array(capacity * dim) : new Float32Array(capacity * dim);
    this.scale = new Float32Array(capacity); this.idOf = new Array(capacity); this.rowOf = new Map(); this.free = [];
  }
  get size() { return this.rowOf.size; }
  #grow() {
    const nc = this.cap * 2, nd = this.quantize ? new Int8Array(nc * this.dim) : new Float32Array(nc * this.dim);
    nd.set(this.data); this.data = nd; const ns = new Float32Array(nc); ns.set(this.scale); this.scale = ns; this.cap = nc;
  }
  /** `vec` must be L2-normalized (embedders guarantee this). */
  add(id, vec) {
    if (vec.length !== this.dim) throw new Error(`vector dim ${vec.length} != index dim ${this.dim}`);
    let row = this.rowOf.get(id);
    if (row === undefined) { row = this.free.pop() ?? this.count++; if (row >= this.cap) this.#grow(); this.rowOf.set(id, row); this.idOf[row] = id; }
    const off = row * this.dim;
    if (this.quantize) {
      let max = 0; for (let i = 0; i < this.dim; i++) { const a = Math.abs(vec[i]); if (a > max) max = a; }
      const s = max / 127 || 1; this.scale[row] = s;
      for (let i = 0; i < this.dim; i++) this.data[off + i] = Math.round(vec[i] / s);
    } else for (let i = 0; i < this.dim; i++) this.data[off + i] = vec[i];
  }
  remove(id) { const row = this.rowOf.get(id); if (row === undefined) return false; this.rowOf.delete(id); this.idOf[row] = undefined; this.free.push(row); return true; }
  has(id) { return this.rowOf.has(id); }
  get(id) {
    const row = this.rowOf.get(id); if (row === undefined) return null;
    const out = new Float32Array(this.dim), off = row * this.dim, s = this.quantize ? this.scale[row] : 1;
    for (let i = 0; i < this.dim; i++) out[i] = this.data[off + i] * s; return out;
  }
  search(q, { k = 20, filter, minScore = -1 } = {}) {
    const { dim, data, quantize, scale } = this; const heap = []; // small sorted array: k is tiny
    let worst = -Infinity;
    for (const [id, row] of this.rowOf) {
      if (filter && !filter(id)) continue;
      const off = row * dim; let dot = 0;
      for (let i = 0; i < dim; i++) dot += q[i] * data[off + i];
      const score = quantize ? dot * scale[row] : dot;
      if (score < minScore || (heap.length >= k && score <= worst)) continue;
      let p = heap.length; heap.push({ id, score });
      while (p > 0 && heap[p - 1].score < score) { heap[p] = heap[p - 1]; p--; } heap[p] = { id, score };
      if (heap.length > k) heap.pop(); worst = heap[heap.length - 1].score;
    }
    return heap;
  }
  memoryBytes() { return this.data.byteLength + this.scale.byteLength; }
  toBuffer() {
    const ids = []; const rows = []; for (const [id, r] of this.rowOf) { ids.push(id); rows.push(r); }
    const out = this.quantize ? new Int8Array(ids.length * this.dim) : new Float32Array(ids.length * this.dim), sc = new Float32Array(ids.length);
    rows.forEach((r, i) => { out.set(this.data.subarray(r * this.dim, (r + 1) * this.dim), i * this.dim); sc[i] = this.scale[r]; });
    return { meta: { v: 1, dim: this.dim, quantize: this.quantize, ids }, data: out, scale: sc };
  }
  static fromBuffer({ meta, data, scale }) {
    const x = new VectorIndex(meta.dim, { capacity: Math.max(16, meta.ids.length), quantize: meta.quantize });
    x.data.set(data); x.scale.set(scale); meta.ids.forEach((id, i) => { x.rowOf.set(id, i); x.idOf[i] = id; }); x.count = meta.ids.length; return x;
  }
}

export function normalize(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; }
export function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
