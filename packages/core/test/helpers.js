import { TokenCounter } from "../src/tokens/counter.js";
import { ConversationStore, ContextEngine, PagedTextStore } from "../src/context/index.js";
import { Compactor } from "../src/compaction/index.js";
import { MemorySystem } from "../src/memory/index.js";
import { HybridIndex, HashEmbedder } from "../src/retrieval/index.js";

export function makeBrain({ embedder = null, maxTotalTokens, pageChars } = {}) {
  const counter = new TokenCounter();
  const store = new ConversationStore({ counter, text: new PagedTextStore({ pageChars }), index: new HybridIndex({ embedder }), maxTotalTokens });
  const memory = new MemorySystem({ counter }); const compactor = new Compactor({ store });
  const engine = new ContextEngine({ store, memory, compactor, counter });
  return { counter, store, memory, compactor, engine };
}
// deterministic PRNG so the synthetic corpus is reproducible
export function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

// ---- a REAL test-runner tool (materializes the BarixFS project to disk and runs `node test.js`) ----
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
export const runTestsTool = () => ({
  name: "run_tests", group: "exec", requires: ["exec"], description: "Run the project's tests (node test.js).", parameters: { type: "object", properties: {}, additionalProperties: false },
  async run(_, ctx) {
    const dir = await mkdtemp(join(tmpdir(), "barix-run-"));
    try {
      for (const p of ctx.fs.files()) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), await ctx.fs.readFile(p)); }
      const r = await new Promise((res) => execFile("node", ["test.js"], { cwd: dir, timeout: 20000 }, (err, stdout, stderr) => res({ code: err ? err.code ?? 1 : 0, out: (stdout + stderr).trim() })));
      return { ok: r.code === 0, output: `exit ${r.code}\n${r.out}`, evidence: { kind: "test", data: { exitCode: r.code, summary: r.out.split("\n").slice(-2).join(" ").slice(0, 120) } }, meta: { summary: r.out.split("\n").pop() } };
    } finally { await rm(dir, { recursive: true, force: true }); }
  },
});
