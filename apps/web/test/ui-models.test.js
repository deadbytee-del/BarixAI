// Model management: cached model weights are listed with their size and can be deleted from the device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, site } from "./harness.js";

test("models stored on the device are listed in Settings and can be deleted individually", async () => {
  const srv = await site(); const browser = await launch(); const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  try {
    await page.goto(srv.url, { waitUntil: "domcontentloaded" }); await page.waitForSelector(".welcome", { timeout: 60000 });
    await page.evaluate(async () => { const c = await caches.open("transformers-cache"); for (const [m, n] of [["onnx-community/Qwen3.5-0.8B-ONNX", 1000], ["onnx-community/Qwen3.5-2B-ONNX", 2000]]) await c.put(`https://huggingface.co/${m}/resolve/main/onnx/model.onnx`, new Response(new Uint8Array(n))); });
    await page.click("#btn-settings"); await page.waitForSelector(".model-row");
    assert.equal(await page.locator(".model-row").count(), 2);
    assert.match(await page.locator(".models-list").innerText(), /Barix Lite[\s\S]*Barix Core/);
    await page.screenshot({ path: process.env.BARIX_SHOT ? process.env.BARIX_SHOT + "-settings.png" : "/dev/null" });
    page.once("dialog", (d) => d.accept());
    await page.locator('button[aria-label="Delete Barix Lite (0.8B)"]').click(); await page.waitForFunction(() => document.querySelectorAll(".model-row").length === 1);
    const left = await page.evaluate(async () => (await (await caches.open("transformers-cache")).keys()).map((r) => r.url));
    assert.equal(left.length, 1); assert.ok(left[0].includes("Qwen3.5-2B"), "only the other model remains on the device");
  } finally { await browser.close(); await srv.close?.(); }
});
