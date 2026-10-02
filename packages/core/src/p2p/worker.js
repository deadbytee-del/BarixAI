// WorkerHost: the volunteer side. Nothing happens unless the owner explicitly starts it with consent;
// every peer is authorized; load, size and rate are bounded; every request is surfaced via onActivity
// so the owner can always see (and stop) what their machine is doing. Never runs silently.
import { BarixError, uid } from "../util/misc.js";
import { makeAdvert, validateMessage, msg, MAX_MESSAGE_BYTES } from "./protocol.js";
import { f32ToB64, toB64 } from "./assets.js";
import { chunkFile } from "../code/chunker.js";
import { TokenCounter } from "../tokens/counter.js";

export class WorkerHost {
  /**
   * @param {{workerId?:string, name?:string, provider?:any, embedder?:any, hardware?:object, maxConcurrent?:number, maxPromptTokens?:number, maxOutputTokens?:number,
   *   authorize?:(peer:{name:string, token?:string})=>boolean|Promise<boolean>, onActivity?:(e:object)=>void, assets?:import("./assets.js").AssetCache,
   *   requestsPerMinute?:number, advertEveryMs?:number}} o
   */
  constructor({ workerId = uid("w"), name = "Barix worker", provider = null, embedder = null, hardware, maxConcurrent = 1, maxPromptTokens = 32768, maxOutputTokens = 4096, authorize = () => false, onActivity = () => {}, assets = null, requestsPerMinute = 30, advertEveryMs = 5000 } = {}) {
    Object.assign(this, { workerId, name, provider, embedder, hardware, maxConcurrent, maxPromptTokens, maxOutputTokens, authorize, onActivity, assets, requestsPerMinute, advertEveryMs });
    this.sessions = new Set(); this.active = 0; this.running = false; this.draining = false; this.counter = new TokenCounter(); this.served = { requests: 0, tokens: 0 };
  }
  /** `consent` must be literally true: the owner pressed "Start sharing". */
  start({ consent } = {}) {
    if (consent !== true) throw new BarixError("EWORKERCONSENT", "a Barix worker only runs after its owner explicitly consents");
    this.running = true; this.onActivity({ type: "started", workerId: this.workerId, services: this.advert().services });
    this._timer = setInterval(() => this.#broadcast(), this.advertEveryMs); this._timer.unref?.();
  }
  stop() { this.running = false; clearInterval(this._timer); for (const s of [...this.sessions]) s.close("worker stopped"); this.onActivity({ type: "stopped" }); }
  drain() { this.draining = true; this.#broadcast(); }
  advert() { return makeAdvert({ workerId: this.workerId, name: this.name, provider: this.provider, embedder: this.embedder, hardware: this.hardware, maxConcurrent: this.maxConcurrent, active: this.active, availability: this.draining ? "draining" : this.active >= this.maxConcurrent ? "busy" : "idle", cache: this.assets?.stats() }); }
  #broadcast() { for (const s of this.sessions) if (s.authed) { try { s.transport.send(msg("advert", { advert: this.advert() })); } catch { /* peer gone */ } } }

  /** Attach a peer connection. */
  accept(transport) {
    if (!this.running) { try { transport.send(msg("error", { id: "0", code: "ENOTRUNNING", message: "worker is not accepting connections" })); } catch {} transport.close(); return null; }
    const session = { transport, authed: false, peer: null, inflight: new Map(), times: [], close: (why) => { for (const c of session.inflight.values()) c.abort(); try { transport.send(msg("bye", { reason: why })); } catch {} transport.close(); } };
    this.sessions.add(session);
    transport.onClose(() => { for (const c of session.inflight.values()) c.abort(); this.sessions.delete(session); this.onActivity({ type: "peer-left", peer: session.peer?.name }); });
    transport.onMessage((m) => this.#onMessage(session, m).catch((e) => { try { transport.send(msg("error", { id: m?.id ?? "0", code: e.code ?? "EWORKER", message: e.message })); } catch {} }));
    return session;
  }

  async #onMessage(s, raw) {
    const m = validateMessage(raw); const send = (x) => s.transport.send(x);
    if (m.t === "hello") {
      const ok = await this.authorize({ name: m.name, token: m.token, workerId: m.peerId });
      if (!ok) { send(msg("error", { id: "0", code: "EDENIED", message: "this worker's owner has not authorized you" })); s.transport.close(); this.onActivity({ type: "peer-denied", peer: m.name }); return; }
      s.authed = true; s.peer = { name: m.name }; send(msg("advert", { advert: this.advert() })); this.onActivity({ type: "peer-joined", peer: m.name }); return;
    }
    if (!s.authed) throw new BarixError("EDENIED", "send hello first");
    if (m.t === "ping") return send(msg("pong", { id: m.id, ts: m.ts, advert: this.advert() }));
    if (m.t === "cancel") { s.inflight.get(m.id)?.abort(); return; }
    if (m.t === "asset-get") {
      const bytes = this.assets?.get(m.hash); if (!bytes) return send(msg("error", { id: m.id, code: "ENOASSET", message: "asset not cached here" }));
      if (bytes.length > MAX_MESSAGE_BYTES * 8) return send(msg("error", { id: m.id, code: "ETOOBIG", message: "asset too large for this transport" }));
      return send(msg("asset-data", { id: m.id, hash: m.hash, data: toB64(bytes) }));
    }
    if (m.t !== "request") return;
    // rate + load limits
    const now = Date.now(); s.times = s.times.filter((t) => now - t < 60_000); if (s.times.length >= this.requestsPerMinute) throw new BarixError("ERATELIMIT", "per-peer rate limit reached; slow down");
    if (this.draining) throw new BarixError("EBUSY", "worker is draining");
    if (this.active >= this.maxConcurrent) throw new BarixError("EBUSY", "worker is at capacity", { retryAfter: 2 });
    if (!this.advert().services.includes(m.service)) throw new BarixError("ENOSERVICE", `this worker does not offer ${m.service}`);
    s.times.push(now); this.active++; const ac = new AbortController(); s.inflight.set(m.id, ac); this.served.requests++;
    this.onActivity({ type: "request-start", peer: s.peer.name, service: m.service, id: m.id, active: this.active });
    try {
      if (m.service === "inference") await this.#inference(m, ac, send);
      else if (m.service === "embeddings") await this.#embeddings(m, send);
      else if (m.service === "index") await this.#index(m, send);
      else throw new BarixError("ENOSERVICE", m.service);
    } finally { this.active--; s.inflight.delete(m.id); this.onActivity({ type: "request-end", peer: s.peer.name, id: m.id, active: this.active }); this.#broadcast(); }
  }
  async #inference(m, ac, send) {
    const p = m.payload; if (!this.provider) throw new BarixError("ENOSERVICE", "no model");
    const promptTok = p.messages.reduce((a, x) => a + this.counter.count(x.content), 0);
    if (promptTok > Math.min(this.maxPromptTokens, this.provider.caps.window)) throw new BarixError("ECONTEXT", `prompt (~${promptTok} tokens) exceeds this worker's limit`);
    const req = { messages: p.messages, maxTokens: Math.min(p.maxTokens ?? 512, this.maxOutputTokens), temperature: p.temperature ?? 0, topP: p.topP, stop: p.stop, reasoning: p.reasoning, signal: ac.signal };
    let out = 0, sawDone = false;
    try { for await (const e of this.provider.generate(req)) { if (e.type === "token") out++; if (e.type === "done") sawDone = true; send(msg("event", { id: m.id, e })); if (ac.signal.aborted && !sawDone) break; } }
    finally { if (!sawDone) { try { send(msg("event", { id: m.id, e: { type: "done", finishReason: ac.signal.aborted ? "abort" : "stop" } })); } catch { /* peer gone */ } } }
    this.served.tokens += out;
  }
  async #embeddings(m, send) {
    const texts = m.payload.texts.slice(0, 256); const vecs = await this.embedder.embed(texts, { query: !!m.payload.query });
    send(msg("event", { id: m.id, e: { type: "vectors", dim: vecs[0]?.length ?? 0, data: vecs.map(f32ToB64) } })); send(msg("event", { id: m.id, e: { type: "done", finishReason: "stop" } }));
  }
  /** Repository indexing offload: chunk + embed public files, return vectors for the client to merge. */
  async #index(m, send) {
    const files = (m.payload.files ?? []).slice(0, 500); let total = 0; const out = [];
    for (const f of files) { total += f.text.length; if (total > 8_000_000) break; for (const c of chunkFile(f.path, f.text, { counter: this.counter, maxTokens: m.payload.chunkTokens ?? 400 })) out.push({ id: c.id, path: c.path, startLine: c.startLine, endLine: c.endLine, header: c.header, names: c.names, tokens: c.tokens, text: c.text }); }
    for (let i = 0; i < out.length; i += 32) { const batch = out.slice(i, i + 32); const vecs = await this.embedder.embed(batch.map((c) => c.header + "\n" + c.text)); send(msg("event", { id: m.id, e: { type: "chunks", chunks: batch.map((c, k) => ({ ...c, vec: f32ToB64(vecs[k]) })) } })); }
    send(msg("event", { id: m.id, e: { type: "done", finishReason: "stop", chunks: out.length, embedderId: this.embedder.id } }));
  }
}
