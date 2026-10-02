// Fact extraction for compaction. Rules are deliberately *extractive*: facts are exact sentences or
// tool-evidence, never paraphrases, so compaction cannot invent or distort what happened.
// Types: requirement | decision | issue | question | change | result | fact
const REQ = /\b(must|should|need(?:s)? to|have to|has to|make sure|ensure|require[sd]?|i want|we want|want (?:it|you|the)|please (?:add|make|create|build|implement|fix|use|keep|support)|always|never|do not|don't|only|without|no external|at least|at most|support(?:s)? )\b/i;
const DEC = /\b(we(?:'ll| will)|let'?s (?:use|go|do|keep|switch)|i(?:'ll| will) (?:use|go with|implement|keep|switch|create)|decided|decision|chose|chosen|go(?:ing)? with|settled on|switch(?:ed)? to|plan is|approach is|instead of)\b/i;
const ISS = /\b(error|exception|fail(?:ed|s|ing|ure)?|bug|broken|doesn'?t work|not working|crash(?:es|ed)?|undefined|cannot|can'?t|typeerror|referenceerror|syntaxerror|todo|unresolved|regression|timed? out|blocked)\b/i;
const FIXED = /\b(fixed|resolved|works now|now works|passes|passing|succeeds|succeeded|no longer)\b/i;
const PATHISH = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}|`[^`]{2,60}`/;
const CHATTER = /^(ok(?:ay)?|thanks?|thank you|great|cool|nice|sure|yes|no|yep|nope|got it|sounds good|perfect|hi|hello|hey)[.!\s]*$/i;

export function sentences(text) {
  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    if (/^\s*```/.test(block)) continue; // code fences are handled as code, not prose facts
    for (const line of block.split("\n")) {
      const l = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
      if (!l || /^[`|#>]/.test(l)) continue;
      for (const s of l.split(/(?<=[.!?])\s+(?=[A-Z"'`(])/)) { const t = s.trim().replace(/\s+(?:ok(?:ay)?|thanks?|thank you|cheers)[.!\s]*$/i, ""); if (t.length >= 12 && t.length <= 400) out.push(t); }
    }
  }
  return out;
}

/** @returns {{type:string, text:string, score:number, seq:number}[]} */
export function extractFacts(seg, text) {
  const facts = []; const { role, kind, meta = {}, seq } = seg;
  const push = (type, t, score) => facts.push({ type, text: t.length > 260 ? t.slice(0, 257) + "…" : t, score, seq });

  if (kind === "tool-result") {
    const tool = meta.tool ?? "tool";
    if (["write_file", "patch_file", "delete_file", "move_file", "apply_patch"].includes(tool) && meta.path) {
      push("change", `${verb(tool)} ${meta.path}${meta.stats ? ` (${meta.stats})` : ""}${meta.ok === false ? " — FAILED" : ""}`, meta.ok === false ? 0.6 : 0.9);
    } else if (["run_tests", "run_build", "run_lint", "run_command", "typecheck"].includes(tool)) {
      push("result", `${tool}: ${meta.ok ? "PASS" : "FAIL"}${meta.summary ? ` — ${meta.summary}` : ""}`, meta.ok ? 0.7 : 0.9);
      if (meta.ok === false && meta.summary) push("issue", `${tool} failing: ${meta.summary}`, 0.85);
    } else if (meta.ok === false) push("issue", `${tool} failed${meta.path ? ` on ${meta.path}` : ""}: ${(meta.summary ?? text).slice(0, 160)}`, 0.7);
    else if (meta.path && ["read_file", "search_code", "find_symbol"].includes(tool)) push("fact", `${tool} ${meta.path}`, 0.2);
    return facts;
  }
  if (kind === "summary") return facts;
  const ss = sentences(text);
  if (role === "user") {
    for (const s of ss) {
      if (CHATTER.test(s)) continue;
      if (REQ.test(s)) push("requirement", s, 0.85);
      else if (/\?(?:\s|$)/.test(s) && s.length > 20) push("question", s, 0.6);
      else if (ISS.test(s)) push("issue", s, 0.7);
      else if (DEC.test(s)) push("decision", s, 0.7);
      else if (PATHISH.test(s)) push("fact", s, 0.4);
    }
    if (!facts.length && text.length >= 20 && !CHATTER.test(text.trim())) push("fact", ss[0] ?? text.slice(0, 200), 0.35); // keep the gist of any substantive user turn
  } else if (role === "assistant") {
    for (const s of ss) {
      if (DEC.test(s)) push("decision", s, 0.65);
      else if (FIXED.test(s)) push("fact", s, 0.5);
      else if (ISS.test(s) && !/\bno (?:errors?|issues?)\b/i.test(s)) push("issue", s, 0.5);
    }
  }
  return facts;
}
const verb = (t) => ({ write_file: "wrote", patch_file: "patched", apply_patch: "patched", delete_file: "deleted", move_file: "moved" })[t] ?? t;

/** Mark issues resolved if a later result/fix sentence overlaps them. Pure; returns new facts array. */
export function resolveIssues(facts) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []);
  return facts.map((f, i) => {
    if (f.type !== "issue") return f;
    const fw = words(f.text);
    for (let j = i + 1; j < facts.length; j++) {
      const g = facts[j];
      const okResult = g.type === "result" && /PASS/.test(g.text) && [...words(g.text)].some((w) => fw.has(w));
      const fixed = (g.type === "fact" || g.type === "decision") && FIXED.test(g.text) && [...words(g.text)].filter((w) => fw.has(w)).length >= 2;
      if (okResult || fixed) return { ...f, resolved: true, resolvedBy: g.seq };
    }
    return f;
  });
}
