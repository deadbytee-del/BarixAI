// createBarix(): assembles one Barix instance from its parts. Browser and BarixTerm call the same factory;
// they differ only in the backend (OPFS vs disk), the registered capability tools, and the providers.
import { BarixFS } from "./fs/barixfs.js";
import { MemoryBackend } from "./fs/backends.js";
import { TokenCounter } from "./tokens/counter.js";
import { ConversationStore, ContextEngine, PagedTextStore, LIMITS } from "./context/index.js";
import { fsPages } from "./context/paged-store.js";
import { Compactor } from "./compaction/compactor.js";
import { MemorySystem, MemoryKV, backendKV } from "./memory/memory.js";
import { HybridIndex } from "./retrieval/hybrid.js";
import { HashEmbedder } from "./retrieval/embeddings.js";
import { ProjectIntelligence } from "./code/intel.js";
import { ToolRegistry, ToolExecutor, builtinTools } from "./tools/index.js";
import { EvidenceLedger } from "./verify/ledger.js";
import { Router } from "./providers/router.js";
import { UsageTracker } from "./providers/usage.js";
import { BarixAgent } from "./agent/loop.js";

/**
 * @param {{backend?:any, runtime?:any, embedder?:any, providers?:object[], tools?:object[], capabilities?:object, env?:"browser"|"term",
 *   kv?:any, projectId?:string, persist?:boolean, extraCtx?:object, strategy?:string, maxTotalTokens?:number, summarizer?:Function, vision?:any, exactTokens?:Function}} o
 */
export async function createBarix({ backend = new MemoryBackend(), runtime = null, embedder = new HashEmbedder(), providers = [], tools = [], capabilities = {}, env = "browser", kv, projectId = "default", persist = true, extraCtx = {}, strategy = "privacy", maxTotalTokens, summarizer, vision, exactTokens } = {}) {
  const counter = new TokenCounter({ exact: exactTokens });
  const fs = await new BarixFS(backend).init();
  const intel = new ProjectIntelligence({ fs, runtime, embedder, counter });
  const store = new ConversationStore({ counter, text: new PagedTextStore({ pages: persist && backend.kind !== "memory" ? fsPages(backend) : undefined }), index: new HybridIndex({ embedder }), maxTotalTokens: maxTotalTokens ?? (env === "term" ? LIMITS.conversationTarget : LIMITS.browserCoding) });
  const usageKV = kv ?? (persist ? backendKV(backend) : new MemoryKV());
  const memory = await new MemorySystem({ kv: usageKV, counter, projectId }).load();
  const usage = await new UsageTracker({ kv: usageKV }).load();
  const compactor = new Compactor({ store, summarizer });
  const engine = new ContextEngine({ store, memory, intel, compactor, counter });
  const ledger = new EvidenceLedger({ fs });
  const registry = new ToolRegistry().registerAll(builtinTools).registerAll(tools);
  const ctx = { fs, intel, ledger, memory, engine, readSet: new Map(), capabilities, redact: true, env, ...extraCtx };
  const executor = new ToolExecutor({ registry, ctx, ledger, counter });
  const router = new Router({ usage, strategy }); for (const p of providers) router.register(p.provider ?? p, p.provider ? p : {});
  const agent = new BarixAgent({ router, store, memory, engine, intel, registry, executor, ledger, counter, fs, capabilities, env, vision });
  await intel.indexAll();
  const profile = await intel.getProfile(); if (fs.files().length) await memory.setProjectProfile(profile, { importantFiles: await intel.importantFiles() });
  return { fs, intel, store, memory, engine, compactor, ledger, registry, executor, router, agent, counter, usage, ctx,
    ask: (text, opts) => agent.run(text, opts) };
}
