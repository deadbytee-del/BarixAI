import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBarix, NodeBackend, nodeTreeSitter, nodeCodec, ScriptedProvider, compareImages, TransformersProvider, nodeTransformers, VisionPipeline, Router } from "@barix/core";
import { createBrowserCapability, findBrowser } from "../src/browser.js";

const BROWSER = findBrowser();
const page = ({ bg, card, btn, fg }) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:${card};padding:40px 48px;border-radius:16px;width:360px}
h1{margin:0 0 8px;font-size:28px}button{width:100%;padding:12px;border:0;border-radius:8px;background:${btn};color:#fff;font-weight:700;font-size:16px;margin-top:20px}
</style></head><body><div class="card"><h1>Welcome back</h1><p>Sign in to Acme Cloud</p><button>Sign In</button></div></body></html>`;
const GOLD = { bg: "#0f172a", card: "#1e293b", btn: "#ef4444", fg: "#ffffff" }, BROKEN = { bg: "#ffffff", card: "#eeeeee", btn: "#2563eb", fg: "#000000" };
const call = (tool, args) => `<barix:call tool="${tool}">${JSON.stringify(args)}</barix:call>`;

async function rig(script) {
  const root = await mkdtemp(join(tmpdir(), "barix-vis-")); const browser = createBrowserCapability({ root });
  await writeFile(join(root, "gold.html"), page(GOLD)); const refPng = await browser.screenshot({ target: "gold.html", width: 900, height: 600 });
  await writeFile(join(root, "index.html"), page(BROKEN));
  const model = new ScriptedProvider({ id: "vlm", kind: "local-machine", vision: true, window: 32768, maxOutput: 2048, script });
  const b = await createBarix({ backend: await NodeBackend.create(root), runtime: await nodeTreeSitter(), providers: [model], codec: await nodeCodec(), browser, capabilities: {}, env: "term", extraCtx: { root } });
  b.fs.ignore.add("gold.html"); // keep the reference page out of the project tree
  return { b, root, refPng, model, browser };
}
const fix = (from, to) => ({ search: from, replace: to, all: true });

test("vision + coding with REAL browser renders: analyze image → edit → render → compare → feed back → converge", { skip: !BROWSER && "no Chrome/Edge/Chromium found" }, async () => {
  const { b, refPng, browser, root } = await rig([
    "screenshot-website", "A dark sign-in card centered on a dark navy page, heading \"Welcome back\", red \"Sign In\" button.",   // vision: classify + perceive
    call("read_file", { path: "index.html" }),
    call("patch_file", { path: "index.html", edits: [fix("background:#ffffff", "background:#0f172a"), fix("color:#000000", "color:#ffffff")] }),   // attempt 1: page colors only
    "I updated the page background and text color in `index.html`.",
    call("patch_file", { path: "index.html", edits: [fix("background:#eeeeee", "background:#1e293b"), fix("background:#2563eb", "background:#ef4444")] }),   // attempt 2: after Barix feeds back the measured diff
    "I updated `index.html` so the card and button match your screenshot.",
  ]);
  const events = []; const before = compareImages(await b.vision.codec.decode(refPng), await b.vision.codec.decode(await browser.screenshot({ target: "index.html", width: 900, height: 600 })));
  const r = await b.ask("Make my page look like this screenshot", { images: [{ bytes: refPng, name: "ref.png" }], onEvent: (e) => events.push(e) });
  assert.equal(r.plan.intent, "vision-coding"); assert.ok(events.some((e) => e.type === "vision"), "vision pass ran inside the pipeline");
  const gates = events.filter((e) => e.type === "gate").map((e) => e.action); assert.equal(gates.length, 2, JSON.stringify(gates));
  const after = compareImages(await b.vision.codec.decode(refPng), await b.vision.codec.decode(await browser.screenshot({ target: "index.html", width: 900, height: 600 })));
  console.log(`  similarity before ${(before.similarity * 100).toFixed(1)}% → after ${(after.similarity * 100).toFixed(1)}%; rounds ${gates.length}`);
  assert.ok(before.similarity < 0.6 && after.similarity > 0.97, `${before.similarity} → ${after.similarity}`);
  assert.match(r.text, /Barix rendered index\.html and compared it with your image: \d+\.\d% visually similar/); assert.equal(r.ok, true);
  assert.equal(b.ledger.last("visual-compare").data.similarity > 0.93, true); assert.equal((await b.fs.readFile("index.html")).includes("#ef4444"), true);
  // the feedback the model received after attempt 1 contained MEASURED facts (colors + regions), not guesses
  const feedback = (await b.store.readText(b.store.live().find((s) => /Visual similarity/.test(s.preview))?.id ?? b.store.live().at(-1).id)); assert.match(feedback, /reference #|Largest differences/);
});

test("REAL vision model reads a real browser screenshot and Barix adds measured colors (Qwen3.5-0.8B ONNX on CPU)", { skip: !process.env.BARIX_REAL || (!BROWSER && "no browser"), timeout: 600000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "barix-vis-")); const browser = createBrowserCapability({ root }); await writeFile(join(root, "p.html"), page(GOLD)); const png = await browser.screenshot({ target: "p.html", width: 900, height: 600 });
  const tf = await nodeTransformers({ cacheDir: new URL("../../../.cache/hf", import.meta.url).pathname });
  const vlm = new TransformersProvider({ loadTransformers: async () => tf, model: "onnx-community/Qwen3.5-0.8B-ONNX", dtype: "q4", device: "cpu", window: 8192, maxOutput: 400, vision: true });
  const router = new Router(); router.register(vlm); const vp = new VisionPipeline({ router, codec: await nodeCodec(), reportTokens: 160 });
  const t0 = Date.now(); const r = await vp.analyze([{ bytes: png, name: "p.png" }], { userText: "rebuild this page" });
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s\n` + r.text.split("\n").map((l) => "  | " + l).join("\n"));
  assert.match(r.text, /Welcome back|Sign In/i, "the VLM transcribed visible text"); assert.match(r.text, /Measured palette: #0f172a/, "colors come from pixels, not from the model"); assert.match(r.text, /#ef4444/);
});
