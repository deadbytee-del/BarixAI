# Barix benchmarks

Measured 2026-10-02T06:28:34.821Z on **Intel(R) Xeon(R) Processor @ 2.10GHz**, 4 cores, 15.7 GB RAM, linux/x64, Node v22.22.0. CPU only (no GPU). Reproduce: `npm run bench`.

## Foundation model (real inference)
Model: Qwen3.5-0.8B ONNX q4 (CPU, onnxruntime-node). Warm load 28949 ms.

| prompt tokens | first-token latency | decode tok/s | prefill tok/s |
|---|---|---|---|
| 147 | 1323 ms | 9.49 | 111 |
| 947 | 10838 ms | 8.89 | 87 |
| 3459 | 40970 ms | 6.7 | 84 |

## Context engine at the 3.5M-token target (32k window)
- Segments 12699, total 3500914 tokens, ingest+compaction 3.9s (895181 tok/s)
- Planted facts recovered: **24/24**; context build p50 7.2 ms, p95 9.5 ms
- Heap 207.1 MB, RSS 325 MB; raw text resident in RAM: 1648293 chars of 12.5 MB corpus
- Summaries kept: L5:924t L5:942t L4:804t (2670 tokens total)

## Code indexing & retrieval (800 files, 6401 symbols, 1601 chunks)
- Full index 1327 ms (603 files/s); one-file incremental update 4.8 ms; no-change re-index 7.5 ms with 0 re-parses
- Retrieval latency p50 41.35 ms / p95 78.96 ms; semantic query top-1: `src/m3/target.js`
- Heap after indexing: 28.6 MB

## Filesystem
| backend | writes/s | reads/s | patches/s | grep | audit |
|---|---|---|---|---|---|
| memory | 13484 | 224551 | 413 | 1.36 ms | 7.42 ms (exact) |
| node-disk | 1626 | 5785 | 286 | 7.38 ms | 54.8 ms (exact) |

## Tokenization & embeddings
- Heuristic estimator error vs real tokenizer: 10.3%, 10.6%, 0.1% → after calibration (scale 0.919): 1.4%, 1.6%, 8.2%
- Real tokenizer 235 calls/s vs cached estimator 22222 calls/s
- Embeddings: neural (Xenova/all-MiniLM-L6-v2 q8) 353 chunks/s, load 1343 ms; hash baseline 26446 chunks/s
