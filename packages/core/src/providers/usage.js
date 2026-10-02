// Usage tracking and rate-limit discipline. Barix never bypasses limits: every provider has an
// optional quota (monthly tokens, requests/minute, tokens/minute); when a provider says 429 / Retry-After
// the limiter honors it exactly. Totals persist so the monthly capacity picture survives restarts.
export class UsageTracker {
  /** @param {{kv?:{get:Function,set:Function}, now?:()=>number}} o */
  constructor({ kv = null, now = () => Date.now() } = {}) { this.kv = kv; this.now = now; this.data = { months: {} }; this.windows = new Map(); this.loaded = false; }
  #month() { return new Date(this.now()).toISOString().slice(0, 7); }
  async load() { if (this.kv) this.data = (await this.kv.get("usage")) ?? this.data; this.loaded = true; return this; }
  async record(providerId, { promptTokens = 0, completionTokens = 0, ms = 0, ok = true }) {
    const m = (this.data.months[this.#month()] ??= {}); const p = (m[providerId] ??= { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, ms: 0 });
    p.requests++; p.promptTokens += promptTokens; p.completionTokens += completionTokens; p.ms += ms; if (!ok) p.errors++;
    const w = this.windows.get(providerId) ?? this.windows.set(providerId, []).get(providerId); w.push({ t: this.now(), tokens: promptTokens + completionTokens }); this.#trim(w);
    if (this.kv) await this.kv.set("usage", this.data);
  }
  #trim(w) { const cut = this.now() - 60_000; while (w.length && w[0].t < cut) w.shift(); }
  monthTokens(providerId) { const p = this.data.months[this.#month()]?.[providerId]; return p ? p.promptTokens + p.completionTokens : 0; }
  minuteStats(providerId) { const w = this.windows.get(providerId) ?? []; this.#trim(w); return { requests: w.length, tokens: w.reduce((a, x) => a + x.tokens, 0) }; }
  /** Total across providers this month (progress toward the monthly capacity target). */
  summary() {
    const m = this.data.months[this.#month()] ?? {}; let total = 0; const per = {};
    for (const [id, p] of Object.entries(m)) { per[id] = { ...p, tokens: p.promptTokens + p.completionTokens }; total += per[id].tokens; }
    return { month: this.#month(), totalTokens: total, perProvider: per };
  }
}

/** Per-provider limiter: quotas + cooldowns from 429/Retry-After. `check()` never lets a call through that would exceed a limit. */
export class RateLimiter {
  constructor(usage, { now = () => Date.now() } = {}) { this.usage = usage; this.now = now; this.limits = new Map(); this.cooldown = new Map(); }
  setLimits(id, { monthlyTokens = Infinity, requestsPerMinute = Infinity, tokensPerMinute = Infinity } = {}) { this.limits.set(id, { monthlyTokens, requestsPerMinute, tokensPerMinute }); }
  /** @returns {{ok:true}|{ok:false, reason:string, retryAfterMs:number}} */
  check(id, estTokens = 0) {
    const cd = this.cooldown.get(id); if (cd && cd > this.now()) return { ok: false, reason: "cooling down after rate-limit response", retryAfterMs: cd - this.now() };
    const l = this.limits.get(id); if (!l) return { ok: true };
    const mt = this.usage.monthTokens(id); if (mt + estTokens > l.monthlyTokens) return { ok: false, reason: `monthly token quota reached (${mt}/${l.monthlyTokens})`, retryAfterMs: 86_400_000 };
    const w = this.usage.minuteStats(id);
    if (w.requests + 1 > l.requestsPerMinute) return { ok: false, reason: `requests/minute limit (${l.requestsPerMinute})`, retryAfterMs: 60_000 };
    if (w.tokens + estTokens > l.tokensPerMinute) return { ok: false, reason: `tokens/minute limit (${l.tokensPerMinute})`, retryAfterMs: 60_000 };
    return { ok: true };
  }
  /** Provider said 429/503 with optional Retry-After (seconds or HTTP date). Honor it. */
  penalize(id, retryAfter) {
    let ms = 30_000;
    if (retryAfter != null) { const n = Number(retryAfter); if (!Number.isNaN(n)) ms = n * 1000; else { const d = Date.parse(retryAfter); if (!Number.isNaN(d)) ms = Math.max(1000, d - this.now()); } }
    this.cooldown.set(id, this.now() + Math.min(ms, 3_600_000)); return ms;
  }
}
