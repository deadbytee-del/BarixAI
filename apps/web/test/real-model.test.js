// REAL foundation model in the REAL browser app (Qwen3.5-0.8B, ONNX Runtime Web / WASM) via the actual UI. Gated: downloads ~700MB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, site } from "./harness.js";

test("browser: download + run the real model in the infer worker and answer through the full Barix pipeline", { skip: !process.env.BARIX_REAL, timeout: 1500000 }, async () => {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const browser = await launch(proxy ? [`--proxy-server=${proxy}`, "--ignore-certificate-errors"] : []); const srv = await site("/BarixAI/");
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.addInitScript(() => { if (window.top !== window) return; if (!localStorage.getItem("__s")) { localStorage.setItem("__s", "1"); localStorage.setItem("barix.model", JSON.stringify({ id: "onnx-community/Qwen3.5-0.8B-ONNX", device: "wasm" })); localStorage.setItem("barix.projects", JSON.stringify([{ id: "rm", name: "Real", kind: "opfs" }])); localStorage.setItem("barix.project", "rm"); } });
    await page.goto(srv.url); await page.waitForFunction(() => window.__barix?.lastStatus, null, { timeout: 60000 });
    const t0 = Date.now(); await page.fill("#input", "What is the capital of France? Answer with one word."); await page.click("#btn-send");
    await page.waitForFunction(() => window.__barix.modelReady, null, { timeout: 1200000 }); const loadMs = Date.now() - t0;
    await page.waitForFunction(() => !window.__barix.busy && window.__barix.lastResult, null, { timeout: 600000 });
    const r = await page.evaluate(() => window.__barix.lastResult); const text = await page.locator(".msg.assistant").last().innerText();
    console.log(`  load+first answer ${(loadMs / 1000).toFixed(0)}s; answer=${JSON.stringify(r.answer)}; usage=${JSON.stringify(r.usage)}; isolated=${await page.evaluate(() => crossOriginIsolated)}; ${r.ms}ms inference`);
    assert.match(r.answer, /Paris/i); assert.deepEqual(errors.filter((e) => !/404|favicon/.test(e)), []);
  } finally { await browser.close(); await srv.close(); }
});
