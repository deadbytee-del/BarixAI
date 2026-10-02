// Client side of the worker protocol: turns a connection to a volunteer worker into a normal Barix
// Provider (so the router can pick it like any other compute), plus an embedder, an index-offload call
// and verified asset fetching. P2P is optional: nothing here is needed for basic Barix.
import { BarixError, uid, now } from "../util/misc.js";
import { validateMessage, msg } from "./protocol.js";
import { b64ToF32, fromB64 } from "./assets.js";
import { sha256Hex } from "../util/hash.js";

export class RemoteWorker {
  constructor(transport, { name = "Barix client", token, timeoutMs = 8000 } = {}) {
    Object.assign(this, { transport, name, token, timeoutMs }); this.advert = null; this.latencyMs = null; this.pending = new Map(); this.closed = false; this.listeners = new Set();
    transport.onMessage((raw) => this.#onMessage(raw)); transport.onClose(() => { this.closed = true; for (const p of this.pending.values()) p.fail(new BarixError("ECLOSED", "worker connection closed")); this.listeners.forEach((l) => l({ type: "closed" })); });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async connect() {
    await this.transport.ready; const t0 = now();
    const adv = new Promise((res, rej) => { this._advRes = res; setTimeout(() => rej(new BarixError("ETIMEOUT", "worker did not answer hello")), this.timeoutMs); });
    this.transport.send(msg("hello", { name: this.name, token: this.token, peerId: uid("c") }));
    this.advert = await adv; this.latencyMs = now() - t0; return this;
  }
  #onMessage(raw) {
    let m; try { m = validateMessage(raw); } catch { return; }
    if (m.t === "advert") { this.advert = m.advert; this._advRes?.(m.advert); this._advRes = null; this.listeners.forEach((l) => l({ type: "advert", advert: m.advert })); return; }
    if (m.t === "pong") { this.latencyMs = now() - m.ts; if (m.advert) this.advert = m.advert; this.pending.get(m.id)?.done(m); return; }
    if (m.t === "error" && m.id === "0") { this._advRes = null; this.listeners.forEach((l) => l({ type: "error", error: m })); for (const p of this.pending.values()) p.fail(new BarixError(m.code, m.message)); return; }
    const p = this.pending.get(m.id); if (!p) return;
    if (m.t === "event") p.push(m.e); else if (m.t === "error") p.fail(new BarixError(m.code ?? "EWORKER", m.message, { retryAfter: m.retryAfter })); else if (m.t === "asset-data") p.done(m);
  }
  async ping() { const id = uid("p"); return new Promise((res, rej) => { const to = setTimeout(() => { this.pending.delete(id); rej(new BarixError("ETIMEOUT", "ping timeout")); }, this.timeoutMs); this.pending.set(id, { done: (m) => { clearTimeout(to); this.pending.delete(id); res(m); }, fail: rej, push() {} }); this.transport.send(msg("ping", { id, ts: now() })); }); }

  /** Generic streaming request -> async iterator of events. */
  async *#stream(service, payload, signal) {
    const id = uid("r"); const q = []; let wake = null, err = null, finished = false;
    this.pending.set(id, { push: (e) => { q.push(e); wake?.(); wake = null; if (e.type === "done") finished = true; }, fail: (e) => { err = e; wake?.(); wake = null; }, done() {} });
    const onAbort = () => { try { this.transport.send(msg("cancel", { id })); } catch {} }; signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.transport.send(msg("request", { id, service, payload }));
      for (;;) {
        while (q.length) { const e = q.shift(); yield e; if (e.type === "done") return; }
        if (err) throw err; if (finished) return; if (this.closed) throw new BarixError("ECLOSED", "worker disconnected");
        await new Promise((r) => (wake = r));
      }
    } finally { this.pending.delete(id); signal?.removeEventListener("abort", onAbort); }
  }

  /** A Barix Provider backed by this worker. */
  provider({ kind = "barix-worker", id } = {}) {
    const w = this; const a = () => w.advert; const model = a().models[0];
    return {
      get id() { return id ?? `worker:${a().workerId}`; }, kind,
      caps: { model: model?.id ?? "unknown", family: model?.family ?? "unknown", quant: model?.quant, window: model?.window ?? 0, maxOutput: model?.maxOutput ?? 0, vision: !!model?.vision, streaming: true, quality: 0.5, hardware: a().hardware?.kind, remote: true, tps: model?.tps, prefill: false },
      async health() { if (w.closed) return { ok: false, reason: "disconnected" }; const ad = a(); if (ad.availability === "draining") return { ok: false, reason: "worker draining" }; if (ad.active >= ad.maxConcurrent) return { ok: false, reason: "worker busy" }; return { ok: true, latencyMs: w.latencyMs ?? 200, load: ad.load }; },
      async *generate(req) {
        const { signal, ...rest } = req;
        for await (const e of w.#stream("inference", { messages: rest.messages, maxTokens: rest.maxTokens, temperature: rest.temperature, topP: rest.topP, stop: rest.stop, reasoning: rest.reasoning }, signal)) yield e;
      },
    };
  }
  embedder() {
    const w = this, e = this.advert.embedder; if (!e) return null;
    return { id: `remote:${w.advert.workerId}:${e.id}`, dim: e.dim, async embed(texts, { query = false } = {}) { const out = []; for await (const ev of w.#stream("embeddings", { texts, query })) if (ev.type === "vectors") out.push(...ev.data.map(b64ToF32)); return out; } };
  }
  /** Offload chunking+embedding of PUBLIC files; returns chunk records with Float32 vectors. */
  async indexFiles(files, { chunkTokens } = {}) {
    const out = []; let embedderId = null; for await (const ev of this.#stream("index", { files, chunkTokens })) { if (ev.type === "chunks") out.push(...ev.chunks.map((c) => ({ ...c, vec: b64ToF32(c.vec) }))); if (ev.type === "done") embedderId = ev.embedderId; } return { chunks: out, embedderId };
  }
  /** Fetch an asset by the hash we already trust; bytes are verified before being returned. */
  async fetchAsset(hash) {
    const id = uid("a"); const res = await new Promise((resolve, reject) => { this.pending.set(id, { done: resolve, fail: reject, push() {} }); this.transport.send(msg("asset-get", { id, hash })); setTimeout(() => reject(new BarixError("ETIMEOUT", "asset fetch timeout")), this.timeoutMs * 4); }).finally(() => this.pending.delete(id));
    const bytes = fromB64(res.data); const actual = await sha256Hex(bytes);
    if (actual !== hash) throw new BarixError("EINTEGRITY", "peer returned bytes that do not match the requested hash; discarded");
    return bytes;
  }
  close() { this.transport.close(); }
}

/** Keeps the Router in sync with connected workers (register on connect, unregister on close/denial). */
export class WorkerPool {
  constructor(router) { this.router = router; this.workers = new Map(); }
  async add(transport, opts) {
    const w = await new RemoteWorker(transport, opts).connect(); const p = w.provider(); this.router.register(p); this.workers.set(p.id, w);
    w.on((e) => { if (e.type === "closed") { this.router.unregister(p.id); this.workers.delete(p.id); } });
    return { id: p.id, worker: w, provider: p };
  }
  list() { return [...this.workers].map(([id, w]) => ({ id, name: w.advert.name, latencyMs: w.latencyMs, load: w.advert.load, services: w.advert.services, model: w.advert.models[0]?.id, hardware: w.advert.hardware })); }
  remove(id) { this.workers.get(id)?.close(); }
}
