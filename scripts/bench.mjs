// Barix benchmark suite → docs/benchmarks.json + docs/BENCHMARKS.md. Real measurements on THIS machine; nothing simulated except where stated.
// usage: node --expose-gc scripts/bench.mjs [--no-model] [--out docs]
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, cpus, totalmem, platform, arch } from "node:os";
import path from "node:path";
import { createBarix, BarixFS, MemoryBackend, NodeBackend, nodeTreeSitter, ProjectIntelligence, TokenCounter, TransformersProvider, nodeTransformers, collect, HybridIndex, HashEmbedder, TransformersEmbedder, estimateTokens } from "../packages/core/src/index.js";
import { percentile } from "../packages/core/src/util/misc.js";

const args = process.argv.slice(2); const noModel = args.includes("--no-model"); const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs";
const R = { machine: { cpu: cpus()[0].model, cores: cpus().length, ramGB: +(totalmem() / 2 ** 30).toFixed(1), platform: `${platform()}/${arch()}`, node: process.version }, date: new Date().toISOString() };
const ms = (t) => +(performance.now() - t).toFixed(2); const stat = (a) => { a = [...a].sort((x, y) => x - y); return { p50: +percentile(a, 0.5).toFixed(2), p95: +percentile(a, 0.95).toFixed(2), max: +a.at(-1).toFixed(2), n: a.length }; };
const log = (...a) => console.error("[bench]", ...a);
const gc = () => global.gc?.();

// ---------------------------------------------------------------- filesystem
{
  log("filesystem");
  const root = await mkdtemp(path.join(tmpdir(), "bfs-")); const out = {};
  for (const [name, mk] of [["memory", async () => new MemoryBackend()], ["node-disk", async () => NodeBackend.create(root)]]) {
    const fs = await new BarixFS(await mk(), { versioning: true }).init(); const N = 1500; const body = "export const x = 1;\n".repeat(60);
    let t = performance.now(); for (let i = 0; i < N; i++) await fs.writeFile(`src/d${i % 30}/f${i}.js`, body + i); const w = ms(t);
    t = performance.now(); for (let i = 0; i < N; i++) await fs.readFile(`src/d${i % 30}/f${i}.js`); const r = ms(t);
    t = performance.now(); for (let i = 0; i < 300; i++) await fs.patchFile(`src/d${i % 30}/f${i}.js`, [{ search: "export const x = 1;", replace: "export const x = 2;", all: false }].map((e) => ({ ...e, all: true }))); const p = ms(t);
    t = performance.now(); const hits = await fs.grep("const x = 2", { glob: "src/d1/*.js", maxResults: 1000 }); const g = ms(t);
    t = performance.now(); const a = await fs.audit(); const au = ms(t);
    out[name] = { files: N, writeOpsPerSec: Math.round(N / (w / 1000)), readOpsPerSec: Math.round(N / (r / 1000)), patchOpsPerSec: Math.round(300 / (p / 1000)), grepMs: g, grepHits: hits.length, auditMs: au, auditOk: a.ok };
  }
  R.filesystem = out;
}

// ---------------------------------------------------------------- indexing & retrieval
{
  log("indexing/retrieval");
  const rt = await nodeTreeSitter(); const fs = await new BarixFS(new MemoryBackend(), { versioning: false }).init(); const counter = new TokenCounter();
  const FILES = 800; const words = ["parse", "config", "render", "user", "account", "session", "token", "cache", "queue", "event", "stream", "buffer", "index", "match", "route", "handler", "client", "server", "model", "view"];
  const rnd = (() => { let s = 7; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })(); const w = () => words[Math.floor(rnd() * words.length)];
  for (let i = 0; i < FILES; i++) { let src = `import { ${w()}Helper } from "./f${(i + 1) % FILES}.js";\n`; for (let k = 0; k < 8; k++) src += `export function ${w()}${w()[0].toUpperCase() + w().slice(1)}${i}_${k}(${w()}, ${w()}) {\n  const ${w()} = ${w()}Helper(${w()});\n  if (${w()}) { return ${w()}.${w()}(${w()}); }\n  return ${w()};\n}\n\n`; await fs.writeFile(`src/m${i % 20}/f${i}.js`, src); }
  await fs.writeFile("src/m3/target.js", "export function reconcileLedgerEntries(ledger, bank) {\n  // match each bank transaction to an invoice and flag mismatches\n  return ledger.filter((e) => !bank.has(e.id));\n}\n");
  const intel = new ProjectIntelligence({ fs, runtime: rt, counter }); let t = performance.now(); await intel.indexAll(); const full = ms(t);
  const h = intel.health(); gc(); const heap = process.memoryUsage().heapUsed / 1048576;
  const q = ["where do we reconcile ledger entries with the bank?", "parse config handler", "reconcileLedgerEntries", "render session token", "queue event stream buffer"]; const lat = []; let top1 = null;
  for (let rep = 0; rep < 30; rep++) for (const query of q) { t = performance.now(); const r = await intel.retrieve(query, { budgetTokens: 3000, k: 8 }); lat.push(ms(t)); if (query.startsWith("where do we")) top1 = r.items[0]?.path; }
  await fs.writeFile("src/m5/f5.js", (await fs.readFile("src/m5/f5.js")) + "\nexport const added = 1;\n"); t = performance.now(); await intel.sync(); const incr = ms(t);
  const before = intel.symbols.parseCount; t = performance.now(); await intel.indexAll(); const reindex = ms(t);
  R.indexing = { files: FILES, symbols: h.symbols, chunks: h.chunks, fullIndexMs: +full.toFixed(0), filesPerSec: Math.round(FILES / (full / 1000)), incrementalUpdateMs: +incr.toFixed(1), noChangeReindexMs: +reindex.toFixed(1), reparsesOnNoChange: intel.symbols.parseCount - before, heapMB: +heap.toFixed(1), retrievalMs: stat(lat), semanticQueryTop1: top1, parser: { treeSitter: h.treeSitterFiles, fallback: h.scannerFiles } };
}

// ---------------------------------------------------------------- context engine at scale (re-run of the 3.5M-token benchmark)
{
  log("context 3.5M (separate process)");
  const { execFileSync } = await import("node:child_process");
  R.context3_5M = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "scripts/bench-context.mjs", "3500000", "32768"], { encoding: "utf8", maxBuffer: 1 << 26 }));
}

// ---------------------------------------------------------------- model + tokenizer + neural embeddings
if (!noModel) {
  log("real model");
  const tf = await nodeTransformers({ cacheDir: new URL("../.cache/hf", import.meta.url).pathname });
  const prov = new TransformersProvider({ loadTransformers: async () => tf, model: "onnx-community/Qwen3.5-0.8B-ONNX", dtype: "q4", device: "cpu", window: 8192 });
  let t = performance.now(); await prov.load(); const loadWarm = ms(t);
  const exact = await prov.exactCounter(); const samples = [await (await import("node:fs/promises")).readFile("packages/core/src/context/engine.js", "utf8"), await (await import("node:fs/promises")).readFile("README.md", "utf8").catch(() => "# readme\n".repeat(200)), "The quick brown fox jumps over the lazy dog. ".repeat(80)];
  const cal = samples.map((s) => ({ est: estimateTokens(s), real: exact(s) })); const err = cal.map((c) => Math.abs(c.est - c.real) / c.real);
  const fresh = new TokenCounter({ exact }); const scale = await fresh.calibrate(samples); const err2 = samples.map((s) => Math.abs(fresh.count(s) - exact(s)) / exact(s));
  t = performance.now(); for (let i = 0; i < 20; i++) for (const s of samples) exact(s); const tokMs = ms(t); t = performance.now(); const c2 = new TokenCounter(); for (let i = 0; i < 20; i++) for (const s of samples) c2.count(s + i % 1); const estMs = ms(t);
  const gen = async (nPrompt, maxTokens) => { const text = ("function f(x) { return x + 1; } // filler line\n").repeat(Math.ceil(nPrompt / 14)); const t0 = performance.now(); let first = null, n = 0; const r = await collect(prov.generate({ messages: [{ role: "user", content: text + "\nSummarize in one sentence." }], maxTokens, temperature: 0 }), { onToken: () => { if (first === null) first = performance.now() - t0; n++; } }); return { promptTokens: r.usage.promptTokens, firstTokenMs: Math.round(first), completionTokens: r.usage.completionTokens, totalMs: Math.round(performance.now() - t0), decodeTokPerSec: +((r.usage.completionTokens - 1) / ((performance.now() - t0 - first) / 1000)).toFixed(2) }; };
  await gen(50, 4); const runs = []; for (const n of [100, 800, 3000]) runs.push(await gen(n, 48));
  R.model = { id: "Qwen3.5-0.8B ONNX q4 (CPU, onnxruntime-node)", loadWarmMs: Math.round(loadWarm), runs, prefillTokPerSec: runs.map((r) => Math.round(r.promptTokens / (r.firstTokenMs / 1000))) };
  R.tokenizer = { estimatorErrorPct: err.map((e) => +(e * 100).toFixed(1)), calibratedScale: +scale.toFixed(3), calibratedErrorPct: err2.map((e) => +(e * 100).toFixed(1)), realTokenizerCallsPerSec: Math.round(60 / (tokMs / 1000)), cachedEstimatorCallsPerSec: Math.round(60 / (estMs / 1000)) };
  log("neural embeddings");
  const ne = new TransformersEmbedder({ loadTransformers: async () => tf }); const docs = Array.from({ length: 64 }, (_, i) => `function handler${i}(req, res) { const user = db.find(req.params.id); return res.json(user); }`);
  t = performance.now(); await ne.embed(docs.slice(0, 2)); const loadE = ms(t); t = performance.now(); await ne.embed(docs); const emb = ms(t); const he = new HashEmbedder(); t = performance.now(); await he.embed(docs); const hm = ms(t);
  R.embeddings = { neuralModel: "Xenova/all-MiniLM-L6-v2 q8", neuralLoadMs: Math.round(loadE), neuralChunksPerSec: Math.round(64 / (emb / 1000)), hashChunksPerSec: Math.round(64 / (hm / 1000)) };
}
R.memoryMB = { rss: +(process.memoryUsage().rss / 1048576).toFixed(0) };

await mkdir(outDir, { recursive: true }); await writeFile(path.join(outDir, "benchmarks.json"), JSON.stringify(R, null, 2));
const f = (x) => x ?? "n/a"; const M = R.model;
const md = `# Barix benchmarks

Measured ${R.date} on **${R.machine.cpu}**, ${R.machine.cores} cores, ${R.machine.ramGB} GB RAM, ${R.machine.platform}, Node ${R.machine.node}. CPU only (no GPU). Reproduce: \`npm run bench\`.

## Foundation model (real inference)
${M ? `Model: ${M.id}. Warm load ${M.loadWarmMs} ms.

| prompt tokens | first-token latency | decode tok/s | prefill tok/s |
|---|---|---|---|
${M.runs.map((r, i) => `| ${r.promptTokens} | ${r.firstTokenMs} ms | ${r.decodeTokPerSec} | ${M.prefillTokPerSec[i]} |`).join("\n")}
` : "_skipped (--no-model)_"}
## Context engine at the 3.5M-token target (32k window)
- Segments ${R.context3_5M.segments}, total ${R.context3_5M.totalTokens} tokens, ingest+compaction ${R.context3_5M.ingestSec}s (${R.context3_5M.tokensPerSecIngest} tok/s)
- Planted facts recovered: **${R.context3_5M.needlesFound}/${R.context3_5M.needlesPlanted}**; context build p50 ${R.context3_5M.buildMs.p50} ms, p95 ${R.context3_5M.buildMs.p95} ms
- Heap ${R.context3_5M.memoryMB.heapAfter} MB, RSS ${R.context3_5M.memoryMB.rss} MB; raw text resident in RAM: ${R.context3_5M.memoryMB.pageCacheResidentChars} chars of ${(R.context3_5M.corpusMB)} MB corpus
- Summaries kept: ${R.context3_5M.summaries} (${R.context3_5M.summaryTokens} tokens total)

## Code indexing & retrieval (${R.indexing.files} files, ${R.indexing.symbols} symbols, ${R.indexing.chunks} chunks)
- Full index ${R.indexing.fullIndexMs} ms (${R.indexing.filesPerSec} files/s); one-file incremental update ${R.indexing.incrementalUpdateMs} ms; no-change re-index ${R.indexing.noChangeReindexMs} ms with ${R.indexing.reparsesOnNoChange} re-parses
- Retrieval latency p50 ${R.indexing.retrievalMs.p50} ms / p95 ${R.indexing.retrievalMs.p95} ms; semantic query top-1: \`${R.indexing.semanticQueryTop1}\`
- Heap after indexing: ${R.indexing.heapMB} MB

## Filesystem
| backend | writes/s | reads/s | patches/s | grep | audit |
|---|---|---|---|---|---|
${Object.entries(R.filesystem).map(([k, v]) => `| ${k} | ${v.writeOpsPerSec} | ${v.readOpsPerSec} | ${v.patchOpsPerSec} | ${v.grepMs} ms | ${v.auditMs} ms (${v.auditOk ? "exact" : "DRIFT"}) |`).join("\n")}

## Tokenization & embeddings
${R.tokenizer ? `- Heuristic estimator error vs real tokenizer: ${R.tokenizer.estimatorErrorPct.join("%, ")}% → after calibration (scale ${R.tokenizer.calibratedScale}): ${R.tokenizer.calibratedErrorPct.join("%, ")}%
- Real tokenizer ${R.tokenizer.realTokenizerCallsPerSec} calls/s vs cached estimator ${R.tokenizer.cachedEstimatorCallsPerSec} calls/s
- Embeddings: neural (${R.embeddings.neuralModel}) ${R.embeddings.neuralChunksPerSec} chunks/s, load ${R.embeddings.neuralLoadMs} ms; hash baseline ${R.embeddings.hashChunksPerSec} chunks/s` : "_skipped_"}
`;
await writeFile(path.join(outDir, "BENCHMARKS.md"), md); console.log(md);
