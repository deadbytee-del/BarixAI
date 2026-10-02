# What is real, what is a target, what is untested

## Targets that are budgets, not model guarantees
- **3,500,000-token conversation context / 1,250,000 browser coding context.** Barix *stores and retrieves* up to this much (paged storage, indexes, hierarchical summaries). The model sees only a window (8k–262k) per call. Beyond the cap, raw text of the least valuable archived items is evicted; summaries stay.
- **1,650,000 (browser) / 2,950,000 (BarixTerm) output tokens per message.** Reached by streaming + automatic continuation with overlap removal; each call is bounded by the model's `maxOutput`. At CPU speeds (~12 tok/s for 0.8B) a million tokens would take about a day; the machinery is tested with a simulated model for correctness, not throughput.
- **500,000,000 tokens/month.** Barix tracks usage per provider, honors rate limits, and fails over. It does not create capacity: free providers do not guarantee this volume, and no provider limit is bypassed.

## Verified in this repository
Real git (local bare remote), real child processes, real headless Chromium (OPFS, subpath serving, cross-origin isolation shim, WebRTC data channels, esbuild-WASM, sandboxed iframe, SVG rasterization), real tree-sitter parsers (13 languages), real Qwen3.5-0.8B inference (Node CPU, browser WASM, vision), real tokenizer calibration.

## Not verified here (be skeptical until you run it)
- **WebGPU inference on a real GPU.** This environment only exposes a SwiftShader software adapter without `shader-f16`; Barix correctly falls back to WASM. The WebGPU path (Transformers.js `device:"webgpu"`, WebLLM adapter) is implemented but untested on hardware.
- **Qwen3.5-2B/4B/9B and Gemma 4** were not run.
- **`BarixTerm.bat` on Windows.** Reviewed for correctness; the equivalent `BarixTerm.sh` and the CLI itself were run. Edge/Chrome discovery paths on Windows/macOS are untested.
- **GitHub APIs live.** The sandbox cannot reach `api.github.com`; the client, importer, tools and Pages verification are tested against a faithful mock and real git. Real Pages deployment depends on the one-time repo setting (Settings → Pages → Source: GitHub Actions).
- **P2P across the internet/NAT.** WebRTC is tested between two peers in one browser (real ICE/DTLS/data channel); STUN/TURN traversal and the `barixterm worker` WebSocket server are not tested end to end.
- **Large neural-embedding corpora in the browser** (the default embedder is a deterministic feature-hashing baseline; a neural embedder is supported and tested in Node).
- **Paraphrase-heavy long-context recall.** The 3.5M-token benchmark uses unique identifiers; semantic recall of paraphrased facts depends on the neural embedder.

## Known behavioural limits
- Small models need the harness; do not expect autonomy from 0.8B.
- Browser builds/tests cover JS/TS via esbuild-WASM and a Node-API-free sandbox; anything needing Node/native tools requires BarixTerm.
- Preview rendering uses SVG foreignObject (static DOM snapshot); fonts are system fonts, and cross-origin resources are not loaded.
