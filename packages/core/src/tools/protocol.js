// Barix tool-call protocol.
// Canonical form (what the Barix system prompt teaches):
//     <barix:call id="c1" tool="read_file">{"path": "src/a.js", "startLine": 1}</barix:call>
// The parser is deliberately lenient so any capable foundation model works: it also accepts Qwen-style
// <tool_call>{"name":..., "arguments":{...}}</tool_call>, Qwen-coder XML (<function=x><parameter=y>…),
// and fenced ```json {"tool":..., "args":...}``` blocks. Unparseable calls are reported (never silently dropped)
// so the correction loop can tell the model exactly what was wrong.
let n = 0;
const cid = () => `c${++n}`;

/** Compact tool definitions for the system prompt (name, purpose, typed params). */
export function renderToolDefs(tools) {
  return tools.map((t) => {
    const p = t.parameters?.properties ?? {}, req = new Set(t.parameters?.required ?? []);
    const sig = Object.entries(p).map(([k, s]) => `${k}${req.has(k) ? "" : "?"}: ${s.enum ? s.enum.map((e) => JSON.stringify(e)).join("|") : s.type === "array" ? `${s.items?.type ?? "any"}[]` : s.type}`).join(", ");
    return `- ${t.name}(${sig}) — ${t.description}`;
  }).join("\n");
}
export const PROTOCOL_HELP = `To use a tool, emit exactly:
<barix:call tool="TOOL_NAME">{"param": "value"}</barix:call>
The body is one JSON object. Emit at most 3 calls per reply; read-only calls run in parallel, edits run in order. Never repeat a call whose result you already have. After calls, STOP and wait: results arrive in the next message as <barix:result>. Never invent results. When you need no tool, reply normally.`;

export function parseToolCalls(text) {
  const calls = [], errors = []; const spans = [];
  const add = (index, end, tool, args, raw, id) => { calls.push({ id: id || cid(), tool, args, raw }); spans.push([index, end]); };
  const fail = (index, end, msg, raw) => { errors.push({ error: msg, raw: raw.slice(0, 300) }); spans.push([index, end]); };

  for (const m of text.matchAll(/<barix:call\b([^>]*)>([\s\S]*?)<\/barix:call>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const body = m[2].trim();
    if (!attrs.tool) { fail(m.index, m.index + m[0].length, "barix:call is missing tool=\"…\"", m[0]); continue; }
    const j = parseJsonLoose(body || "{}");
    if (j.ok) add(m.index, m.index + m[0].length, attrs.tool, j.value, m[0], attrs.id); else fail(m.index, m.index + m[0].length, `arguments for ${attrs.tool} are not valid JSON: ${j.error}`, m[0]);
  }
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    if (overlaps(spans, m.index)) continue;
    const j = parseJsonLoose(m[1]);
    if (j.ok && (j.value.name || j.value.tool)) add(m.index, m.index + m[0].length, j.value.name ?? j.value.tool, j.value.arguments ?? j.value.args ?? j.value.parameters ?? {}, m[0]);
    else if (/<function=/.test(m[1])) { const x = parseXmlFunction(m[1]); if (x) add(m.index, m.index + m[0].length, x.tool, x.args, m[0]); else fail(m.index, m.index + m[0].length, "malformed <function=…> call", m[0]); }
    else fail(m.index, m.index + m[0].length, `tool_call body is not valid JSON${j.error ? ": " + j.error : ""}`, m[0]);
  }
  for (const m of text.matchAll(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g)) {
    if (overlaps(spans, m.index)) continue; const x = parseXmlFunction(m[0]); if (x) add(m.index, m.index + m[0].length, x.tool, x.args, m[0]);
  }
  for (const m of text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)) {
    if (overlaps(spans, m.index)) continue; const j = parseJsonLoose(m[1]);
    if (j.ok && typeof j.value.tool === "string" && typeof j.value.args === "object") add(m.index, m.index + m[0].length, j.value.tool, j.value.args, m[0]);
  }
  calls.sort((a, b) => text.indexOf(a.raw) - text.indexOf(b.raw));
  // prose with call blocks removed (what the user may read) + whether the reply was cut off mid-call
  let prose = text; for (const [s, e] of [...spans].sort((a, b) => b[0] - a[0])) prose = prose.slice(0, s) + prose.slice(e);
  const danglingCall = /<barix:call\b[^>]*>(?![\s\S]*<\/barix:call>)/.test(text) || /<tool_call>(?![\s\S]*<\/tool_call>)/.test(text);
  return { calls, errors, prose: prose.trim(), danglingCall };
}
const overlaps = (spans, i) => spans.some(([s, e]) => i >= s && i < e);
function parseXmlFunction(s) {
  const f = /<function=([\w.-]+)>/.exec(s); if (!f) return null; const args = {};
  for (const p of s.matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) { const v = p[2]; try { args[p[1]] = /^[\[{"]|^(true|false|null|-?\d+(\.\d+)?)$/.test(v) ? JSON.parse(v) : v; } catch { args[p[1]] = v; } }
  return { tool: f[1], args };
}
/** JSON parse that tolerates trailing commas, single quotes around simple keys, code fences, and BOM. */
export function parseJsonLoose(s) {
  let t = s.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").replace(/^﻿/, "");
  try { return { ok: true, value: JSON.parse(t) }; } catch (e) { /* try repairs */ }
  const repaired = t.replace(/,\s*([}\]])/g, "$1").replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":');
  try { return { ok: true, value: JSON.parse(repaired) }; } catch (e) { return { ok: false, error: e.message.slice(0, 120) }; }
}

export function formatResult(call, res) {
  const head = `<barix:result id="${call.id}" tool="${call.tool}" ok="${res.ok}">`;
  return `${head}\n${res.output}\n</barix:result>`;
}
