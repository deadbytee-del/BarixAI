# Barix architecture

One isomorphic ESM core (`packages/core`) runs unchanged in the browser (Web Worker), in Node (BarixTerm) and inside P2P workers. Apps differ only in backend (OPFS vs disk), registered capability tools, and providers.

## Request pipeline (`agent/loop.js`)
1. **Understand** (`understand.js`, deterministic, no model call): intent, tool groups, whether code/history retrieval, execution and verification are needed, verbosity, expected output size.
2. **Vision pre-pass** if images: classify → perceive (VLM) → *measure* palette/layout from pixels → one report enters the conversation.
3. **Tool selection**: only relevant groups, tiered by model quality (weak models see ~11 tools, not 24).
4. **Context build** (`context/engine.js`) under the provider's real window.
5. **Inference** through the router (stop sequences prevent invented tool results; generation aborts after 3 calls).
6. **Tool execution** (`tools/registry.js`): schema validation with forgiving aliases, guards (read-before-edit, stale-file check), parallel reads / serial writes, timeouts, output caps, secret redaction, **evidence recording**.
7. **Correction**: failures, syntax errors, diagnostics and parse errors are fed back; repeated calls withdraw tools and force an answer.
8. **Verification gate** (below), then the final response with a verification footer.

## Context engine
Stable prefix first (system + tools + project profile), then older turns verbatim, then the volatile packet attached to the *last* message: style, task memory, long-term recall, hierarchical summaries, recalled history, retrieved code. Budget shares depend on mode (coding/chat/research); unused budget flows to recent turns; oversized tool output keeps head+tail with a pointer to recover the rest; code already visible in recent turns is not re-sent. Measured prefix reuse is reported (`report.prefixReuse`). The store (`context/store.js`) keeps only metadata in RAM; text lives in 256 KB pages behind an LRU.

## Compaction
`compaction/` extracts *exact* facts (requirements, decisions, open issues, changes, results) with `[#seq]` back-references, resolves issues fixed later, archives raw segments (still searchable), and merges summaries hierarchically (L1→L2→…). A model may add a gist, but it can never drop the extracted facts. `recall("#42")` expands any reference.

## Retrieval & code intelligence
BM25 (identifier-aware) + quantized vectors (hash or neural embedder) + symbol hits fused by weighted RRF and MMR; import-graph expansion; incremental by content hash. Tree-sitter extracts symbols/imports/syntax errors for 13 languages (regex fallback is flagged). The project tree is authoritative in memory and `fs.audit()` proves it equals storage.

## Verification
Evidence is written **only by the tool executor**. Claims in the model's answer ("created X", "build succeeds", "tests pass", "pushed", "deployed") are extracted and checked against evidence *and live state*: file hashes re-read from storage, runs not stale (no later edits), failures contradict "passes". Unverified claims trigger auto-runs or a correction round; what remains is shown as `? … not verified`.

## Providers & routing
`providers/`: Transformers.js (WebGPU/WASM/CPU), WebLLM, OpenAI-compatible HTTP (local servers, public open-weight hosts; proprietary models are refused), remote workers. The router scores kind/latency/throughput/load/quality, enforces quotas and Retry-After, opens circuit breakers, fails over mid-stream, and supports local-only requests.

## Workers (P2P)
Versioned protocol (`p2p/protocol.js`): consent-gated host, per-peer authorization, size/rate/concurrency limits, cancellation, adverts (model, quantization, hardware, context, vision, load, latency, availability), embeddings, repository-index offload, hash-verified asset cache. Transports: loopback, WebRTC data channel, WebSocket, MessagePort. The browser uses the same protocol to talk to its own inference worker.
