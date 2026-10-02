// Embedders. Interface: { id, dim, embed(texts:string[], {query?:boolean}) -> Promise<Float32Array[]> }
// Two implementations:
//   HashEmbedder          zero-download, deterministic feature-hashing embedder over identifier sub-words,
//                         bigrams and char-trigrams. Captures lexical/morphological similarity ONLY (no
//                         synonyms) — it is the always-available baseline and offline fallback.
//   TransformersEmbedder  real neural sentence embeddings via Transformers.js (ONNX, WASM/WebGPU/Node).
import { hash53 } from "../util/hash.js";
import { analyze } from "./text.js";
import { normalize } from "./vector-index.js";

export class HashEmbedder {
  constructor({ dim = 384 } = {}) { this.dim = dim; this.id = `barix-hash-${dim}`; }
  async embed(texts) { return texts.map((t) => this.embedOne(t)); }
  embedOne(text) {
    const v = new Float32Array(this.dim);
    const add = (feat, w) => { const h = hash53(feat); const i = h % this.dim; v[i] += ((h / this.dim) & 1 ? 1 : -1) * w; };
    const toks = analyze(text, { dropCodeStop: false });
    const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, c] of tf) {
      add("w:" + t, 1 + Math.log(c));
      if (t.length >= 5) for (let i = 0; i + 3 <= t.length; i++) add("c:" + t.slice(i, i + 3), 0.25); // morphology
    }
    for (let i = 0; i + 1 < toks.length; i++) add("b:" + toks[i] + " " + toks[i + 1], 0.4);
    return normalize(v);
  }
}

export class TransformersEmbedder {
  /**
   * @param {{loadTransformers:()=>Promise<any>, model?:string, dtype?:string, device?:string, dim?:number,
   *          queryPrefix?:string, docPrefix?:string, batchSize?:number, progress?:Function}} o
   */
  constructor({ loadTransformers, model = "Xenova/all-MiniLM-L6-v2", dtype = "q8", device, dim = 384, queryPrefix = "", docPrefix = "", batchSize = 16, progress } = {}) {
    Object.assign(this, { loadTransformers, model, dtype, device, dim, queryPrefix, docPrefix, batchSize, progress });
    this.id = `tjs:${model}:${dtype}`; this._pipe = null;
  }
  async #pipe() {
    if (!this._pipe) this._pipe = (async () => {
      const tf = await this.loadTransformers();
      return tf.pipeline("feature-extraction", this.model, { dtype: this.dtype, ...(this.device ? { device: this.device } : {}), progress_callback: this.progress });
    })();
    return this._pipe;
  }
  async embed(texts, { query = false } = {}) {
    const pipe = await this.#pipe(); const pre = query ? this.queryPrefix : this.docPrefix; const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => pre + t);
      const t = await pipe(batch, { pooling: "mean", normalize: true });
      const [n, d] = t.dims; this.dim = d;
      for (let r = 0; r < n; r++) out.push(Float32Array.from(t.data.subarray(r * d, (r + 1) * d)));
    }
    return out;
  }
}
