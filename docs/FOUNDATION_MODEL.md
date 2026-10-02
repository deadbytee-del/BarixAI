# Foundation model selection

Barix needs a model that is (1) legally usable, (2) strong at coding / instruction following / tool use for its size, (3) multimodal so vision is part of the same pipeline, (4) available in browser/local runtimes with quantization. Candidates were checked against the model hubs on the build date (2026-10-02) — not picked by popularity.

| Candidate | License | Native context | Vision | Browser/local build | Verdict |
|---|---|---|---|---|---|
| **Qwen3.5 0.8B / 2B / 4B / 9B** | Apache-2.0 | 262,144 (YaRN to ~1M per model card) | native (image/video) | `onnx-community/Qwen3.5-*-ONNX` (q4, q4f16, fp16), MLC, GGUF | **Chosen** |
| Gemma 4 E2B / E4B | Apache-2.0 | 131,072 | yes (+audio) | `onnx-community/gemma-4-*-ONNX` | Strong alternative; shorter context, larger embedding tables (E2B q4 files ≈ 1.9 GB + 1.8 GB embeddings) |
| Qwen3 (text) 0.6B–32B | Apache-2.0 | 32k–128k | no | ONNX/MLC | Superseded by Qwen3.5 for this use |
| Others on MLC (Ministral 3, OLMo 2, Gemma 3) | various | smaller | partial | MLC | Not chosen: weaker coding/tool use per size or no native vision |

**Why Qwen3.5.** Published model-card numbers for Qwen3.5-4B: MMLU-Pro 79.1, IFEval 89.8, LiveCodeBench v6 55.8, BFCL-V4 50.3, TAU2-Bench 79.9 (9B: LiveCodeBench v6 65.6). Its hybrid linear-attention design (3 of every 4 layers are linear attention) keeps long-context memory small, which matters for browser/CPU runtimes. It is natively multimodal, so image understanding does not need a second model. Sizes 0.8B / 2B / 4B / 9B give Barix a tier for every device.

**What was and was not benchmarked here.** Real inference was run on Qwen3.5-0.8B (Node CPU, browser WASM, vision). The 2B/4B/9B tiers and Gemma 4 were *not* executed in this build environment (no GPU, limited time); their numbers above are from the model cards. Measured results for the model that was run are in [BENCHMARKS.md](BENCHMARKS.md).

**Honest finding from running it.** The 0.8B tier can read code, make a correct one-line fix, and call tools, but under greedy decoding it repeats tool calls, sometimes uses wrong parameter names, and sometimes fails at arithmetic. Barix's harness (call de-duplication, early stop, argument aliasing, tool withdrawal after repeats, evidence-based fallback answers) makes it terminate and stay honest; it does not make a 0.8B model a strong engineer. Use 4B+ for real work.

## Context windows
The model's real window is a property of the *provider* (`caps.window`), never assumed by Barix. Browser tiers declare 8k–32k practical windows (WASM vs WebGPU memory). Everything beyond that is Barix's context engine (retrieval + summaries), not model capability.
