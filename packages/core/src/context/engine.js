// ContextEngine: decides exactly what the foundation model sees for each step.
// Inputs are independent of any model: window size comes from the provider, everything else from
// Barix's own stores. Layout (stable -> volatile, to maximize prompt-prefix cache reuse):
//
//   [system: identity + tools + project profile]        stable prefix
//   [older recent turns, verbatim]                      stable until compaction
//   [newest turns ... last message + context packet]    volatile: memory, summaries, recalled history, code
//
// The packet is attached to the LAST message so earlier messages stay byte-identical between steps.
import { hash53 } from "../util/hash.js";
import { now } from "../util/misc.js";

const SHARES = {
  coding: { task: 0.04, project: 0.04, summaries: 0.08, recall: 0.08, code: 0.40, recent: 0.36 },
  chat: { task: 0.03, project: 0.02, summaries: 0.14, recall: 0.16, code: 0.04, recent: 0.61 },
  research: { task: 0.03, project: 0.02, summaries: 0.12, recall: 0.28, code: 0.10, recent: 0.45 },
};
const ROLE = (s) => (s.kind === "tool-result" ? "tool" : s.role);

export class ContextEngine {
  /**
   * @param {{store:import("./store.js").ConversationStore, memory:any, intel?:import("../code/intel.js").ProjectIntelligence,
   *          compactor?:any, counter:any, safety?:number}} o
   */
  constructor({ store, memory, intel = null, compactor = null, counter, safety = 0.03 }) {
    Object.assign(this, { store, memory, intel, compactor, counter, safety });
    this.prev = []; this.history = { builds: 0, reusedPrefixTokens: 0, totalPromptTokens: 0 };
  }

  /**
   * @param {{systemPrompt:string, window:number, reserveOutput?:number, mode?:"coding"|"chat"|"research", query?:string,
   *   needs?:{code?:boolean, recall?:boolean}, mentionedFiles?:string[], imageTokens?:number, maxSegmentTokens?:number}} o
   */
  async build({ systemPrompt, window, reserveOutput = 1024, mode = "chat", query, needs = {}, mentionedFiles = [], imageTokens = 0, maxSegmentTokens }) {
    const t0 = now(); const c = this.counter; const rep = { sections: {}, dropped: [], retrieved: { code: [], history: [] } };
    const avail = Math.floor(window * (1 - this.safety)) - reserveOutput;
    if (avail < 512) throw new Error(`window ${window} too small for output reserve ${reserveOutput}`);

    const live0 = this.store.live().filter((s) => s.kind !== "summary");
    const lastUser = [...live0].reverse().find((s) => s.role === "user" && s.kind === "message");
    const q = query ?? (lastUser ? await this.store.readText(lastUser.id) : "");

    // 0) compaction first: the budget for verbatim+history is a share of the window
    let compaction = null;
    if (this.compactor) compaction = await this.compactor.compactIfNeeded(avail * (SHARES[mode].recent + SHARES[mode].summaries));
    rep.compaction = compaction;

    const profile = this.memory.renderProject({ maxTokens: Math.floor(avail * SHARES[mode].project) });
    const system = systemPrompt + (profile ? `\n\n## Project\n${profile}` : "");
    const sysTok = c.count(system) + 8;
    const fixed = sysTok + imageTokens + 16;
    let remaining = avail - fixed; if (remaining < 256) throw new Error("system prompt leaves no room in the context window");
    const sh = SHARES[mode]; const budget = (k) => Math.floor(remaining * sh[k]);

    // 1) section candidates (computed in parallel: they hit different stores)
    const wantCode = needs.code ?? mode === "coding", wantRecall = needs.recall ?? true;
    const recentBudget0 = budget("recent");
    const recent = await this.#selectRecent(recentBudget0, maxSegmentTokens ?? Math.max(600, Math.floor(recentBudget0 * 0.35)));
    const covered = coveredRanges(recent.segs);
    const [taskTxt, recalled, summaries, code] = await Promise.all([
      Promise.resolve(this.memory.renderTask({ maxTokens: budget("task") })),
      this.#recallLongTerm(q, 3, 260),
      Promise.resolve(this.#renderSummaries(budget("summaries"))),
      wantCode && this.intel ? this.intel.retrieve(q, { budgetTokens: budget("code"), mentionedFiles }).then((r) => dropCovered(r, covered)) : { items: [], tokens: 0 },
    ]);
    const history = wantRecall ? await this.#recallHistory(q, budget("recall"), summaries.ids) : { text: "", ids: [], tokens: 0 };

    // 2) redistribute unused budget: recent absorbs slack (it is the most valuable verbatim context)
    const used = c.count(taskTxt) + c.count(recalled.text) + summaries.tokens + history.tokens + code.tokens;
    const slack = remaining - used - recent.tokens;
    let finalRecent = recent;
    if (slack > 0 && recent.skipped > 0) finalRecent = await this.#selectRecent(recent.tokens + slack, maxSegmentTokens ?? Math.max(600, Math.floor((recent.tokens + slack) * 0.35)));

    // 3) assemble the packet
    const parts = [];
    if (taskTxt) parts.push(`### Task state\n${taskTxt}`);
    if (recalled.text) parts.push(`### Remembered\n${recalled.text}`);
    if (summaries.text) parts.push(`### Earlier in this conversation (compacted; [#n] = segment number, recall to expand)\n${summaries.text}`);
    if (history.text) parts.push(`### Recalled from earlier history\n${history.text}`);
    if (code.items.length) parts.push(`### Relevant code (retrieved; verify with read_file before editing)\n${code.items.map((i) => `--- ${i.path}:${i.startLine}-${i.endLine} (${i.reason})\n${i.text}`).join("\n\n")}`);
    const packet = parts.length ? `<barix_context>\n${parts.join("\n\n")}\n</barix_context>` : "";

    const messages = [{ role: "system", content: system }];
    for (const s of finalRecent.segs) messages.push(await this.#toMessage(s, finalRecent.caps.get(s.id)));
    if (packet && messages.length > 1) { const last = messages[messages.length - 1]; last.content = `${packet}\n\n${last.content}`; }
    else if (packet) messages.push({ role: "user", content: packet });

    // 4) accounting + prefix-reuse measurement
    const toks = messages.map((m) => c.count(m.content) + 4);
    const total = toks.reduce((a, b) => a + b, 0) + imageTokens;
    const keys = messages.map((m) => hash53(m.role + "\u0000" + m.content));
    let reused = 0; for (let i = 0; i < keys.length - 1 && i < this.prev.length && keys[i] === this.prev[i]; i++) reused += toks[i];
    this.prev = keys; this.history.builds++; this.history.reusedPrefixTokens += reused; this.history.totalPromptTokens += total;
    Object.assign(rep.sections, { system: sysTok, task: c.count(taskTxt), remembered: c.count(recalled.text), summaries: summaries.tokens, recalled: history.tokens, code: code.tokens, recent: finalRecent.tokens });
    rep.retrieved = { code: code.items.map((i) => `${i.path}:${i.startLine}-${i.endLine}`), history: history.ids };
    Object.assign(rep, { window, reserveOutput, promptTokens: total, headroom: window - total - reserveOutput, prefixKey: keys[0].toString(36), reusedPrefixTokens: reused, prefixReuse: total ? +(reused / total).toFixed(3) : 0, buildMs: +(now() - t0).toFixed(2), recentSkipped: finalRecent.skipped, mode });
    return { messages, report: rep, query: q };
  }

  // ---------- sections ----------
  async #selectRecent(budget, segCap) {
    const live = this.store.live().filter((s) => s.kind !== "summary"); const picked = []; const caps = new Map(); let tok = 0, skipped = 0;
    const lastUserIdx = live.map((s) => s.role === "user" && s.kind === "message").lastIndexOf(true);
    for (let i = live.length - 1; i >= 0; i--) {
      const s = live[i]; const t = Math.min(s.tokens, segCap) + 4; const must = i >= lastUserIdx && lastUserIdx >= 0;
      if (!must && tok + t > budget) { skipped = i + 1; break; }
      picked.push(s); caps.set(s.id, s.tokens > segCap ? segCap : null); tok += t;
    }
    return { segs: picked.reverse(), tokens: tok, skipped, caps };
  }
  async #toMessage(s, cap) {
    let text = await this.store.readText(s.id);
    if (cap) text = this.#elide(text, cap, s);
    const m = { role: ROLE(s), content: text }; if (s.meta?.tool && s.kind === "tool-result") m.name = s.meta.tool; if (s.meta?.callId) m.tool_call_id = s.meta.callId;
    return m;
  }
  /** Keep the head and tail of oversized content; say exactly how to get the rest. */
  #elide(text, capTokens, s) {
    const head = this.counter.truncate(text, Math.floor(capTokens * 0.65));
    const tailSrc = text.slice(Math.max(head.length, text.length - Math.floor(capTokens * 0.3 * 3.5)));
    const omitted = Math.max(0, s.tokens - this.counter.count(head) - this.counter.count(tailSrc));
    return `${head}\n[… ${omitted} tokens omitted from segment #${s.seq}; use read_file with a line range, or recall("#${s.seq}") …]\n${tailSrc}`;
  }
  #renderSummaries(budget) {
    const nodes = this.store.activeSummaries(); if (!nodes.length) return { text: "", tokens: 0, ids: [] };
    // highest level (most compressed, oldest) first guarantees coverage; then newest low-level nodes while budget remains
    const chosen = new Set(); let tok = 0;
    for (const n of [...nodes].sort((a, b) => b.level - a.level || b.to - a.to)) { if (tok + n.tokens > budget) continue; chosen.add(n.id); tok += n.tokens; }
    const kept = nodes.filter((n) => chosen.has(n.id));
    return { text: kept.map((n) => n.text).join("\n\n"), tokens: tok, ids: kept.map((n) => n.id), omitted: nodes.length - kept.length };
  }
  async #recallHistory(query, budget, summaryIds) {
    if (!query.trim() || budget < 80 || !this.store.index.size) return { text: "", ids: [], tokens: 0 };
    const hits = await this.store.index.search(query, { k: 12, filter: (id, m) => m?.kind === "segment" });
    const bySeg = new Map(); for (const h of hits) if (!bySeg.has(h.segId)) bySeg.set(h.segId, h);
    const out = []; let tok = 0; const ids = [];
    for (const [segId, h] of bySeg) {
      const seg = this.store.get(segId); if (!seg || seg.evicted) continue;
      const text = this.#excerpt(await this.store.readText(segId), query, 700);
      const line = `[#${seg.seq} ${seg.role}${seg.meta?.path ? " " + seg.meta.path : ""}] ${text}`; const t = this.counter.count(line);
      if (tok + t > budget) continue; out.push(line); ids.push(`#${seg.seq}`); tok += t;
    }
    return { text: out.join("\n"), ids, tokens: tok };
  }
  #excerpt(text, query, max) {
    if (text.length <= max) return text;
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])]; let best = 0, bs = -1;
    const low = text.toLowerCase();
    for (let i = 0; i < text.length; i += Math.floor(max / 3)) { const w = low.slice(i, i + max); let s = 0; for (const t of terms) if (w.includes(t)) s++; if (s > bs) { bs = s; best = i; } }
    return (best > 0 ? "…" : "") + text.slice(best, best + max).trim() + (best + max < text.length ? "…" : "");
  }
  async #recallLongTerm(q, k, budgetTokens) {
    const items = await this.memory.recall(q, { k, budgetTokens }); return { text: items.map((m) => `- ${m.text}`).join("\n"), items };
  }

  /** Explicit recall tool backend: expand a segment (#n), a summary range, or search history. */
  async recall(spec, { maxTokens = 1500 } = {}) {
    const m = /^#?(\d+)(?:\s*-\s*#?(\d+))?$/.exec(String(spec).trim());
    if (m) {
      const from = +m[1], to = +(m[2] ?? m[1]); const segs = this.store.bySeqRange(from, Math.min(to, from + 40)); const out = []; let tok = 0;
      for (const s of segs) { const t = await this.store.readText(s.id); const tt = this.counter.count(t); if (tok + tt > maxTokens) { out.push(`[#${s.seq} ${s.role}] ${this.counter.truncate(t, Math.max(50, maxTokens - tok))}…`); break; } out.push(`[#${s.seq} ${s.role}] ${t}`); tok += tt; }
      return out.join("\n\n") || "no such segment";
    }
    const h = await this.#recallHistory(String(spec), maxTokens, []); return h.text || "nothing relevant found in history";
  }
}

function coveredRanges(segs) {
  const m = new Map();
  for (const s of segs) if (s.meta?.path && s.meta.read) { const a = m.get(s.meta.path) ?? m.set(s.meta.path, []).get(s.meta.path); a.push([s.meta.startLine ?? 1, s.meta.endLine ?? Infinity]); }
  return m;
}
function dropCovered(r, covered) {
  if (!covered.size) return r;
  const items = r.items.filter((i) => !(covered.get(i.path) ?? []).some(([a, b]) => a <= i.startLine && b >= i.endLine));
  return { ...r, items, tokens: items.reduce((a, i) => a + i.tokens, 0) };
}
