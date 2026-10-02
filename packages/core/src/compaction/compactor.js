// Hierarchical conversation compaction.
//   L0  raw segments (live)         ->  L1 epoch summaries  ->  L2 summaries of summaries -> ...
// Raw segments are ARCHIVED (searchable), never discarded. Summaries are *structured*: requirements,
// decisions, open issues, code changes and results are carried as exact extracted statements with
// [#seq] back-references, so Barix can expand any summary line into the original text on demand.
import { uid } from "../util/misc.js";
import { extractFacts, resolveIssues } from "./classify.js";

const SECTION = [["requirement", "Requirements"], ["decision", "Decisions"], ["issue", "Open issues"], ["question", "Open questions"], ["change", "Changes"], ["result", "Results"], ["fact", "Notes"]];
const CAPS = { requirement: 12, decision: 10, issue: 8, question: 5, change: 25, result: 8, fact: 6 };

export class Compactor {
  /**
   * @param {{store:import("../context/store.js").ConversationStore, summarizer?:(facts:object, ctx:object)=>Promise<string>,
   *   triggerRatio?:number, targetRatio?:number, keepRecentTokens?:number, minKeepTurns?:number, mergeFanIn?:number, summaryBudgetRatio?:number}} o
   */
  constructor({ store, summarizer = null, triggerRatio = 0.7, targetRatio = 0.4, keepRecentTokens = 6000, minKeepTurns = 2, mergeFanIn = 6, summaryBudgetRatio = 0.25 } = {}) {
    Object.assign(this, { store, summarizer, triggerRatio, targetRatio, keepRecentTokens, minKeepTurns, mergeFanIn, summaryBudgetRatio });
    this.runs = 0;
  }

  /** Compact when live conversation tokens exceed `triggerRatio * liveBudget`. Returns a report or null. */
  async compactIfNeeded(liveBudget) {
    const s = this.store;
    if (s.totals.live <= liveBudget * this.triggerRatio) return null;
    const report = await this.compact(liveBudget * this.targetRatio);
    // hierarchical merge when summaries themselves grow too large
    const merges = []; let guard = 0;
    while (guard++ < 8) {
      const m = await this.#mergeIfNeeded(liveBudget * this.summaryBudgetRatio); if (!m) break; merges.push(m);
    }
    return { ...report, merges };
  }

  /** Force compaction of the oldest turns until live tokens <= targetLive (keeping recent turns verbatim). */
  async compact(targetLive) {
    const s = this.store; const live = s.live().filter((x) => x.kind !== "summary");
    const turns = groupTurns(live);
    const keepBudget = Math.min(this.keepRecentTokens, targetLive * 0.6);
    let keepFrom = turns.length, keepTok = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i].reduce((a, x) => a + x.tokens, 0);
      if (keepFrom <= turns.length - this.minKeepTurns && keepTok + t > keepBudget) break;
      keepTok += t; keepFrom = i;
    }
    const victims = []; let liveTok = s.totals.live;
    for (let i = 0; i < keepFrom && liveTok > targetLive; i++) { victims.push(...turns[i]); liveTok -= turns[i].reduce((a, x) => a + x.tokens, 0); }
    if (!victims.length) return { compacted: 0 };
    const node = await this.#summarize(victims, 1);
    await s.archive(victims.map((v) => v.id), node.id);
    this.runs++;
    return { compacted: victims.length, tokensBefore: node.sourceTokens, tokensAfter: node.tokens, node: node.id, ratio: +(node.sourceTokens / Math.max(1, node.tokens)).toFixed(1) };
  }

  async #summarize(segs, level) {
    const s = this.store; let facts = [];
    for (const seg of segs) facts.push(...extractFacts(seg, seg.kind === "tool-result" ? seg.preview : await s.readText(seg.id)));
    facts = resolveIssues(facts);
    const node = { id: uid("sum"), level, from: segs[0].seq, to: segs[segs.length - 1].seq, children: segs.map((x) => x.id), count: segs.length, sourceTokens: segs.reduce((a, x) => a + x.tokens, 0), facts, ts: Date.now() };
    node.gist = await this.#gist(node, segs);
    node.text = render(node); node.tokens = s.counter.count(node.text);
    s.addSummary(node); return node;
  }
  async #gist(node, segs) {
    if (this.summarizer) { try { const g = await this.summarizer({ facts: node.facts, range: [node.from, node.to] }, {}); if (g && g.length < 800) return g.trim(); } catch { /* fall back to extractive gist */ } }
    const first = node.facts.find((f) => f.type === "requirement") ?? node.facts.find((f) => f.type === "question") ?? node.facts[0];
    const users = segs.filter((x) => x.role === "user").length, tools = segs.filter((x) => x.kind === "tool-result").length;
    return `${users} user turn(s), ${tools} tool call(s).${first ? ` Started with: "${first.text.slice(0, 140)}"` : ""}`;
  }

  async #mergeIfNeeded(summaryBudget) {
    const s = this.store; const act = s.activeSummaries();
    const tok = act.reduce((a, n) => a + n.tokens, 0);
    if (tok <= summaryBudget || act.length < 3) return null;
    const lvl = Math.min(...act.map((n) => n.level));
    const same = act.filter((n) => n.level === lvl); if (same.length < 2) return null;
    const group = same.slice(0, Math.min(this.mergeFanIn, same.length));
    // merge: union facts, drop resolved issues + superseded duplicates, re-render at higher level
    const seen = new Set(), facts = [];
    for (const n of group) for (const f of n.facts) { const k = f.type + "|" + f.text.toLowerCase().slice(0, 80); if (seen.has(k)) continue; seen.add(k); facts.push(f); }
    const keep = resolveIssues(facts).filter((f) => !(f.type === "issue" && f.resolved) && !(f.type === "result" && /PASS/.test(f.text) && facts.some((g) => g !== f && g.type === "result" && g.seq > f.seq && g.text.split(":")[0] === f.text.split(":")[0])));
    const dropped = facts.length - keep.length;
    const node = { id: uid("sum"), level: lvl + 1, from: group[0].from, to: group[group.length - 1].to, children: group.map((n) => n.id), count: group.reduce((a, n) => a + n.count, 0), sourceTokens: group.reduce((a, n) => a + n.sourceTokens, 0), facts: keep, ts: Date.now() };
    node.gist = group.map((n) => n.gist).join(" ").slice(0, 500);
    node.text = render(node); node.tokens = s.counter.count(node.text);
    for (const n of group) s.retireSummary(n.id);
    s.addSummary(node); return { merged: group.length, into: node.id, level: node.level, droppedFacts: dropped, tokens: node.tokens };
  }
}

export function groupTurns(segs) {
  const turns = []; let cur = [];
  for (const s of segs) { if (s.role === "user" && s.kind === "message" && cur.length) { turns.push(cur); cur = []; } cur.push(s); }
  if (cur.length) turns.push(cur); return turns;
}

export function render(node) {
  const lines = [`[Summary L${node.level} · #${node.from}–#${node.to} · ${node.count} items, ${node.sourceTokens} tokens compacted]`, node.gist];
  for (const [type, title] of SECTION) {
    let fs = node.facts.filter((f) => f.type === type && !f.resolved);
    if (!fs.length) continue;
    fs = dedupe(fs).sort((a, b) => b.score - a.score).slice(0, CAPS[type]).sort((a, b) => a.seq - b.seq);
    lines.push(`${title}:`); for (const f of fs) lines.push(`- ${f.text} [#${f.seq}]`);
  }
  const resolved = node.facts.filter((f) => f.type === "issue" && f.resolved).length; if (resolved) lines.push(`(${resolved} earlier issue(s) since resolved)`);
  return lines.join("\n");
}
const dedupe = (fs) => { const s = new Set(); return fs.filter((f) => { const k = f.text.toLowerCase().replace(/\W+/g, " ").slice(0, 70); if (s.has(k)) return false; s.add(k); return true; }); };
