import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeCodec, measurePalette, measureLayout, compareImages, describeComparison, describeMeasured, ImageStore, VisionPipeline, Router, ScriptedProvider, estimateImageTokens, toDataURL, sniffMime } from "../src/index.js";

const codec = await nodeCodec();
const solid = (w, h, [r, g, b]) => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4); return { width: w, height: h, data }; };
const rect = (img, x, y, w, h, [r, g, b]) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) img.data.set([r, g, b, 255], (yy * img.width + xx) * 4); return img; };
// synthetic "login page": navy background, slate card, red button
const page = (button = [239, 68, 68]) => { const im = solid(600, 400, [15, 23, 42]); rect(im, 150, 70, 300, 260, [30, 41, 59]); rect(im, 180, 250, 240, 40, button); return im; };

test("measured palette and layout recover real colors and block geometry (no model needed)", () => {
  const img = page(); const pal = measurePalette(img).map((p) => p.hex);
  assert.ok(pal[0] === "#0f172a" || pal[0] === "#0f1729", pal.join()); assert.ok(pal.some((h) => /^#1e29(3b|3a)/.test(h)) && pal.some((h) => /^#ef44(44|43)/.test(h)), pal.join());
  const lay = measureLayout(img); assert.match(lay.background, /^#0f17/);
  const card = lay.regions.find((r) => /^#1e29/.test(r.color)); const btn = lay.regions.find((r) => /^#ef44/.test(r.color));
  assert.ok(card && Math.abs(card.x - 25) < 3 && Math.abs(card.w - 50) < 4, JSON.stringify(card)); assert.ok(btn && btn.depth >= 1 && Math.abs(btn.w - 40) < 4, JSON.stringify(btn));
  assert.match(describeMeasured(img), /Measured blocks[\s\S]*#ef44/);
});

test("image comparison pinpoints WHAT differs and WHERE, with colors on both sides", () => {
  const same = compareImages(page(), page()); assert.ok(same.similarity > 0.99 && same.regions.length === 0);
  const diff = compareImages(page(), page([59, 130, 246])); // button color changed red -> blue
  assert.ok(diff.similarity < 0.99); const r = diff.regions[0]; assert.ok(r.x > 25 && r.x < 35 && r.y > 60 && r.y < 70, JSON.stringify(r)); assert.match(r.reference, /^#ef/); assert.match(r.current, /^#3b/);
  assert.match(describeComparison(diff), /reference #ef.* vs current #3b/);
  const resized = compareImages(page(), solid(300, 200, [15, 23, 42])); assert.ok(resized.similarity < 0.95); // different content, different size: still comparable
  assert.equal(estimateImageTokens(1024, 768), 32 * 24);
});

test("codec: decode/resize/encode round-trips real PNG bytes; store is content-addressed with a byte budget", async () => {
  const png = await codec.encodePNG(page()); assert.equal(sniffMime(png), "image/png");
  const back = await codec.decode(png); assert.deepEqual([back.width, back.height], [600, 400]); assert.deepEqual([...back.data.slice(0, 4)], [15, 23, 42, 255]);
  const big = await codec.encodePNG(solid(3000, 2000, [1, 2, 3])); const rs = await codec.resize(big, { maxPixels: 500_000 }); assert.ok(rs.width * rs.height <= 500_000 * 1.02 && Math.abs(rs.width / rs.height - 1.5) < 0.02);
  const store = new ImageStore({ maxBytes: png.length * 1.5 }); const a = await store.add(png); assert.equal((await store.add(png)).id, a.id); await store.add(await codec.encodePNG(solid(600, 400, [9, 9, 9]))); assert.equal(store.list().length, 1, "LRU evicted the older image under the byte budget");
});

test("pipeline: classify → type-specific perception → measured facts, images reach the provider, report is stored for re-query", async () => {
  const prompts = []; const vlm = new ScriptedProvider({ id: "vlm", kind: "local-machine", vision: true, window: 16384, script: [(req) => { prompts.push(req); return "screenshot-website"; }, (req) => { prompts.push(req); return "A centered sign-in card with heading \"Welcome back\" and a red \"Sign In\" button."; }, (req) => { prompts.push(req); return "The button says Sign In."; }] });
  const router = new Router(); router.register(vlm); const vp = new VisionPipeline({ router, codec });
  const png = await codec.encodePNG(page()); const r = await vp.analyze([{ bytes: png, name: "shot.png" }], { userText: "rebuild this login page" });
  const m1 = prompts[0].messages.at(-1); assert.ok(m1.images[0].startsWith("data:image/png;base64,")); assert.match(m1.content, /Classify this image/);
  assert.match(prompts[1].messages.at(-1).content, /rebuild this web page|rebuild/i);
  assert.match(r.text, /\[Image img_[0-9a-f]{8} · screenshot-website · 600×400\]/); assert.match(r.text, /Welcome back/); assert.match(r.text, /Measured palette: #0f17/); assert.equal(r.imageTokens, estimateImageTokens(600, 400));
  assert.equal(vp.referenceId, r.reports[0].id); assert.equal(await vp.ask(r.reports[0].id, "what does the button say?"), "The button says Sign In.");
  await assert.rejects(vp.ingest(new TextEncoder().encode("not an image")), { code: "EIMAGE" });
  const noVision = new Router(); noVision.register(new ScriptedProvider({ id: "text-only", vision: false })); await assert.rejects(new VisionPipeline({ router: noVision, codec }).analyze([{ bytes: png }]), (e) => e.code === "ECAPACITY" && /no vision support/.test(e.message));
});
