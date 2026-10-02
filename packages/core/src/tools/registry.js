// Tool registry + executor. Barix owns tool semantics: schema validation, guards (e.g. "read before
// edit"), parallel/serial scheduling, timeouts, output caps, secret redaction, and — crucially —
// evidence recording into the verification ledger. The model proposes calls; only this layer executes them.
import { validate } from "./schema.js";
import { redactSecrets } from "../util/secrets.js";
import { BarixError, now } from "../util/misc.js";

export class ToolRegistry {
  constructor() { this.tools = new Map(); }
  /**
   * @param {{name:string, description:string, parameters:object, mutating?:boolean, group?:string, requires?:string[],
   *   timeoutMs?:number, guard?:(args:object, ctx:object)=>string|null|Promise<string|null>,
   *   run:(args:object, ctx:object)=>Promise<{ok:boolean, output:string, data?:object, evidence?:{kind:string,data:object}, meta?:object}>}} tool
   */
  register(tool) { if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`); this.tools.set(tool.name, { mutating: false, group: "general", requires: [], timeoutMs: 120_000, ...tool }); return this; }
  registerAll(list) { for (const t of list) this.register(t); return this; }
  get(name) { return this.tools.get(name); }
  all() { return [...this.tools.values()]; }
  /** Tools available given capabilities (e.g. no `exec` in the browser => no run_tests). */
  available(caps = {}) { return this.all().filter((t) => t.requires.every((r) => caps[r])); }
  /**
   * Barix tool selection: show the model only tools relevant to the task (smaller prompt, fewer wrong calls).
   * `groups` come from task understanding.
   */
  select(caps, groups) { const g = new Set(["core", ...groups]); return this.available(caps).filter((t) => g.has(t.group)); }
  suggest(name) {
    const scored = this.all().map((t) => ({ t, d: lev(name, t.name) })).sort((a, b) => a.d - b.d); return scored[0] && scored[0].d <= Math.max(3, name.length / 3) ? scored[0].t.name : null;
  }
}

export class ToolExecutor {
  /** @param {{registry:ToolRegistry, ctx:object, ledger:import("../verify/ledger.js").EvidenceLedger, counter:any, maxResultTokens?:number}} o */
  constructor({ registry, ctx, ledger, counter, maxResultTokens = 3000 }) { Object.assign(this, { registry, ctx, ledger, counter, maxResultTokens }); }

  /** Execute parsed calls. Read-only runs are batched in parallel; mutating calls run strictly in order. */
  async runAll(calls, { signal, onEvent } = {}) {
    const results = new Array(calls.length); let i = 0;
    while (i < calls.length) {
      const t = this.registry.get(calls[i].tool);
      if (t && !t.mutating) {
        let j = i; while (j < calls.length && this.registry.get(calls[j].tool) && !this.registry.get(calls[j].tool).mutating) j++;
        await Promise.all(calls.slice(i, j).map(async (c, k) => { results[i + k] = await this.run(c, { signal, onEvent }); })); i = j;
      } else { results[i] = await this.run(calls[i], { signal, onEvent }); i++; }
    }
    return results;
  }

  async run(call, { signal, onEvent } = {}) {
    const t0 = now(); const tool = this.registry.get(call.tool);
    const fail = (msg, extra = {}) => ({ call, ok: false, output: msg, meta: { tool: call.tool, ok: false, summary: msg.slice(0, 160), ...(call.args?.path ? { path: call.args.path } : {}) }, ms: now() - t0, ...extra });
    if (!tool) { const s = this.registry.suggest(call.tool); return fail(`Unknown tool "${call.tool}".${s ? ` Did you mean "${s}"?` : ""} Available: ${this.registry.available(this.ctx.capabilities).map((x) => x.name).join(", ")}`); }
    if (tool.requires.some((r) => !this.ctx.capabilities?.[r])) return fail(`Tool "${call.tool}" is unavailable here (needs: ${tool.requires.join(", ")}).`);
    const v = validate(tool.parameters ?? { type: "object", properties: {} }, call.args ?? {});
    if (!v.ok) return fail(`Invalid arguments for ${call.tool}:\n- ${v.errors.join("\n- ")}\nUsage: ${usage(tool)}`);
    try {
      const g = await tool.guard?.(v.value, this.ctx); if (g) return fail(g);
      onEvent?.({ type: "tool-start", call });
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), tool.timeoutMs); signal?.addEventListener("abort", () => ac.abort(), { once: true });
      let res; try { res = await Promise.race([tool.run(v.value, { ...this.ctx, signal: ac.signal }), new Promise((_, rej) => ac.signal.addEventListener("abort", () => rej(new BarixError("ETIMEOUT", `${call.tool} timed out after ${tool.timeoutMs}ms`)), { once: true }))]); } finally { clearTimeout(to); }
      let out = this.ctx.redact === false ? res.output : redactSecrets(res.output ?? "");
      if (this.counter.count(out) > this.maxResultTokens) { const full = this.counter.count(out); out = this.counter.truncate(out, this.maxResultTokens) + `\n[… output truncated: ${full} tokens total; narrow the request (line range, glob, pattern) to see the rest …]`; }
      const ev = res.evidence ? this.ledger.record({ tool: call.tool, args: v.value, ok: res.ok, ...res.evidence }) : null;
      const r = { call, ok: res.ok, output: out, data: res.data, evidence: ev?.id, meta: { tool: call.tool, ok: res.ok, ...(v.value.path ? { path: v.value.path } : {}), ...res.meta }, ms: now() - t0 };
      onEvent?.({ type: "tool-end", call, result: r }); return r;
    } catch (e) {
      const code = e instanceof BarixError ? e.code : "ETOOL";
      return fail(`${call.tool} failed: ${e.message}${e.code ? ` [${code}]` : ""}`, { error: e });
    }
  }
}

export const usage = (t) => `${t.name}(${Object.entries(t.parameters?.properties ?? {}).map(([k, s]) => `${k}${(t.parameters.required ?? []).includes(k) ? "" : "?"}: ${s.type}`).join(", ")})`;
function lev(a, b) { const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
