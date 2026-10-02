// Layered Barix memory.
//   short-term : the live conversation (ConversationStore) — not duplicated here
//   task       : objective / plan / progress / errors / decisions for the current job (small, always rendered)
//   project    : architecture, dependencies, conventions, important files — per project, persisted
//   long-term  : durable user preferences/facts. Persisted ONLY if the policy allows (explicit or clearly
//                durable, no secrets, bounded size). Everything is searchable and relevance-ranked;
//                nothing is dumped wholesale into prompts.
import { uid } from "../util/misc.js";
import { HybridIndex } from "../retrieval/hybrid.js";
import { HashEmbedder } from "../retrieval/embeddings.js";
import { detectSecrets } from "../util/secrets.js";

export class MemoryKV { constructor() { this.m = new Map(); } async get(k) { return this.m.get(k) ?? null; } async set(k, v) { this.m.set(k, v); } async delete(k) { this.m.delete(k); } }
/** JSON KV on top of any BarixFS backend (OPFS, IndexedDB, disk). */
export function backendKV(backend, dir = ".barix/memory") {
  let ready = false; const dec = new TextDecoder(), enc = new TextEncoder();
  const ensure = async () => { if (ready) return; for (const d of [".barix", dir]) if (!(await backend.stat(d))) await backend.mkdir(d); ready = true; };
  const file = (k) => `${dir}/${k.replace(/[^\w.-]/g, "_")}.json`;
  return {
    async get(k) { await ensure(); return (await backend.stat(file(k))) ? JSON.parse(dec.decode(await backend.readFile(file(k)))) : null; },
    async set(k, v) { await ensure(); await backend.writeFile(file(k), enc.encode(JSON.stringify(v))); },
    async delete(k) { await ensure(); if (await backend.stat(file(k))) await backend.remove(file(k)); },
  };
}

const EXPLICIT = /\b(remember (?:that|this|to)|please remember|don'?t forget|from now on|for future (?:reference|sessions)|always (?:use|do|write|reply|respond)|never (?:use|do|write)|my (?:name|preferred|favorite|timezone|email is|language)|i (?:prefer|always use|usually use|like to use|work (?:at|on|with|in)))\b/i;
const TRANSIENT = /\b(today|right now|just now|this (?:file|bug|error|time)|currently|at the moment|tomorrow|tonight)\b/i;

export function persistencePolicy(text) {
  const t = text.trim();
  if (t.length < 8) return { ok: false, reason: "too short" };
  if (t.length > 600) return { ok: false, reason: "too long for a memory item; store as project note or file instead" };
  if (detectSecrets(t).length) return { ok: false, reason: "contains a secret — never persisted" };
  if (/\b(password|passphrase|ssn|social security|credit card)\b/i.test(t)) return { ok: false, reason: "sensitive personal data" };
  if (TRANSIENT.test(t) && !/remember/i.test(t)) return { ok: false, reason: "looks transient" };
  if (EXPLICIT.test(t)) return { ok: true, reason: "explicit or clearly durable preference", importance: /\bremember|from now on|always|never\b/i.test(t) ? 0.9 : 0.7 };
  return { ok: false, reason: "not explicitly durable; kept only in conversation/project memory" };
}

const DAY = 86_400_000;
export class MemorySystem {
  constructor({ kv = new MemoryKV(), counter, projectId = "default", embedder = new HashEmbedder(), now = () => Date.now() } = {}) {
    this.kv = kv; this.counter = counter; this.projectId = projectId; this.now = now;
    this.task = { objective: "", status: "idle", plan: [], progress: [], errors: [], decisions: [], files: [], updatedAt: 0 };
    this.project = { id: projectId, profile: null, notes: [], importantFiles: [], updatedAt: 0 };
    this.longTerm = []; this.index = new HybridIndex({ embedder });
    this.loaded = false;
  }
  async load() {
    this.longTerm = (await this.kv.get("longterm")) ?? []; this.project = (await this.kv.get(`project:${this.projectId}`)) ?? this.project;
    for (const m of this.longTerm) this.#idx(m, "long-term");
    for (const m of this.project.notes) this.#idx(m, "project");
    await this.index.flush(); this.loaded = true; return this;
  }
  #idx(m, layer) { this.index.add({ id: m.id, text: m.text, header: `${layer} ${(m.tags ?? []).join(" ")}`, meta: { layer } }); }
  async #save(which) {
    if (which === "longterm") await this.kv.set("longterm", this.longTerm);
    else await this.kv.set(`project:${this.projectId}`, this.project);
  }

  // ---------------- task memory ----------------
  startTask(objective, { plan = [] } = {}) { this.task = { objective, status: "active", plan: plan.map((p, i) => ({ id: i + 1, text: p, done: false })), progress: [], errors: [], decisions: [], files: [], updatedAt: this.now() }; }
  noteProgress(text) { this.task.progress.push({ text, ts: this.now() }); this.task.progress = this.task.progress.slice(-20); this.#touch(); }
  noteError(text, { resolved = false } = {}) { this.task.errors.push({ text: text.slice(0, 300), resolved, ts: this.now() }); this.task.errors = this.task.errors.slice(-15); this.#touch(); }
  resolveErrors(matchFn = () => true) { for (const e of this.task.errors) if (!e.resolved && matchFn(e)) e.resolved = true; this.#touch(); }
  noteDecision(text) { if (!this.task.decisions.some((d) => d.text === text)) this.task.decisions.push({ text, ts: this.now() }); this.task.decisions = this.task.decisions.slice(-15); this.#touch(); }
  touchFile(path) { if (!this.task.files.includes(path)) this.task.files.push(path); this.task.files = this.task.files.slice(-30); this.#touch(); }
  completeStep(id) { const s = this.task.plan.find((p) => p.id === id); if (s) s.done = true; this.#touch(); }
  finishTask(status = "done") { this.task.status = status; this.#touch(); }
  #touch() { this.task.updatedAt = this.now(); }
  renderTask({ maxTokens = 500 } = {}) {
    const t = this.task; if (!t.objective) return "";
    const L = [`Objective: ${t.objective} (${t.status})`];
    if (t.plan.length) L.push("Plan: " + t.plan.map((p) => `${p.done ? "[x]" : "[ ]"} ${p.text}`).join("; "));
    const open = t.errors.filter((e) => !e.resolved); if (open.length) L.push("Open errors: " + open.slice(-3).map((e) => e.text).join(" | "));
    if (t.decisions.length) L.push("Decisions: " + t.decisions.slice(-4).map((d) => d.text).join(" | "));
    if (t.progress.length) L.push("Recent progress: " + t.progress.slice(-4).map((p) => p.text).join(" → "));
    if (t.files.length) L.push("Files touched: " + t.files.slice(-10).join(", "));
    let out = L.join("\n"); if (this.counter && this.counter.count(out) > maxTokens) out = this.counter.truncate(out, maxTokens); return out;
  }

  // ---------------- project memory ----------------
  async setProjectProfile(profile, { importantFiles } = {}) {
    this.project.profile = { summary: profile.summary, commands: profile.commands, conventions: profile.conventions, frameworks: profile.frameworks, entryPoints: profile.entryPoints, primaryLanguage: profile.primaryLanguage };
    if (importantFiles) this.project.importantFiles = importantFiles; this.project.updatedAt = this.now(); await this.#save("project");
  }
  async addProjectNote(text, { tags = [], importance = 0.6 } = {}) {
    if (detectSecrets(text).length) return { stored: false, reason: "contains a secret" };
    const dup = this.project.notes.find((n) => n.text === text); if (dup) return { stored: true, id: dup.id, duplicate: true };
    const m = { id: uid("pm"), text, tags, importance, created: this.now(), lastUsed: 0, uses: 0 };
    this.project.notes.push(m); this.#idx(m, "project"); await this.index.flush(); await this.#save("project"); return { stored: true, id: m.id };
  }
  renderProject({ maxTokens = 400 } = {}) {
    const p = this.project.profile; const L = [];
    if (p?.summary) L.push(p.summary);
    if (this.project.importantFiles.length) L.push("Key files: " + this.project.importantFiles.slice(0, 8).map((f) => (typeof f === "string" ? f : f.path)).join(", "));
    let out = L.join("\n"); if (this.counter && this.counter.count(out) > maxTokens) out = this.counter.truncate(out, maxTokens); return out;
  }

  // ---------------- long-term ----------------
  /** Persist a durable memory iff the policy allows (or `force` by explicit user command). */
  async remember(text, { force = false, tags = [], source = "inference" } = {}) {
    const pol = persistencePolicy(text);
    if (!pol.ok && !(force && !/secret|sensitive/.test(pol.reason))) return { stored: false, reason: pol.reason };
    const norm = text.trim().toLowerCase(); const dup = this.longTerm.find((m) => m.text.trim().toLowerCase() === norm);
    if (dup) { dup.lastUsed = this.now(); await this.#save("longterm"); return { stored: true, id: dup.id, duplicate: true }; }
    const m = { id: uid("lt"), text: text.trim(), tags, importance: pol.importance ?? 0.7, created: this.now(), lastUsed: 0, uses: 0, source };
    this.longTerm.push(m); this.#idx(m, "long-term"); await this.index.flush(); await this.#save("longterm"); return { stored: true, id: m.id };
  }
  async forget(id) {
    const before = this.longTerm.length + this.project.notes.length;
    this.longTerm = this.longTerm.filter((m) => m.id !== id); this.project.notes = this.project.notes.filter((m) => m.id !== id); this.index.remove(id);
    await this.#save("longterm"); await this.#save("project"); return before !== this.longTerm.length + this.project.notes.length;
  }
  list(layer = "long-term") { return layer === "project" ? [...this.project.notes] : [...this.longTerm]; }

  /** Relevance-ranked recall across layers; respects a token budget; bumps usage stats. */
  async recall(query, { layers = ["long-term", "project"], k = 6, budgetTokens = 300 } = {}) {
    const hits = (await this.index.search(query, { k: k * 2, minVector: 0.3, filter: (id, m) => layers.includes(m?.layer) })).filter((h) => h.sources.lexical || h.sources.vector);
    const all = new Map([...this.longTerm, ...this.project.notes].map((m) => [m.id, m]));
    const top = hits[0]?.score || 1;
    const scored = hits.map((h) => {
      const m = all.get(h.id); if (!m) return null;
      const age = (this.now() - (m.lastUsed || m.created)) / DAY;
      return { ...m, layer: h.layer, relevance: h.score / top, score: (h.score / top) * (0.5 + m.importance) * Math.pow(0.5, age / 45) * (1 + Math.log1p(m.uses) * 0.1) };
    }).filter((x) => x && x.relevance > 0.25).sort((a, b) => b.score - a.score);
    const out = []; let used = 0;
    for (const m of scored) { const t = this.counter ? this.counter.count(m.text) : m.text.length / 4; if (used + t > budgetTokens || out.length >= k) break; used += t; out.push(m); const orig = all.get(m.id); orig.lastUsed = this.now(); orig.uses++; }
    if (out.length) { await this.#save("longterm"); await this.#save("project"); }
    return out;
  }
}
