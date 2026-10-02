/** Size-bounded LRU. `sizeOf` lets callers bound by bytes/tokens instead of entry count. */
export class LRU {
  constructor(maxSize = 1000, sizeOf = () => 1) {
    this.max = maxSize; this.sizeOf = sizeOf; this.size = 0; this.map = new Map();
    this.hits = 0; this.misses = 0;
  }
  get(k) {
    if (!this.map.has(k)) { this.misses++; return undefined; }
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); this.hits++; return v;
  }
  has(k) { return this.map.has(k); }
  set(k, v) {
    if (this.map.has(k)) { this.size -= this.sizeOf(this.map.get(k)); this.map.delete(k); }
    this.map.set(k, v); this.size += this.sizeOf(v);
    while (this.size > this.max && this.map.size > 1) {
      const [ok, ov] = this.map.entries().next().value;
      this.map.delete(ok); this.size -= this.sizeOf(ov);
    }
    return this;
  }
  delete(k) { if (this.map.has(k)) { this.size -= this.sizeOf(this.map.get(k)); this.map.delete(k); } }
  clear() { this.map.clear(); this.size = 0; }
  get stats() { return { entries: this.map.size, size: this.size, hits: this.hits, misses: this.misses }; }
}
