let _n = 0;
export const uid = (p = "id") => `${p}_${Date.now().toString(36)}${(_n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const now = () => (globalThis.performance?.now?.() ?? Date.now());
export const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true });
});
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export class BarixError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = "BarixError"; this.code = code; Object.assign(this, extra); }
}
export function posixPath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!parts.length) throw new BarixError("EPATH", `path escapes project root: ${p}`); parts.pop(); } else parts.push(seg);
  }
  return parts.join("/");
}
export const dirname = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i).toLowerCase() : ""; };
export const joinPath = (...a) => posixPath(a.join("/"));
export function* chunk(arr, n) { for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n); }
export function percentile(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }
