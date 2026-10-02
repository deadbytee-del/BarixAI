// Syntax-aware chunking. Code chunks follow symbol boundaries (never cutting a function in half
// unless it exceeds the budget); prose follows headings/paragraphs. Each chunk carries a contextual
// header so embeddings/BM25 see "where" the text lives, not just the text.
import { languageFor } from "./languages.js";

export function chunkFile(path, text, { symbols = [], counter, maxTokens = 400, minTokens = 60, overlapLines = 3 } = {}) {
  const lang = languageFor(path);
  const lines = text.split("\n");
  if (!text.trim()) return [];
  const tok = (a, b) => counter.count(lines.slice(a - 1, b).join("\n"));
  let units;
  if (lang?.family === "doc") units = docUnits(lines);
  else if (symbols.length && !["data", "markup"].includes(lang?.family)) units = codeUnits(lines, symbols, maxTokens, tok);
  else units = windowUnits(lines);
  // greedy packing of adjacent small units, splitting oversized ones
  const out = []; let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const u of units) {
    const t = tok(u.start, u.end);
    if (t > maxTokens * 1.25) { flush(); for (const piece of splitBig(u, lines, tok, maxTokens, overlapLines)) out.push(piece); continue; }
    if (cur && tok(cur.start, u.end) <= maxTokens && cur.heading === u.heading) { cur.end = u.end; cur.names.push(...u.names); }
    else { flush(); if (cur === null) cur = { ...u, names: [...u.names] }; }
    if (cur && tok(cur.start, cur.end) >= maxTokens * 0.8) flush();
  }
  flush();
  return out.map((u, i) => {
    const body = lines.slice(u.start - 1, u.end).join("\n");
    const names = [...new Set(u.names)].slice(0, 8);
    const header = `${path}:${u.start}-${u.end}${names.length ? ` [${names.join(", ")}]` : ""}${u.heading ? ` § ${u.heading}` : ""}`;
    return { id: `${path}#${u.start}-${u.end}`, path, startLine: u.start, endLine: u.end, text: body, header, names, tokens: counter.count(body), ordinal: i, language: lang?.id ?? "text" };
  }).filter((c) => c.text.trim());
}

function codeUnits(lines, symbols, maxTokens, tok) {
  const top = symbols.filter((s) => !s.parent).sort((a, b) => a.startLine - b.startLine);
  const units = []; let cursor = 1;
  for (const s of top) {
    if (s.startLine < cursor) continue; // nested overlap
    if (s.startLine > cursor) units.push({ start: cursor, end: s.startLine - 1, names: [], heading: "" });
    // large classes are exploded into their member symbols so retrieval can land on one method
    const members = symbols.filter((m) => m.parent === s.name && m.startLine > s.startLine && m.endLine <= s.endLine).sort((a, b) => a.startLine - b.startLine);
    if (members.length && tok(s.startLine, s.endLine) > maxTokens) {
      let c = s.startLine; const head = [s.name];
      for (const m of members) {
        if (m.startLine > c) units.push({ start: c, end: m.startLine - 1, names: head, heading: "" });
        units.push({ start: m.startLine, end: m.endLine, names: [s.name, `${s.name}.${m.name}`], heading: "" }); c = m.endLine + 1;
      }
      if (c <= s.endLine) units.push({ start: c, end: s.endLine, names: head, heading: "" });
    } else units.push({ start: s.startLine, end: s.endLine, names: [s.name], heading: "" });
    cursor = s.endLine + 1;
  }
  if (cursor <= lines.length) units.push({ start: cursor, end: lines.length, names: [], heading: "" });
  return units.filter((u) => u.end >= u.start);
}

function docUnits(lines) {
  const units = []; let start = 1, heading = "", inFence = false;
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*)/.exec(lines[i]);
    if (m && i + 1 > start) { units.push({ start, end: i, names: [], heading }); start = i + 1; }
    if (m) { stack.length = m[1].length - 1; stack[m[1].length - 1] = m[2].trim(); heading = stack.filter(Boolean).join(" › "); }
  }
  units.push({ start, end: lines.length, names: [], heading });
  return units.filter((u) => u.end >= u.start);
}

function windowUnits(lines, size = 40) {
  const units = [];
  for (let i = 0; i < lines.length; i += size) units.push({ start: i + 1, end: Math.min(lines.length, i + size), names: [], heading: "" });
  return units;
}

function splitBig(u, lines, tok, maxTokens, overlap) {
  const out = []; let s = u.start;
  while (s <= u.end) {
    let e = s, lastGood = s;
    while (e <= u.end && tok(s, e) <= maxTokens) { lastGood = e; e++; }
    // prefer a blank-line boundary in the last third
    for (let k = lastGood; k > s + (lastGood - s) * 0.66; k--) if (!lines[k - 1].trim()) { lastGood = k; break; }
    out.push({ ...u, start: s, end: lastGood });
    if (lastGood >= u.end) break;
    s = Math.max(s + 1, lastGood + 1 - overlap);
  }
  return out;
}
