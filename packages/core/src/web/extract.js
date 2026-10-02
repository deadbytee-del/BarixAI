// Dependency-free HTML → readable text (used by the Node bridge and by the browser fallback). Not a security boundary: output is plain text.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
export const decodeEntities = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => { if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ""; } } return ENT[e.toLowerCase()] ?? m; });

/** HTML → readable text (title, headings, paragraphs, lists, code). Dependency-free and deliberately simple. */
export function htmlToText(html) {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template|iframe|canvas|form|nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, "");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(h); if (main && main[2].length > 400) h = main[2];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${decodeEntities(c.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, c) => `\n\n${"#".repeat(+n)} ${c.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ").replace(/<(br|\/p|\/div|\/tr|\/section|\/table|\/ul|\/ol)\b[^>]*>/gi, "\n").replace(/<(p|div|tr|section)\b[^>]*>/gi, "\n")
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => { const label = t.replace(/<[^>]+>/g, "").trim(); return label && /^https?:/i.test(href) ? `${label} (${href})` : label; })
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(h).replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}

