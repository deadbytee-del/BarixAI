import { test } from "node:test";
import assert from "node:assert/strict";
import { BM25Index, VectorIndex, HashEmbedder, TransformersEmbedder, HybridIndex, analyze, normalize } from "../src/retrieval/index.js";

test("analyzer splits identifiers but keeps the whole token", () => {
  assert.deepEqual(analyze("fooBarBaz"), ["foobarbaz", "foo", "bar", "baz"]);
  assert.deepEqual(analyze("parse_http_Request"), ["parsehttprequest", "parse", "http", "request"]);
  assert.ok(!analyze("the quick fox").includes("the"));
});

test("BM25: natural-language query reaches camelCase code; add/remove are incremental", () => {
  const ix = new BM25Index();
  ix.add("a", "function deleteUserAccount(userId) { db.remove(userId) }");
  ix.add("b", "function renderSidebar() { return html }");
  ix.add("c", "// remove cached thumbnails from disk");
  assert.equal(ix.search("delete user account")[0].id, "a");
  assert.equal(ix.search("deleteUserAccount")[0].id, "a");
  ix.remove("a"); assert.equal(ix.search("delete user account").length, 0);
  const j = BM25Index.fromJSON(JSON.parse(JSON.stringify(ix.toJSON())));
  assert.equal(j.search("sidebar")[0].id, "b");
});

test("vector index: int8 quantization keeps exact top-k on random data; remove/reuse rows; persistence", () => {
  const dim = 64, n = 2000, rnd = () => normalize(Float32Array.from({ length: dim }, () => Math.random() - 0.5));
  const q8 = new VectorIndex(dim, { quantize: true }), f32 = new VectorIndex(dim, { quantize: false }); const vs = [];
  for (let i = 0; i < n; i++) { const v = rnd(); vs.push(v); q8.add("v" + i, v); f32.add("v" + i, v); }
  let agree = 0; for (let t = 0; t < 50; t++) { const q = rnd(); const a = q8.search(q, { k: 10 }).map((x) => x.id), b = f32.search(q, { k: 10 }).map((x) => x.id); agree += a.filter((x) => b.includes(x)).length / 10; }
  assert.ok(agree / 50 > 0.93, `recall@10 vs float32 = ${agree / 50}`);
  assert.ok(q8.memoryBytes() < f32.memoryBytes() / 3);
  q8.remove("v0"); q8.add("new", vs[5]); assert.equal(q8.search(vs[5], { k: 2 }).map((x) => x.id).sort().join(), "new,v5");
  const r = VectorIndex.fromBuffer(q8.toBuffer()); assert.equal(r.search(vs[7], { k: 1 })[0].id, "v7"); assert.equal(r.size, q8.size);
});

const corpus = [
  ["auth.js#1", "export async function loginUser(email, password) { const user = await db.findUser(email); return verifyPassword(user, password); }", "src/auth.js:1-8 [loginUser]"],
  ["auth.js#2", "export function logoutUser(session) { session.destroy(); }", "src/auth.js:10-12 [logoutUser]"],
  ["db.js#1", "export function findUser(email) { return query('SELECT * FROM users WHERE email = ?', email); }", "src/db.js:1-3 [findUser]"],
  ["ui.js#1", "export function renderSidebar(items) { return items.map(renderItem).join('') }", "src/ui.js:1-3 [renderSidebar]"],
  ["ui.js#2", "export function renderSidebarCopy(items) { return items.map(renderItem).join('') }", "src/ui.js:5-7 [renderSidebarCopy]"],
  ["cfg.js#1", "export const config = { port: 8080, host: 'localhost' }", "src/cfg.js:1 [config]"],
];
async function build(embedder) {
  const ix = new HybridIndex({ embedder });
  for (const [id, text, header] of corpus) ix.add({ id, text, header, names: [header.match(/\[(.*)\]/)[1]], meta: { path: id.split("#")[0] } });
  await ix.flush(); return ix;
}

test("hybrid search with hash embedder: lexical + vector fusion, filters, symbol boost, MMR de-dup", async () => {
  const ix = await build(new HashEmbedder());
  const r = await ix.search("how does a user log in with a password", { k: 3 });
  assert.equal(r[0].id, "auth.js#1"); assert.ok(r[0].sources.lexical && r[0].sources.vector);
  assert.equal((await ix.search("sidebar", { k: 5 })).filter((x) => x.id.startsWith("ui.js")).length, 2);
  const dedup = await ix.search("renderSidebar items", { k: 2 }); assert.ok(dedup.some((x) => x.id === "ui.js#1"));
  const f = await ix.search("user", { k: 5, filter: (id, m) => m.path === "db.js" }); assert.deepEqual(f.map((x) => x.id), ["db.js#1"]);
  const sym = await ix.search("config", { k: 3, symbolHits: new Map([["cfg.js#1", 5]]) }); assert.equal(sym[0].id, "cfg.js#1");
  const re = HybridIndex.deserialize(JSON.parse(JSON.stringify(ix.serialize(), (k, v) => ArrayBuffer.isView(v) ? { __ta: v.constructor.name, d: [...v] } : v), (k, v) => v?.__ta ? new globalThis[v.__ta](v.d) : v), { embedder: new HashEmbedder() });
  assert.equal((await re.search("log in password", { k: 1 }))[0].id, "auth.js#1");
});

test("embedding cache: identical content is never re-embedded", async () => {
  let calls = 0; const base = new HashEmbedder(); const counting = { id: base.id, dim: base.dim, embed: async (t, o) => { calls += t.length; return base.embed(t, o); } };
  const ix = new HybridIndex({ embedder: counting }); ix.add({ id: "x", text: "same text here", header: "h" }); await ix.flush(); assert.equal(calls, 1);
  ix.add({ id: "y", text: "same text here", header: "h" }); await ix.flush(); assert.equal(calls, 1); assert.equal(ix.stats.embedCacheHits, 1);
});

test("REAL neural embeddings (MiniLM via Transformers.js) find synonyms that lexical search cannot", { skip: !process.env.BARIX_REAL }, async () => {
  const { env } = await import("@huggingface/transformers"); env.cacheDir = new URL("../../../.cache/hf", import.meta.url).pathname;
  const emb = new TransformersEmbedder({ loadTransformers: () => import("@huggingface/transformers") });
  const ix = new HybridIndex({ embedder: emb, weights: { lexical: 0.3, vector: 1.5 } });
  ix.add({ id: "kill", text: "function terminateProcess(pid) { process.kill(pid) }", header: "proc.js" });
  ix.add({ id: "paint", text: "function drawRectangle(ctx, x, y) { ctx.fillRect(x, y, 10, 10) }", header: "gfx.js" });
  ix.add({ id: "sum", text: "function addNumbers(a, b) { return a + b }", header: "math.js" });
  await ix.flush();
  const t0 = performance.now(); const r = await ix.search("stop a running program", { k: 3 }); console.log("neural query ms", (performance.now() - t0).toFixed(0), r.map((x) => x.id).join());
  assert.equal(r[0].id, "kill"); assert.equal(ix.bm25.search("stop a running program").length, 0, "lexical alone finds nothing");
});
