// Barix provider router: chooses compute for each request from everything available (browser-local
// inference, the user's machine, opt-in Barix workers, public inference endpoints). It scores by
// capability fit, health, latency, throughput, load, privacy preference and remaining quota; fails over
// on errors; opens circuit breakers on repeated failure; and never exceeds a provider's rate limit.
import { BarixError, now as perfNow } from "../util/misc.js";
import { RateLimiter, UsageTracker } from "./usage.js";

const KIND_RANK = { "browser-local": 0, "local-machine": 1, "barix-worker": 2, "p2p": 2, "public-inference": 3, mock: 9 };
export const MONTHLY_CAPACITY_TARGET = 500_000_000;

export class Router {
  /** @param {{usage?:UsageTracker, strategy?:"privacy"|"quality"|"speed", clock?:()=>number}} o */
  constructor({ usage = new UsageTracker(), strategy = "privacy", clock = () => Date.now() } = {}) {
    this.usage = usage; this.limiter = new RateLimiter(usage, { now: clock }); this.strategy = strategy; this.clock = clock;
    this.providers = new Map(); this.stats = new Map(); this.events = [];
  }
  register(provider, { limits, enabled = true } = {}) {
    this.providers.set(provider.id, provider); this.stats.set(provider.id, { latency: null, tps: null, failures: 0, consecutive: 0, openUntil: 0, trips: 0, enabled, lastError: null, served: 0 });
    if (limits) this.limiter.setLimits(provider.id, limits); return this;
  }
  unregister(id) { this.providers.delete(id); this.stats.delete(id); }
  setEnabled(id, v) { const s = this.stats.get(id); if (s) s.enabled = v; }
  #log(e) { this.events.push({ t: this.clock(), ...e }); if (this.events.length > 500) this.events.shift(); }

  /** Rank candidates for a request. `needs` = {promptTokens, maxTokens, vision}. */
  async rank(needs = {}) {
    const { promptTokens = 0, maxTokens = 512, vision = false } = needs; const out = [], rejected = [];
    for (const p of this.providers.values()) {
      const st = this.stats.get(p.id); const reject = (why) => rejected.push({ id: p.id, why });
      if (!st.enabled) { reject("disabled"); continue; }
      if (st.openUntil > this.clock()) { reject(`circuit open for ${Math.ceil((st.openUntil - this.clock()) / 1000)}s (${st.lastError})`); continue; }
      if (vision && !p.caps.vision) { reject("no vision support"); continue; }
      if (promptTokens + Math.min(maxTokens, 256) > p.caps.window) { reject(`window ${p.caps.window} < prompt ${promptTokens}`); continue; }
      const lim = this.limiter.check(p.id, promptTokens + maxTokens); if (!lim.ok) { reject(lim.reason); continue; }
      let h = { ok: true }; try { h = (await Promise.race([p.health?.() ?? { ok: true }, new Promise((r) => setTimeout(() => r({ ok: false, reason: "health timeout" }), 1500))])); } catch (e) { h = { ok: false, reason: e.message }; }
      if (!h.ok) { reject(`unhealthy: ${h.reason ?? "?"}`); continue; }
      const kind = KIND_RANK[p.kind] ?? 5, lat = st.latency ?? h.latencyMs ?? 500, tps = st.tps ?? p.caps.tps ?? 10, load = h.load ?? 0;
      const W = { privacy: { kind: 40, lat: 0.01, tps: 0.5, q: 10 }, quality: { kind: 5, lat: 0.005, tps: 0.2, q: 60 }, speed: { kind: 5, lat: 0.03, tps: 2, q: 5 } }[this.strategy];
      const score = 100 - kind * W.kind - lat * W.lat + Math.min(tps, 80) * W.tps + (p.caps.quality ?? 0.5) * W.q - load * 30 - st.consecutive * 15;
      out.push({ provider: p, score, why: { kind: p.kind, latency: Math.round(lat), tps: +tps.toFixed(1), load } });
    }
    out.sort((a, b) => b.score - a.score); out.rejected = rejected; return out;
  }

  /**
   * Stream a generation with automatic failover.
   * Emits provider events plus {type:"route", provider} and {type:"failover", from, reason, reset}.
   */
  async *generate(req, needs = {}) {
    const exclude = new Set(); let attempt = 0; let partial = "";
    for (;;) {
      const ranked = (await this.rank(needs)).filter((c) => !exclude.has(c.provider.id));
      if (!ranked.length) {
        const all = (await this.rank(needs)).rejected; const eta = Math.min(...[...this.stats.values()].map((s) => (s.openUntil > this.clock() ? s.openUntil - this.clock() : Infinity)), Infinity);
        throw new BarixError("ECAPACITY", `no provider can serve this request${partial ? " (generation interrupted)" : ""}: ${all.map((r) => `${r.id}: ${r.why}`).join("; ") || "none registered"}`, { retryAfterMs: Number.isFinite(eta) ? eta : undefined, partial });
      }
      const { provider, why } = ranked[0]; const st = this.stats.get(provider.id);
      this.#log({ type: "route", provider: provider.id, why }); yield { type: "route", provider: provider.id, kind: provider.kind, model: provider.caps.model, why, attempt };
      const t0 = perfNow(); let first = null, tokens = 0, usage = null, buf = "";
      try {
        const r = partial && provider.caps.prefill ? { ...req, prefill: partial } : req;
        for await (const e of provider.generate(r)) {
          if (e.type === "token") { if (first === null) first = perfNow() - t0; tokens++; buf += e.text; }
          if (e.type === "usage") usage = e;
          if (e.type === "done" && e.finishReason === "error") throw new BarixError("EPROVIDER", e.message ?? "provider reported error");
          yield e;
        }
        const secs = (perfNow() - t0) / 1000; st.latency = ewma(st.latency, first ?? secs * 1000); st.tps = ewma(st.tps, tokens / Math.max(0.001, secs - (first ?? 0) / 1000)); st.consecutive = 0; st.served++;
        await this.usage.record(provider.id, { promptTokens: usage?.promptTokens ?? needs.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? tokens, ms: secs * 1000 });
        return;
      } catch (e) {
        if (e.name === "AbortError" || req.signal?.aborted) throw e;
        st.failures++; st.consecutive++; st.lastError = e.message?.slice(0, 120);
        if (e.code === "ERATELIMIT" || e.status === 429 || e.status === 503) { const ms = this.limiter.penalize(provider.id, e.retryAfter); st.openUntil = this.clock() + ms; this.#log({ type: "ratelimited", provider: provider.id, ms }); }
        else if (st.consecutive >= 3) { st.trips++; st.openUntil = this.clock() + Math.min(600_000, 30_000 * 2 ** (st.trips - 1)); this.#log({ type: "circuit-open", provider: provider.id }); }
        await this.usage.record(provider.id, { ok: false });
        exclude.add(provider.id); attempt++;
        partial += buf; const canResume = ranked.slice(1).some((c) => c.provider.caps.prefill) && partial;
        yield { type: "failover", from: provider.id, reason: e.message, reset: !canResume }; if (!canResume) partial = "";
        if (attempt > 6) throw e;
      }
    }
  }

  status() {
    return [...this.providers.values()].map((p) => { const s = this.stats.get(p.id); return { id: p.id, kind: p.kind, model: p.caps.model, window: p.caps.window, enabled: s.enabled, circuitOpen: s.openUntil > this.clock(), latencyMs: s.latency && Math.round(s.latency), tps: s.tps && +s.tps.toFixed(1), served: s.served, failures: s.failures, monthTokens: this.usage.monthTokens(p.id) }; });
  }
  /** Honest capacity picture: what has been used vs the monthly target; no claims about what providers "guarantee". */
  capacity() {
    const u = this.usage.summary(); const bounded = [...this.providers.keys()].map((id) => this.limiter.limits.get(id)?.monthlyTokens ?? Infinity);
    const declared = bounded.some((b) => b === Infinity) ? null : bounded.reduce((a, b) => a + b, 0);
    return { target: MONTHLY_CAPACITY_TARGET, usedThisMonth: u.totalTokens, percentOfTarget: +(u.totalTokens / MONTHLY_CAPACITY_TARGET * 100).toFixed(3), declaredQuotaTotal: declared, note: declared === null ? "some providers have no declared quota (e.g. local compute); total capacity is not bounded by quotas but by hardware" : declared >= MONTHLY_CAPACITY_TARGET ? "declared quotas cover the target" : "declared quotas are below the target; add capacity sources", perProvider: u.perProvider };
  }
}
const ewma = (prev, x) => (prev == null ? x : prev * 0.7 + x * 0.3);
