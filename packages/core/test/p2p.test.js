import { test } from "node:test";
import assert from "node:assert/strict";
import { loopbackPair, WorkerHost, RemoteWorker, WorkerPool, AssetCache, validateMessage, makeAdvert, Router, ScriptedProvider, HashEmbedder, collect, sha256Hex, msg } from "../src/index.js";

const model = (o = {}) => new ScriptedProvider({ id: "wm", kind: "local-machine", window: 8192, maxOutput: 1024, script: ["hello from a volunteer"], ...o });
async function connect(host, { name = "client", token } = {}) { const [a, b] = loopbackPair(); host.accept(b); return new RemoteWorker(a, { name, token, timeoutMs: 1500 }).connect(); }

test("a worker never runs without explicit owner consent, and refuses to start silently", () => {
  const h = new WorkerHost({ provider: model() });
  assert.throws(() => h.start(), { code: "EWORKERCONSENT" }); assert.throws(() => h.start({ consent: "yes" }), { code: "EWORKERCONSENT" });
  const [a, b] = loopbackPair(); const sent = []; a.onMessage((m) => sent.push(m)); assert.equal(h.accept(b), null); // not running => connection refused
});

test("peer authorization is enforced; denied peers learn nothing", async () => {
  const act = []; const h = new WorkerHost({ provider: model(), authorize: ({ token }) => token === "pair-1234", onActivity: (e) => act.push(e.type) }); h.start({ consent: true });
  await assert.rejects(connect(h, { name: "stranger", token: "nope" }), (e) => e.code === "EDENIED" || e.code === "ETIMEOUT" || e.code === "ECLOSED");
  assert.ok(act.includes("peer-denied"));
  const w = await connect(h, { name: "friend", token: "pair-1234" }); assert.equal(w.advert.workerId, h.workerId); assert.ok(act.includes("peer-joined")); h.stop();
});

test("remote inference streams through the Router like any provider; adverts carry capability + load", async () => {
  const h = new WorkerHost({ provider: model({ script: ["streamed ", "from afar"].map((x) => x) }), embedder: new HashEmbedder(), hardware: { kind: "webgpu", cores: 8 }, authorize: () => true }); h.start({ consent: true });
  const router = new Router(); const pool = new WorkerPool(router); const [a, b] = loopbackPair(); h.accept(b); const { id } = await pool.add(a, { name: "me" });
  const st = router.status().find((s) => s.id === id); assert.equal(st.kind, "barix-worker"); assert.equal(st.window, 8192);
  const evs = []; for await (const e of router.generate({ messages: [{ role: "user", content: "hi" }], maxTokens: 50 }, { promptTokens: 10 })) evs.push(e);
  assert.equal(evs.find((e) => e.type === "route").provider, id); assert.match((await collect((async function* () { yield* evs.filter((e) => e.type === "token" || e.type === "done"); })())).text, /hello from a volunteer|streamed/);
  assert.equal(pool.list()[0].services.sort().join(), "embeddings,index,inference"); assert.equal(pool.list()[0].hardware.kind, "webgpu");
  // privacy: local-only requests never leave the machine
  await assert.rejects(router.generate({ messages: [] }, { localOnly: true }).next(), (e) => e.code === "ECAPACITY" && /local-only/.test(e.message)); h.stop();
});

test("cancellation reaches the worker; capacity limits and per-peer rate limits return honest errors", async () => {
  let aborted = false;
  const slow = new ScriptedProvider({ id: "slow", kind: "local-machine", window: 8192, maxOutput: 1024, delayMs: 20, script: [() => "x".repeat(2000)] });
  const orig = slow.generate.bind(slow); slow.generate = async function* (req) { req.signal.addEventListener("abort", () => (aborted = true)); yield* orig(req); };
  const h = new WorkerHost({ provider: slow, authorize: () => true, maxConcurrent: 1, requestsPerMinute: 3 }); h.start({ consent: true });
  const w = await connect(h); const p = w.provider(); const ac = new AbortController(); let n = 0;
  const r = await collect(p.generate({ messages: [{ role: "user", content: "go" }], maxTokens: 500, signal: ac.signal }), { onToken: () => { if (++n === 3) ac.abort(); } });
  assert.ok(aborted, "worker's provider saw the abort"); assert.ok(r.text.length < 2000);
  slow.script.push(() => "y".repeat(500)); const first = collect(p.generate({ messages: [{ role: "user", content: "a" }], maxTokens: 50 }));
  await new Promise((r) => setTimeout(r, 30)); await assert.rejects(collect(p.generate({ messages: [{ role: "user", content: "b" }], maxTokens: 50 })), (e) => e.code === "EBUSY"); await first; slow.script.push(() => "d"); await collect(p.generate({ messages: [{ role: "user", content: "d" }], maxTokens: 50 })); // 3rd accepted request this minute
  await assert.rejects(collect(p.generate({ messages: [{ role: "user", content: "c" }], maxTokens: 50 })), (e) => e.code === "ERATELIMIT"); h.stop();
});

test("untrusted-peer input is validated: bad shapes, unknown services, oversize prompts", async () => {
  assert.throws(() => validateMessage({ v: 2, t: "ping" }), { code: "EPROTO" }); assert.throws(() => validateMessage({ v: 1, t: "request", id: "1", service: "shell", payload: {} }), /unknown service/);
  assert.throws(() => validateMessage({ v: 1, t: "request", id: "1", service: "inference", payload: { messages: [{ role: 1 }] } }), /bad message shape/);
  const h = new WorkerHost({ provider: model(), authorize: () => true, maxPromptTokens: 200 }); h.start({ consent: true }); const w = await connect(h);
  await assert.rejects(collect(w.provider().generate({ messages: [{ role: "user", content: "word ".repeat(2000) }], maxTokens: 10 })), (e) => e.code === "ECONTEXT"); h.stop();
});

test("embeddings and repository-index offload return usable vectors", async () => {
  const emb = new HashEmbedder(); const h = new WorkerHost({ embedder: emb, authorize: () => true }); h.start({ consent: true }); const w = await connect(h);
  const [v] = await w.embedder().embed(["parse the config file"]); const local = (await emb.embed(["parse the config file"]))[0]; assert.equal(v.length, 384); assert.ok(Math.abs(v[5] - local[5]) < 1e-6);
  const r = await w.indexFiles([{ path: "src/a.js", text: "export function parseConfig(s) { return JSON.parse(s); }\n" }, { path: "README.md", text: "# Title\nSome docs about config.\n" }]);
  assert.ok(r.chunks.length >= 2 && r.chunks[0].vec instanceof Float32Array && r.embedderId === emb.id); h.stop();
});

test("asset cache: integrity is verified by the requester; poisoned bytes are rejected", async () => {
  const good = new TextEncoder().encode("model shard bytes"); const cache = new AssetCache(); const hash = await cache.put(good);
  const h = new WorkerHost({ authorize: () => true, assets: cache, provider: model() }); h.start({ consent: true }); const w = await connect(h);
  assert.deepEqual(await w.fetchAsset(hash), good);
  await assert.rejects(w.fetchAsset(await sha256Hex("something we never cached")), (e) => e.code === "ENOASSET");
  const evil = new AssetCache(); evil.map.set(hash, new TextEncoder().encode("MALICIOUS")); // peer lies about content under a trusted hash
  const h2 = new WorkerHost({ authorize: () => true, assets: evil, provider: model() }); h2.start({ consent: true }); const w2 = await connect(h2);
  await assert.rejects(w2.fetchAsset(hash), (e) => e.code === "EINTEGRITY"); await assert.rejects(new AssetCache().receive(hash, new TextEncoder().encode("MALICIOUS")), { code: "EINTEGRITY" });
  h.stop(); h2.stop();
});

test("worker disappearing mid-stream: router fails over to another provider and unregisters the dead worker", async () => {
  const h = new WorkerHost({ provider: new ScriptedProvider({ id: "wm", kind: "local-machine", window: 8192, maxOutput: 512, delayMs: 15, script: ["z".repeat(600)] }), authorize: () => true }); h.start({ consent: true });
  const router = new Router(); const pool = new WorkerPool(router); const [a, b] = loopbackPair(); h.accept(b); const { id } = await pool.add(a);
  router.register(new ScriptedProvider({ id: "fallback", kind: "public-inference", window: 8192, script: ["recovered locally"] }));
  const evs = []; let n = 0; for await (const e of router.generate({ messages: [{ role: "user", content: "x" }], maxTokens: 400 }, { promptTokens: 5 })) { evs.push(e); if (e.type === "token" && ++n === 2) a.close(); }
  assert.deepEqual(evs.filter((e) => e.type === "route").map((e) => e.provider), [id, "fallback"]); assert.ok(evs.some((e) => e.type === "failover" && e.reset));
  assert.equal(pool.list().length, 0); assert.ok(!router.status().some((s) => s.id === id)); h.stop();
});
