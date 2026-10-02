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
