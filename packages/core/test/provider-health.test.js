import { test } from "node:test";
import assert from "node:assert/strict";
import { TransformersProvider } from "../src/index.js";

test("built-in model health never waits for a slow first-run load, and reports a failed load with its real reason", async () => {
  let fail; const loading = new Promise((_, rej) => (fail = rej));
  const p = new TransformersProvider({ loadTransformers: () => loading, model: "x/y", window: 4096 });
  p.load().catch(() => {});                                  // a first-run download/initialisation in progress
  const t0 = Date.now(); const h = await p.health(); assert.ok(h.ok && Date.now() - t0 < 100, "health must not block on the load (the router allows ~1.5 s)");
  fail(new Error("onnxruntime-node: DLL load failed")); await new Promise((r) => setTimeout(r, 10));
  const h2 = await p.health(); assert.equal(h2.ok, false); assert.match(h2.reason, /DLL load failed/, "the real reason is surfaced, not a vague capacity error");
});
