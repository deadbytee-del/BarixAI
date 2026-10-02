import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Router, UsageTracker, ScriptedProvider, OpenAICompatProvider, ThinkSplitter, toChatMessages, collect, applyStop, isOpenWeight, TransformersProvider, nodeTransformers } from "../src/providers/index.js";
import { BarixError } from "../src/util/misc.js";

const run = async (router, req = { messages: [{ role: "user", content: "hi" }] }, needs = {}) => { const evs = []; for await (const e of router.generate(req, needs)) evs.push(e); return evs; };

test("ThinkSplitter separates reasoning across arbitrary token boundaries", () => {
  const s = new ThinkSplitter(); const out = []; for (const c of ["he", "llo <th", "ink>plan ", "the ans</thi", "nk> world", "!"]) out.push(...s.push(c)); out.push(...s.flush());
  assert.equal(out.filter((e) => e.type === "token").map((e) => e.text).join(""), "hello  world!"); assert.equal(out.filter((e) => e.type === "thinking").map((e) => e.text).join(""), "plan the ans");
  assert.deepEqual(applyStop("abc</barix:call>zzz", ["</barix:call>"]), { text: "abc</barix:call>", stopped: true });
});

test("message normalization is template-agnostic", () => {
  const m = toChatMessages([{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "call" }, { role: "tool", name: "read_file", content: "R" }, { role: "user", content: "b" }]);
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "user"]); assert.match(m[3].content, /<barix:result tool="read_file">\nR\n<\/barix:result>\n\nb/);
});

test("router prefers local, fails over on error, opens circuit after repeated failures", async () => {
  const router = new Router(); const t = { v: 1_000_000 }; router.clock = () => t.v; router.limiter.now = () => t.v;
  const local = new ScriptedProvider({ id: "local", kind: "local-machine", script: [], failWith: new BarixError("EPROVIDER", "boom") });
  const pub = new ScriptedProvider({ id: "public", kind: "public-inference", script: ["from public", "again", "third", "fourth"] });
  router.register(local).register(pub);
  let evs = await run(router); assert.deepEqual(evs.filter((e) => e.type === "route").map((e) => e.provider), ["local", "public"]); assert.ok(evs.some((e) => e.type === "failover" && e.from === "local")); assert.equal((await collect((async function* () { yield* evs.filter((e) => e.type !== "route" && e.type !== "failover"); })())).text, "from public");
  await run(router); await run(router);
  assert.equal(router.status().find((s) => s.id === "local").circuitOpen, true);
  evs = await run(router); assert.deepEqual(evs.filter((e) => e.type === "route").map((e) => e.provider), ["public"], "open circuit is skipped without trying");
  t.v += 31_000 * 2; local.failWith = null; local.script.push("recovered");
  evs = await run(router); assert.equal(evs.find((e) => e.type === "route").provider, "local", "half-open: local is tried again and recovers");
});

test("router enforces capability fit (window, vision) and reports why providers were rejected", async () => {
  const router = new Router(); router.register(new ScriptedProvider({ id: "tiny", window: 1000, kind: "browser-local" })).register(new ScriptedProvider({ id: "big", window: 32000, vision: true, kind: "public-inference", script: ["ok"] }));
  assert.equal((await run(router, { messages: [{ role: "user", content: "x" }] }, { promptTokens: 5000 })).find((e) => e.type === "route").provider, "big");
  assert.equal((await run(router, { messages: [{ role: "user", content: "x" }] }, { vision: true })).find((e) => e.type === "route").provider, "big");
  await assert.rejects(run(router, { messages: [] }, { promptTokens: 90000 }), (e) => e.code === "ECAPACITY" && /tiny: window 1000 < prompt 90000/.test(e.message));
});

test("rate limits are respected, never bypassed: quota, rpm, and Retry-After cooldown", async () => {
  let t = 5_000_000; const clock = () => t; const usage = new UsageTracker({ now: clock }); const router = new Router({ usage, clock });
  router.register(new ScriptedProvider({ id: "free", kind: "public-inference", script: Array(20).fill("x") }), { limits: { requestsPerMinute: 2, monthlyTokens: 100000 } });
  await run(router); await run(router);
  await assert.rejects(run(router), (e) => e.code === "ECAPACITY" && /requests\/minute/.test(e.message));
  t += 61_000; await run(router); // window rolled over
  const limited = new ScriptedProvider({ id: "ratelimited", kind: "public-inference", failWith: new BarixError("ERATELIMIT", "slow down", { retryAfter: "120" }) }); const r2 = new Router({ usage, clock }); r2.register(limited);
  await assert.rejects(run(r2)); await assert.rejects(run(r2), (e) => /circuit open|cooling/.test(e.message)); assert.equal(limited.calls.length, 1, "no second attempt while Retry-After cooldown is active");
  const cap = router.capacity(); assert.equal(cap.target, 500_000_000); assert.ok(cap.usedThisMonth > 0); assert.match(cap.note, /below the target/);
});

test("public endpoints must serve open-weight models (no proprietary-chatbot wrapping)", () => {
  assert.equal(isOpenWeight("Qwen/Qwen3.5-4B"), true);
  assert.throws(() => new OpenAICompatProvider({ baseUrl: "https://api.example.com/v1", model: "gpt-4o", window: 128000, kind: "public-inference" }), { code: "EFOUNDATION" });
  assert.throws(() => new OpenAICompatProvider({ baseUrl: "http://localhost:8080/v1", model: "qwen3.5-4b" }), { code: "ECONFIG" });
});

test("OpenAI-compatible adapter streams SSE, strips <think>, reports usage, maps 429 to ERATELIMIT", async () => {
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith("/models")) { res.end("{}"); return; }
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = JSON.parse(body);
      if (j.messages.at(-1).content === "limit me") { res.writeHead(429, { "retry-after": "7" }); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of ["<think>hm", "m</think>Hel", "lo ", "world"]) res.write(sse({ choices: [{ delta: { content: c } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] })); res.write(sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } })); res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const p = new OpenAICompatProvider({ baseUrl: base, model: "qwen3.5-4b", window: 32768 });
    assert.equal((await p.health()).ok, true);
    const r = await collect(p.generate({ messages: [{ role: "user", content: "hi" }], maxTokens: 20 }));
    assert.equal(r.text, "Hello world"); assert.equal(r.thinking, "hmm"); assert.deepEqual([r.usage.promptTokens, r.usage.completionTokens], [11, 4]);
    await assert.rejects(collect(p.generate({ messages: [{ role: "user", content: "limit me" }] })), (e) => e.code === "ERATELIMIT" && e.retryAfter === "7");
  } finally { server.close(); }
});

test("REAL foundation model (Qwen3.5-0.8B ONNX q4, CPU) generates, streams, stops on sequences, and honors abort", { skip: !process.env.BARIX_REAL, timeout: 300000 }, async () => {
  const tf = await nodeTransformers({ cacheDir: new URL("../../../.cache/hf", import.meta.url).pathname });
  const p = new TransformersProvider({ loadTransformers: async () => tf, model: "onnx-community/Qwen3.5-0.8B-ONNX", dtype: "q4", device: "cpu", window: 8192 });
  let r = await collect(p.generate({ messages: [{ role: "system", content: "You are Barix. Be brief." }, { role: "user", content: "What is 17 * 3? Answer with just the number." }], maxTokens: 24 }));
  console.log("  real model said:", JSON.stringify(r.text), "usage", r.usage, "load ms", p.loadMs | 0);
  assert.match(r.text, /51/); assert.ok(r.usage.promptTokens > 10); assert.equal(r.thinking, "");
  r = await collect(p.generate({ messages: [{ role: "user", content: "Count from 1 to 30 separated by commas." }], maxTokens: 120, stop: ["7,"] })); assert.ok(r.text.endsWith("7,") && !r.text.includes("8")); 
  const ac = new AbortController(); let n = 0; const t0 = Date.now();
  const ar = await collect(p.generate({ messages: [{ role: "user", content: "Write a very long story about a dragon." }], maxTokens: 400, signal: ac.signal }), { onToken: () => { if (++n === 5) ac.abort(); } });
  assert.equal(ar.finishReason, "abort"); assert.ok(Date.now() - t0 < 30000);
  const exact = await p.exactCounter(); assert.ok(exact("function add(a, b) { return a + b; }") > 8);
});
