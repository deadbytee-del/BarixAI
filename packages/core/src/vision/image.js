// Pixel-level image intelligence (pure functions over RGBA buffers). The vision-language model gives
// semantics (what things are, what text says); these functions give measurements (what colors are,
// where blocks sit, how two renders differ). Barix merges both, so colors/positions are never guessed.
//   RGBA image: { width, height, data: Uint8ClampedArray|Uint8Array (RGBA) }
import { sha256Hex } from "../util/hash.js";

export const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Qwen-style vision token estimate (32px per token side after patch merging). */
export const estimateImageTokens = (w, h) => Math.ceil(w / 32) * Math.ceil(h / 32);

/** Dominant colors by popularity over a 4-bit/channel histogram (fast, deterministic). */
export function measurePalette({ width, height, data }, { k = 6, step } = {}) {
  const stride = step ?? Math.max(1, Math.floor(Math.sqrt((width * height) / 60000))); const bins = new Map(); let n = 0;
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    const i = (y * width + x) * 4; if (data[i + 3] < 16) continue; const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = bins.get(key) ?? bins.set(key, { c: 0, r: 0, g: 0, b: 0 }).get(key); b.c++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; n++;
  }
  const all = [...bins.values()].sort((a, b) => b.c - a.c); const out = [];
  for (const b of all) { const rgb = [b.r / b.c, b.g / b.c, b.b / b.c]; if (out.some((o) => dist(o.rgb, rgb) < 28)) { const o = out.find((o) => dist(o.rgb, rgb) < 28); o.count += b.c; continue; } out.push({ rgb, count: b.c }); }
  return out.sort((a, b) => b.count - a.count).slice(0, k).map((o) => ({ hex: hex(...o.rgb), share: +(o.count / Math.max(1, n)).toFixed(3) }));
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Layout skeleton: find rectangular blocks that differ from their surroundings on a coarse grid.
 * Returns regions (normalized 0..100 coordinates) with mean color and nesting depth — enough to
 * reproduce "a centered 50%-wide card containing a red full-width button" without a model.
 */
export function measureLayout({ width, height, data }, { cols = 96, rows } = {}) {
  rows ??= Math.max(8, Math.round(cols * height / width)); const cw = width / cols, ch = height / rows;
  const cell = []; for (let r = 0; r < rows; r++) { cell[r] = []; for (let c = 0; c < cols; c++) cell[r][c] = meanColor(data, width, Math.floor(c * cw), Math.floor(r * ch), Math.max(1, Math.floor(cw)), Math.max(1, Math.floor(ch))); }
  // background = most common quantized cell color
  const hist = new Map(); for (const row of cell) for (const px of row) { const k = q(px); hist.set(k, (hist.get(k) ?? 0) + 1); }
  const bgKey = [...hist].sort((a, b) => b[1] - a[1])[0][0]; const seen = Array.from({ length: rows }, () => Array(cols).fill(false)); const regions = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (seen[r][c] || q(cell[r][c]) === bgKey) continue;
    // seed only from stable interior cells (all 4 neighbours similar): blended edge cells would smear regions
    const stable = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dr, dc]) => { const nr = r + dr, nc = c + dc; return nr < 0 || nc < 0 || nr >= rows || nc >= cols || dist(cell[nr][nc], cell[r][c]) < 22; });
    if (!stable) continue;
    // flood fill cells of (approximately) the same color, 4-neighbour, never into background
    const base = cell[r][c]; const stack = [[r, c]]; let minR = r, maxR = r, minC = c, maxC = c, count = 0; seen[r][c] = true; const members = [];
    while (stack.length) { const [rr, cc] = stack.pop(); count++; members.push(cell[rr][cc]); minR = Math.min(minR, rr); maxR = Math.max(maxR, rr); minC = Math.min(minC, cc); maxC = Math.max(maxC, cc);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nr = rr + dr, nc = cc + dc; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen[nr][nc] || q(cell[nr][nc]) === bgKey) continue; if (dist(cell[nr][nc], base) < 22) { seen[nr][nc] = true; stack.push([nr, nc]); } } }
    const area = (maxR - minR + 1) * (maxC - minC + 1); if (count < 3 || count / area < 0.35) continue; // ignore specks and text/outline noise
    regions.push({ x: +(minC / cols * 100).toFixed(1), y: +(minR / rows * 100).toFixed(1), w: +((maxC - minC + 1) / cols * 100).toFixed(1), h: +((maxR - minR + 1) / rows * 100).toFixed(1), color: hex(...modalColor(members)), fill: +(count / area).toFixed(2) });
  }
  regions.sort((a, b) => b.w * b.h - a.w * a.h);
  for (const g of regions) g.depth = regions.filter((p) => p !== g && p.x <= g.x + 0.01 && p.y <= g.y + 0.01 && p.x + p.w >= g.x + g.w - 0.01 && p.y + p.h >= g.y + g.h - 0.01 && p.w * p.h > g.w * g.h).length;
  return { background: hex(...cell.flat().find((px) => q(px) === bgKey)), regions: regions.slice(0, 24) };
}
function modalColor(px) { const g = new Map(); for (const p of px) { const k = q(p); (g.get(k) ?? g.set(k, []).get(k)).push(p); } const top = [...g.values()].sort((a, b) => b.length - a.length)[0]; return [0, 1, 2].map((i) => top.reduce((a, p) => a + p[i], 0) / top.length); }
const q = (px) => `${px[0] >> 4}.${px[1] >> 4}.${px[2] >> 4}`;
function meanColor(data, W, x0, y0, w, h) { let r = 0, g = 0, b = 0, n = 0; const sx = Math.max(1, w >> 2), sy = Math.max(1, h >> 2); for (let y = y0; y < y0 + h; y += sy) for (let x = x0; x < x0 + w; x += sx) { const i = (y * W + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; } return [r / n, g / n, b / n]; }

/** Human-readable layout summary for the model. */
export function describeMeasured(img) {
  const pal = measurePalette(img); const lay = measureLayout(img);
  const lines = [`Measured palette: ${pal.map((p) => `${p.hex} (${Math.round(p.share * 100)}%)`).join(", ")}`, `Measured background: ${lay.background}`];
  if (lay.regions.length) { lines.push("Measured blocks (x,y,w,h in % of image; nested blocks are indented):"); for (const r of lay.regions.slice(0, 12)) lines.push(`${"  ".repeat(Math.min(r.depth, 3))}- ${r.color} at ${r.x},${r.y} size ${r.w}×${r.h}`); }
  return lines.join("\n");
}

/**
 * Compare two renders. `b` is resampled to `a`'s size. Returns an overall difference ratio, a coarse heat grid,
 * and the most-different regions with the colors found on each side — actionable for fixing CSS.
 */
export function compareImages(a, b, { grid = 24, cellThreshold = 0.08 } = {}) {
  const W = a.width, H = a.height; const sample = (img, x, y) => { const sx = Math.min(img.width - 1, Math.floor(x * img.width / W)), sy = Math.min(img.height - 1, Math.floor(y * img.height / H)); const i = (sy * img.width + sx) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const cols = grid, rows = Math.max(4, Math.round(grid * H / W)); const cw = W / cols, ch = H / rows; const heat = []; let total = 0, cells = 0;
  for (let r = 0; r < rows; r++) { heat[r] = []; for (let c = 0; c < cols; c++) {
    let d = 0, n = 0, ra = 0, ga = 0, ba = 0, rb = 0, gb = 0, bb = 0;
    for (let y = Math.floor(r * ch); y < Math.floor((r + 1) * ch); y += 3) for (let x = Math.floor(c * cw); x < Math.floor((c + 1) * cw); x += 3) { const p = sample(a, x, y), s = sample(b, x, y); d += (Math.abs(p[0] - s[0]) + Math.abs(p[1] - s[1]) + Math.abs(p[2] - s[2])) / 765; ra += p[0]; ga += p[1]; ba += p[2]; rb += s[0]; gb += s[1]; bb += s[2]; n++; }
    const score = n ? d / n : 0; heat[r][c] = { score, a: n ? [ra / n, ga / n, ba / n] : [0, 0, 0], b: n ? [rb / n, gb / n, bb / n] : [0, 0, 0] }; total += score; cells++; } }
  // merge adjacent differing cells into regions
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false)); const regions = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { if (seen[r][c] || heat[r][c].score < cellThreshold) continue; const st = [[r, c]]; seen[r][c] = true; let minR = r, maxR = r, minC = c, maxC = c, sum = 0, cnt = 0, best = heat[r][c];
    while (st.length) { const [rr, cc] = st.pop(); const h = heat[rr][cc]; sum += h.score; cnt++; if (h.score > best.score) best = h; minR = Math.min(minR, rr); maxR = Math.max(maxR, rr); minC = Math.min(minC, cc); maxC = Math.max(maxC, cc);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nr = rr + dr, nc = cc + dc; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && !seen[nr][nc] && heat[nr][nc].score >= cellThreshold) { seen[nr][nc] = true; st.push([nr, nc]); } } }
    regions.push({ x: +(minC / cols * 100).toFixed(1), y: +(minR / rows * 100).toFixed(1), w: +((maxC - minC + 1) / cols * 100).toFixed(1), h: +((maxR - minR + 1) / rows * 100).toFixed(1), score: +(sum / cnt).toFixed(2), cells: cnt, reference: hex(...best.a), current: hex(...best.b) }); }
  regions.sort((x, y) => y.score * y.cells - x.score * x.cells);
  const ratio = +(total / cells).toFixed(4); const aspect = Math.abs(a.width / a.height - b.width / b.height) > 0.02;
  return { ratio, similarity: +(1 - Math.min(1, ratio * 4)).toFixed(3), regions: regions.slice(0, 8), sizeMismatch: aspect ? `different aspect ratio (${a.width}×${a.height} vs ${b.width}×${b.height})` : null, grid: { cols, rows } };
}
export function describeComparison(c) {
  const L = [`Visual similarity ${(c.similarity * 100).toFixed(1)}% (mean difference ${(c.ratio * 100).toFixed(2)}%).${c.sizeMismatch ? " Note: " + c.sizeMismatch + "." : ""}`];
  if (!c.regions.length) L.push("No region differs noticeably."); else { L.push("Largest differences (x,y,w,h in % of image):"); for (const r of c.regions) L.push(`- ${r.x},${r.y} ${r.w}×${r.h}: reference ${r.reference} vs current ${r.current} (strength ${r.score})`); }
  return L.join("\n");
}

/** Content-addressed image store with a byte budget (LRU). Images are referenced by short ids in prompts and tools. */
export class ImageStore {
  constructor({ maxBytes = 64 * 1024 * 1024 } = {}) { this.maxBytes = maxBytes; this.map = new Map(); this.bytes = 0; }
  async add(bytes, meta = {}) {
    const hash = await sha256Hex(bytes); const id = "img_" + hash.slice(0, 8);
    if (this.map.has(id)) { const e = this.map.get(id); this.map.delete(id); this.map.set(id, e); return e; }
    const e = { id, hash, bytes, mime: meta.mime ?? sniffMime(bytes), width: meta.width, height: meta.height, name: meta.name, report: null }; this.map.set(id, e); this.bytes += bytes.length;
    while (this.bytes > this.maxBytes && this.map.size > 1) { const [k, v] = this.map.entries().next().value; this.map.delete(k); this.bytes -= v.bytes.length; }
    return e;
  }
  get(id) { return this.map.get(id) ?? null; }
  list() { return [...this.map.values()].map(({ id, mime, width, height, name, report }) => ({ id, mime, width, height, name, type: report?.type })); }
}
export function sniffMime(b) { if (b[0] === 0x89 && b[1] === 0x50) return "image/png"; if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"; if (b[0] === 0x47 && b[1] === 0x49) return "image/gif"; if (b[0] === 0x52 && b[8] === 0x57) return "image/webp"; return "application/octet-stream"; }
export const toDataURL = (bytes, mime) => `data:${mime};base64,${typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(String.fromCharCode(...bytes))}`;
