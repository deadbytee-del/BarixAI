// Builds a self-contained HTML document for previewing a project page in a sandboxed iframe:
// local stylesheets, scripts and images are inlined (CSS url()s become data URLs), so rendering needs no server
// and works the same under any GitHub Pages subpath.
import { dirname, joinPath } from "@barix/core";

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };
const isLocal = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(u);
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

export async function buildPreviewDoc(fs, htmlPath) {
  if (!fs.exists(htmlPath)) throw new Error(`no such page: ${htmlPath}`);
  let html = await fs.readFile(htmlPath); const dir = dirname(htmlPath);
  const resolve = (u) => { const clean = u.split(/[?#]/)[0]; try { return joinPath(dir, clean.startsWith("/") ? clean.slice(1) : clean); } catch { return null; } };
  const dataUrl = async (u) => { const p = resolve(u); if (!p || !fs.exists(p)) return null; const ext = p.split(".").pop().toLowerCase(); return `data:${MIME[ext] ?? "application/octet-stream"};base64,${b64(await fs.readBytes(p))}`; };
  const inlineCss = async (css, cssDir) => { const out = []; let last = 0; for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) { out.push(css.slice(last, m.index)); const u = m[2]; let rep = m[0]; if (isLocal(u)) { const p = joinPath(cssDir, u.split(/[?#]/)[0]); if (fs.exists(p)) { const ext = p.split(".").pop().toLowerCase(); rep = `url(data:${MIME[ext] ?? "application/octet-stream"};base64,${b64(await fs.readBytes(p))})`; } } out.push(rep); last = m.index + m[0].length; } out.push(css.slice(last)); return out.join(""); };
  // stylesheets
  for (const m of [...html.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)]) { const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1]; if (!isLocal(href)) continue; const p = resolve(href); if (!p || !fs.exists(p)) continue; html = html.replace(m[0], `<style data-from="${p}">${await inlineCss(await fs.readFile(p), dirname(p))}</style>`); }
  // inline <style> blocks with url()
  for (const m of [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]) if (/url\(/.test(m[1])) html = html.replace(m[0], m[0].replace(m[1], await inlineCss(m[1], dir)));
  // scripts
  for (const m of [...html.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi)]) { if (!isLocal(m[2])) continue; const p = resolve(m[2]); if (!p || !fs.exists(p)) continue; const attrs = (m[1] + m[3]).replace(/\s*type=["']module["']/i, ""); html = html.replace(m[0], `<script${/type=["']module["']/i.test(m[1] + m[3]) ? ' type="module"' : ""}${attrs}>${(await fs.readFile(p)).replace(/<\/script/gi, "<\\/script")}</script>`); }
  // images
  for (const m of [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]) { if (!isLocal(m[1])) continue; const d = await dataUrl(m[1]); if (d) html = html.replace(m[0], m[0].replace(m[1], d)); }
  return html;
}
