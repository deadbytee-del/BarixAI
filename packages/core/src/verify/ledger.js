// Verification layer. Evidence is written ONLY by the tool executor (never by the model).
// Claims in the model's final text are extracted and checked against that evidence AND against the
// live filesystem. "The build succeeds" requires an actual successful build record that is not stale;
// "I modified X" requires a recorded write whose content hash still matches the file on disk.
import { hash53 } from "../util/hash.js";

const FS_KINDS = new Set(["fs-write", "fs-delete", "fs-move"]);

export class EvidenceLedger {
  /** @param {{fs:import("../fs/barixfs.js").BarixFS}} o */
  constructor({ fs }) { this.fs = fs; this.records = []; this.seq = 0; }
  /** @param {{tool:string, kind:string, args?:object, ok:boolean, data?:object}} e */
  record(e) { const r = { id: `ev${++this.seq}`, seq: this.seq, ts: Date.now(), ...e }; this.records.push(r); return r; }
  last(kind) { for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i].kind === kind) return this.records[i]; return null; }
  mutationsAfter(seq) { return this.records.filter((r) => r.seq > seq && FS_KINDS.has(r.kind) && r.ok); }
  forPath(path) { return this.records.filter((r) => r.ok && FS_KINDS.has(r.kind) && (r.data?.path === path || r.data?.from === path)); }
  changedFiles() { const m = new Map(); for (const r of this.records) if (r.ok && FS_KINDS.has(r.kind)) { if (r.kind === "fs-delete") m.delete(r.data.path); else { if (r.kind === "fs-move") m.delete(r.data.from); m.set(r.data.path, r); } } return [...m.keys()]; }
  reset() { this.records = []; }
  /** Deterministic, model-independent report of what verifiably happened. Used when the model's own answer is missing or unusable. */
  summary() {
    const L = []; const files = this.changedFiles(); const w = (p) => this.forPath(p).at(-1);
    if (files.length) L.push("Changed files (each verified on disk after writing):", ...files.map((p) => `- ${p}${w(p)?.data?.action ? ` (${w(p).data.action})` : ""}`)); else L.push("No files were changed.");
    for (const [k, label] of [["build", "Build"], ["test", "Tests"], ["lint", "Lint"]]) { const e = this.last(k); if (!e) continue; const stale = this.mutationsAfter(e.seq).length; L.push(`${label}: ${e.ok ? "PASSED" : "FAILED"}${e.data?.summary ? " — " + String(e.data.summary).slice(0, 120) : ""}${stale ? " (files changed after this run)" : ""}`); }
    if (!this.last("test") && !this.last("build")) L.push("No tests or build were run.");
    return L.join("\n");
  }

  /** Verify every checkable claim in `text`. */
  async verify(text) {
    const claims = extractClaims(text); const out = { claims: [], verified: [], unverified: [], contradicted: [] };
    for (const c of claims) {
      const r = await this.#check(c); const item = { ...c, ...r }; out.claims.push(item);
      (r.status === "verified" ? out.verified : r.status === "contradicted" ? out.contradicted : out.unverified).push(item);
    }
    out.ok = !out.unverified.length && !out.contradicted.length; return out;
  }
  async #check(c) {
    switch (c.type) {
      case "file": return this.#checkFile(c);
      case "build": case "test": case "lint": return this.#checkRun(c);
      case "deploy": { const e = this.last("pages-verified"); return e?.ok ? { status: "verified", evidence: e.id } : { status: "unverified", reason: "no verified Pages deployment (build status + live URL check) was recorded" }; }
      case "remote": { const e = this.last("remote-verified"); return e?.ok ? { status: "verified", evidence: e.id } : { status: "unverified", reason: "no remote verification (fetching the pushed ref / Pages status) was recorded" }; }
    }
    return { status: "unverified", reason: "unknown claim type" };
  }
  async #checkFile(c) {
    const { path, action } = c; const ev = this.forPath(path);
    if (action === "delete") {
      const d = [...ev].reverse().find((r) => r.kind === "fs-delete");
      if (!d) return { status: "unverified", reason: `no deletion of ${path} was recorded` };
      return this.fs.exists(path) ? { status: "contradicted", reason: `${path} still exists on disk` } : { status: "verified", evidence: d.id };
    }
    if (action === "move") {
      const m = [...ev].reverse().find((r) => r.kind === "fs-move");
      return m && this.fs.exists(m.data.path) ? { status: "verified", evidence: m.id } : { status: "unverified", reason: `no move involving ${path} was recorded` };
    }
    const w = [...ev].reverse().find((r) => r.kind === "fs-write");
    if (!w) return { status: "unverified", reason: `no write or patch to ${path} was recorded this session` };
    if (!this.fs.exists(path)) return { status: "contradicted", reason: `${path} was written but no longer exists` };
    let cur; try { cur = hash53(await this.fs.readFile(path)); } catch { return { status: "verified", evidence: w.id, note: "binary/unreadable; existence confirmed" }; }
    return cur === w.data.hash ? { status: "verified", evidence: w.id } : { status: "unverified", reason: `${path} on disk differs from the last write Barix recorded (changed externally or by a later step)` };
  }
  #checkRun(c) {
    const e = this.last(c.type);
    if (!e) return { status: "unverified", reason: `no ${c.type} run was recorded` };
    const stale = this.mutationsAfter(e.seq);
    if (!e.ok) return { status: "contradicted", reason: `the last ${c.type} run FAILED (${e.data?.summary ?? "see output"})`, evidence: e.id };
    if (stale.length) return { status: "unverified", reason: `files changed after the last ${c.type} run (${[...new Set(stale.map((s) => s.data.path))].slice(0, 3).join(", ")}); it was not re-run`, evidence: e.id };
    return { status: "verified", evidence: e.id };
  }
}

// ------------------------------------------------------------------ claim extraction
const HEDGE = /\b(will|would|could|should|can|might|may|let me|i'll|i will|going to|want me to|if you|need to|needs to|to be|plan to|next,?|todo|suggest|recommend|you can|you could|you should|try)\b|\?\s*$/i;
const FILE_VERB = /\b(created|wrote|written|added|modified|updated|changed|edited|fixed|removed|deleted|renamed|moved|refactored|rewrote|rewritten|patched|replaced|implemented|saved)\b/i;
const PATH = /(?:`([^`\s]+\.[A-Za-z0-9]{1,8})`|\b((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z][A-Za-z0-9]{0,7})\b)/g;
const NOT_FILES = /^(e\.g|i\.e|vs|etc|v\d|node\.js|vue\.js|next\.js|react\.js|\d+\.\d+)/i;
const BUILD = /\bbuild(?:s|ing)?\b[^.\n]{0,50}\b(?:succe\w+|pass\w*|work\w*|complet\w+|clean|fine|ok|without (?:errors|issues))\b|\b(?:successfully|cleanly)\s+(?:built|compiled|bundled)\b|\b(?:compiles|bundles)\s+(?:cleanly|successfully|fine|without)/i;
const TEST = /\b(?:all\s+)?(?:\d+\s+)?tests?\b[^.\n]{0,50}\b(?:pass\w*|green|succe\w+)\b|\btest suite\b[^.\n]{0,30}\bpass\w*|\bno (?:test )?failures\b/i;
const LINT = /\blint(?:er|ing)?\b[^.\n]{0,40}\b(?:clean|pass\w*|no (?:errors|warnings|issues))\b/i;
const REMOTE = /\b(?:pushed|published|released)\b[^.\n]{0,70}\b(?:github|origin|remote|branch|main|master)\b/i;
const DEPLOY = /\b(?:deployed|(?:is|are) (?:now )?(?:live|up and running|available online)|published to (?:github )?pages|pages (?:site |build |deployment )?(?:is |has )?(?:live|deployed|succe\w+|built))\b/i;

export function extractClaims(text) {
  const claims = []; const seen = new Set();
  const body = text.replace(/<barix:call[\s\S]*?(?:<\/barix:call>|$)|<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, " ").replace(/```[\s\S]*?```/g, " "); // code blocks and tool calls are content, not claims
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (HEDGE.test(s)) continue;
    const push = (type, extra = {}) => { const k = type + (extra.path ?? "") + (extra.action ?? ""); if (seen.has(k)) return; seen.add(k); claims.push({ type, sentence: s.slice(0, 200), ...extra }); };
    if (BUILD.test(s)) push("build"); if (TEST.test(s)) push("test"); if (LINT.test(s)) push("lint"); if (REMOTE.test(s)) push("remote"); if (DEPLOY.test(s)) push("deploy");
    const v = FILE_VERB.exec(s);
    if (v) {
      const verb = v[1].toLowerCase(); const action = /remov|delet/.test(verb) ? "delete" : /renam|moved/.test(verb) ? "move" : "write";
      for (const m of s.matchAll(PATH)) { const p = (m[1] ?? m[2]).replace(/^\.\//, ""); if (NOT_FILES.test(p) || /^\d/.test(p) || p.length < 3) continue; push("file", { path: p, action }); }
    }
  }
  return claims;
}

/** Human-readable verification footer. */
export function renderVerification(v) {
  if (!v.claims.length) return "";
  const L = [];
  for (const c of v.verified) L.push(`✓ ${label(c)}`);
  for (const c of v.contradicted) L.push(`✗ ${label(c)} — ${c.reason}`);
  for (const c of v.unverified) L.push(`? ${label(c)} — not verified: ${c.reason}`);
  return L.join("\n");
}
const label = (c) => (c.type === "file" ? `${c.action === "delete" ? "deleted" : c.action === "move" ? "moved" : "changed"} ${c.path}` : c.type === "remote" ? "pushed to remote" : c.type === "deploy" ? "deployed (live site verified)" : `${c.type} ok`);
