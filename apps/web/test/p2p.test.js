import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch } from "./harness.js";
import { serve } from "../../../scripts/serve.mjs";

let browser, srv, dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "barix-p2p-"));
  await writeFile(path.join(dir, "entry.js"), `
    import { WorkerHost, RemoteWorker, createInvite, acceptInvite, ScriptedProvider, HashEmbedder, collect } from "@barix/core";
    window.runP2P = async () => {
      const provider = new ScriptedProvider({ id: "m", kind: "local-machine", window: 8192, maxOutput: 512, script: ["hello over webrtc ".repeat(3)] });
      const host = new WorkerHost({ provider, embedder: new HashEmbedder(), authorize: ({ token }) => token === "424242", hardware: { kind: "webgpu" } }); host.start({ consent: true });
      const inv = await createInvite(); const guest = await acceptInvite(inv.invite);
      const [hostT, guestT] = await Promise.all([inv.accept(guest.answer), guest.transport]);
      host.accept(hostT);
      const w = await new RemoteWorker(guestT, { name: "guest", token: "424242", timeoutMs: 8000 }).connect();
      const r = await collect(w.provider().generate({ messages: [{ role: "user", content: "hi" }], maxTokens: 50 }));
      // 400KB of source forces datachannel chunking in both directions
      const big = "export const x = " + JSON.stringify("y".repeat(60)) + ";\\n"; const files = Array.from({ length: 6000 }, (_, i) => ({ path: "src/f" + i + ".js", text: big }));
      const idx = await w.indexFiles(files.slice(0, 300), {}); const t0 = performance.now(); const [v] = await w.embedder().embed(["parse config"]);
      const bad = await new RemoteWorker((await (async () => { const i2 = await createInvite(); const g2 = await acceptInvite(i2.invite); const [h2, c2] = await Promise.all([i2.accept(g2.answer), g2.transport]); host.accept(h2); return c2; })()), { name: "stranger", token: "nope", timeoutMs: 3000 }).connect().then(() => "connected", (e) => e.code);
      return { text: r.text, advert: w.advert.hardware, latencyMs: w.latencyMs, chunks: idx.chunks.length, vecLen: v.length, stranger: bad, services: w.advert.services };
    };`);
  await build({ entryPoints: [path.join(dir, "entry.js")], bundle: true, format: "iife", outfile: path.join(dir, "bundle.js"), platform: "browser", logLevel: "silent", nodePaths: [path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../node_modules")], plugins: [{ name: "stub", setup(b) { b.onResolve({ filter: /^(node:.*|sharp|ws|url|path|fs|os|module|fs\/promises)$/ }, (a) => ({ path: a.path, namespace: "s" })); b.onLoad({ filter: /.*/, namespace: "s" }, () => ({ contents: "export default {}", loader: "js" })); } }] });
  await writeFile(path.join(dir, "index.html"), `<!doctype html><script src="bundle.js"></script>`);
  browser = await launch(["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"]); srv = await serve({ dir, base: "/" });
});
after(async () => { await browser?.close(); await srv?.close(); });

test("REAL WebRTC data channel in Chromium: pairing-code auth, streamed inference, chunked bulk transfer, embeddings, stranger rejected", async () => {
  const page = await browser.newPage(); page.on("pageerror", (e) => console.log("pageerror", e)); await page.goto(srv.url);
  const r = await page.evaluate(() => window.runP2P());
  assert.match(r.text, /hello over webrtc/); assert.equal(r.advert.kind, "webgpu"); assert.deepEqual(r.services.sort(), ["embeddings", "index", "inference"]); assert.ok(r.chunks >= 300); assert.equal(r.vecLen, 384); assert.ok(["EDENIED", "ETIMEOUT", "ECLOSED"].includes(r.stranger), r.stranger);
  console.log(`  webrtc ok: handshake+hello latency ${Math.round(r.latencyMs)}ms, ${r.chunks} chunks indexed remotely`);
});

test("WebGPU capability probe (informational): reports whether this headless Chromium exposes a usable adapter", async () => {
  const page = await browser.newPage(); await page.goto(srv.url);
  const gpu = await page.evaluate(async () => { try { const a = navigator.gpu && (await navigator.gpu.requestAdapter()); return a ? { ok: true, f16: a.features.has("shader-f16"), info: a.info ? [a.info.vendor, a.info.architecture, a.info.description].join("|") : "?", maxBuffer: a.limits.maxBufferSize } : { ok: false, reason: navigator.gpu ? "no adapter" : "navigator.gpu undefined" }; } catch (e) { return { ok: false, reason: e.message }; } });
  console.log("  WebGPU in this environment:", JSON.stringify(gpu)); assert.equal(typeof gpu.ok, "boolean");
});
