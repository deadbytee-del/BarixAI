// Large-context benchmark: ingest ~N tokens of synthetic conversation, compact under a small model window,
// then verify planted facts are still retrievable with differently-worded queries.
// usage: node scripts/bench-context.mjs [targetTokens=3500000] [window=32768] [--embed]
import { makeBrain, rng } from "../packages/core/test/helpers.js";
import { HashEmbedder } from "../packages/core/src/retrieval/index.js";
import { percentile } from "../packages/core/src/util/misc.js";

const target = +(process.argv[2] ?? 3_500_000), window = +(process.argv[3] ?? 32768), embed = process.argv.includes("--embed");
const R = rng(42);
const pick = (a) => a[Math.floor(R() * a.length)];
const WORDS = Array.from({ length: 3000 }, (_, i) => { const s = ["ka", "to", "mi", "re", "su", "lo", "ve", "an", "ri", "do", "pa", "ne"]; let w = ""; let n = i + 7; do { w += s[n % 12]; n = Math.floor(n / 12); } while (n > 0); return w + (i % 7 === 0 ? "ing" : i % 11 === 0 ? "er" : ""); });
const zipf = () => WORDS[Math.floor(Math.pow(R(), 2.2) * WORDS.length)];
const sent = (n) => Array.from({ length: n }, zipf).join(" ");
const code = () => `function ${zipf()}${zipf()}(${zipf()}, ${zipf()}) {\n  const ${zipf()} = ${zipf()}(${zipf()});\n  if (${zipf()} > ${Math.floor(R() * 100)}) { return ${zipf()}; }\n  return ${zipf()}.${zipf()}(${zipf()});\n}`;
const gen = {
  user: () => `Can you look at ${zipf()} and ${zipf()}? ${sent(30)}. It should handle ${sent(6)}.`,
  assistant: () => `${sent(70)}.\n\n\`\`\`js\n${code()}\n\`\`\`\n${sent(40)}.`,
  tool: () => Array.from({ length: 12 }, code).join("\n"),
};
const NEEDLES = Array.from({ length: 25 }, (_, i) => {
  const id = `${["ZK", "QV", "MX", "RT"][i % 4]}${4000 + i * 37}${["ALPHA", "BRAVO", "SIERRA", "OMEGA"][i % 4]}`;
  const subj = ["nightly invoice export job", "staging database rotation ticket", "customer webhook retry queue", "release signing checklist", "mobile crash triage board"][i % 5];
  return { id, fact: `Heads up: the ${subj} number ${i} is registered as ${id} on the berlin runner.`, query: `Which identifier did we register for the ${subj} number ${i}?` };
});

const { store, engine, compactor, memory } = makeBrain({ embedder: embed ? new HashEmbedder() : null });
const mem0 = process.memoryUsage();
const t0 = performance.now(); let n = 0, compactMs = 0, plantAt = new Map(); const gap = Math.floor((target / 275) / NEEDLES.length / 3) * 3 / 3;
const live = window * 0.55;
while (store.totals.all < target) {
  const k = n % 3; const role = k === 0 ? "user" : k === 1 ? "assistant" : "tool";
  const needle = k === 0 && n > 0 && n / 3 % gap === 0 ? NEEDLES[plantAt.size] : null;
  if (needle) { plantAt.set(needle.id, store.totals.all); await store.append({ role: "user", text: needle.fact }); }
  else await store.append(role === "tool" ? { role: "tool", kind: "tool-result", text: gen.tool(), meta: { tool: "read_file", path: `src/${zipf()}.js`, ok: true } } : { role, text: gen[role]() });
  n++;
  if (n % 40 === 0) { const c0 = performance.now(); await compactor.compactIfNeeded(live); compactMs += performance.now() - c0; }
}
await compactor.compactIfNeeded(live);
const ingestMs = performance.now() - t0;
if (embed) { const e0 = performance.now(); await store.index.flush({ batch: 64 }); console.log("embedding flush ms", (performance.now() - e0) | 0); }
global.gc?.(); const mem1 = process.memoryUsage();
const buildMs = []; let found = 0; const where = { summary: 0, recall: 0 }; const missing = [];
for (const nd of NEEDLES.slice(0, plantAt.size)) {
  await store.append({ role: "user", text: nd.query });
  const t = performance.now(); const { messages, report } = await engine.build({ systemPrompt: "You are Barix.", window, reserveOutput: 2048, mode: "chat" }); buildMs.push(performance.now() - t);
  const all = messages.map((m) => m.content).join("\n");
  if (all.includes(nd.id)) { found++; const inPacket = /Recalled from earlier history[\s\S]*$/.exec(all)?.[0] ?? ""; if (inPacket.includes(nd.id)) where.recall++; else where.summary++; if (report.promptTokens > window) throw new Error("window exceeded"); } else missing.push(nd.id);
}
buildMs.sort((a, b) => a - b); const st = store.stats();
const mb = (x) => +(x / 1048576).toFixed(1);
console.log(JSON.stringify({
  targetTokens: target, window, embed, segments: st.segments, totalTokens: st.all, liveTokens: st.live, archivedTokens: st.archived, evicted: st.evicted,
  summaries: store.activeSummaries().map((s) => `L${s.level}:${s.tokens}t`).join(" "), summaryTokens: store.activeSummaries().reduce((a, s) => a + s.tokens, 0),
  ingestSec: +(ingestMs / 1000).toFixed(1), compactSec: +(compactMs / 1000).toFixed(1), tokensPerSecIngest: Math.round(st.all / (ingestMs / 1000)),
  needlesPlanted: plantAt.size, needlesFound: found, foundVia: where, missing,
  buildMs: { p50: +percentile(buildMs, 0.5).toFixed(1), p95: +percentile(buildMs, 0.95).toFixed(1), max: +buildMs.at(-1).toFixed(1) },
  memoryMB: { heapBefore: mb(mem0.heapUsed), heapAfter: mb(mem1.heapUsed), rss: mb(mem1.rss), pageCacheResidentChars: st.residentChars },
  corpusMB: mb(store.text.totalChars),
}, null, 2));
