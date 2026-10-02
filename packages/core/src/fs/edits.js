import { BarixError } from "../util/misc.js";

/**
 * Exact search/replace edits. Each edit must match exactly once unless `all`.
 * On failure the error carries the closest line so the correction loop can self-repair.
 */
export function applyEdits(content, edits) {
  let out = content;
  const applied = [];
  for (const [i, e] of edits.entries()) {
    const { search, replace = "", all = false } = e;
    if (typeof search !== "string" || search === "") throw new BarixError("EEDIT", `edit[${i}]: 'search' must be a non-empty string`);
    const count = out.split(search).length - 1;
    if (count === 0) {
      const hint = closestLine(out, search);
      throw new BarixError("EEDIT_NOMATCH", `edit[${i}]: search text not found.${hint ? ` Closest line ${hint.line}: ${JSON.stringify(hint.text)}` : ""}`, { edit: i, hint });
    }
    if (count > 1 && !all) throw new BarixError("EEDIT_AMBIGUOUS", `edit[${i}]: search text matches ${count} places; add context or set all=true`, { edit: i, count });
    out = all ? out.split(search).join(replace) : out.replace(search, () => replace);
    applied.push({ edit: i, occurrences: all ? count : 1 });
  }
  return { content: out, applied };
}

function closestLine(text, search) {
  const first = search.split("\n")[0].trim();
  if (!first) return null;
  const toks = new Set(first.split(/\W+/).filter(Boolean));
  let best = null, bs = 0;
  text.split("\n").forEach((l, idx) => {
    const lt = l.split(/\W+/).filter(Boolean);
    if (!lt.length) return;
    let s = 0;
    for (const t of lt) if (toks.has(t)) s++;
    s /= Math.max(toks.size, lt.length);
    if (s > bs) { bs = s; best = { line: idx + 1, text: l.trim().slice(0, 160) }; }
  });
  return bs > 0.3 ? best : null;
}
