// Small, safe Markdown renderer. Everything is HTML-escaped first; only a fixed set of tags is ever produced;
// links are limited to http(s)/mailto. No innerHTML from model text without passing through here.
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^(https?:\/\/|mailto:|#)/i.test(u.trim()) ? esc(u.trim()) : "#");
function inline(t) {
  const codes = []; t = t.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `<a href="${safeUrl(url.replace(/&amp;/g, "&"))}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}
export function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, "\n").split("\n"); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m = /^```(\w[\w+-]*)?\s*$/.exec(l);
    if (m) { const buf = []; i++; while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre data-lang="${esc(m[1] ?? "")}"><button class="copy" type="button">Copy</button><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue; }
    if (/^\s*[-*+]\s+/.test(l)) { const buf = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\s*[-*+]\s+/, ""))}</li>`); out.push(`<ul>${buf.join("")}</ul>`); continue; }
    if (/^\s*\d+[.)]\s+/.test(l)) { const buf = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>`); out.push(`<ol>${buf.join("")}</ol>`); continue; }
    if (/^\|.+\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) { const head = l.split("|").slice(1, -1).map((c) => `<th>${inline(c.trim())}</th>`).join(""); i += 2; const rows = []; while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) rows.push(`<tr>${lines[i++].split("|").slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join("")}</tr>`); out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`); continue; }
    if (!l.trim()) { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+|\|.+\|)/.test(lines[i])) buf.push(lines[i++]); out.push(`<p>${inline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}
