// Code-aware text analysis shared by lexical and vector retrieval.
// `fooBarBaz`, `foo_bar_baz`, `FooBarBaz`, `foo-bar-baz` all yield [foobarbaz, foo, bar, baz]
// so a natural-language query ("bar baz") reaches identifier-named code.
const STOP = new Set("a an and are as at be but by for from has have if in into is it its of on or that the then this to was were will with not no do does did can could should would how what when where which who why you your i we they he she them his her our us me my so than too very just also any all each more most other some such only own same both few get set new use used using".split(" "));
const CODE_STOP = new Set("var let const function return this true false null undefined void typeof import export default from class extends async await new".split(" "));

export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*|\d+/g;

/** Index-time analysis: keeps whole identifiers AND their sub-words. */
export function analyze(text, { keepStop = false, dropCodeStop = true } = {}) {
  const out = [];
  for (const m of text.matchAll(WORD)) {
    const raw = m[0];
    if (raw.length > 64 || /^\d+$/.test(raw) && raw.length > 6) continue;
    const low = raw.toLowerCase();
    const parts = split(raw);
    if (parts.length > 1) { out.push(stem(low.replace(/[_$]/g, ""))); for (const p of parts) if (keepStop || !STOP.has(p)) out.push(stem(p)); }
    else if ((keepStop || !STOP.has(low)) && !(dropCodeStop && CODE_STOP.has(low))) out.push(stem(low));
  }
  return out;
}
export function split(id) {
  return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_$]+/g, " ").toLowerCase().split(/\s+/).filter((p) => p.length > 1 || /\d/.test(p));
}
/** Query analysis: same pipeline, but stop-words dropped aggressively. */
export const analyzeQuery = (q) => analyze(q, { dropCodeStop: false });
export const wordSet = (text) => new Set(analyze(text));
export function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); }
