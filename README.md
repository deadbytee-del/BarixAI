# Barix

**Barix is a custom AI runtime, not a chat skin.** It wraps an open-weight foundation model (Qwen3.5, Apache-2.0) in its own intelligence layer: task understanding, a context engine, hierarchical compaction, layered memory, code intelligence (tree-sitter), a versioned filesystem, a structured tool protocol, a vision pipeline, an independent verification layer, provider routing with failover, and an optional P2P worker network. The user talks to one system: Barix.

```
user request → task understanding → context retrieval → tool selection → model inference
            → tool execution → result inspection → correction → verification gate → final response
```

| Surface | What it is | Run it |
|---|---|---|
| **Browser app** | Static site (GitHub Pages compatible, works under any repo subpath). Model runs in your browser (WebGPU/WASM); files live in OPFS or a local folder you open. | `npm run build:web && npm run serve` → http://127.0.0.1:8080/BarixAI/ |
| **BarixTerm** | Local agent with real filesystem, git, GitHub, commands, builds, tests, local models. Same core as the browser. | `BarixTerm.bat` (Windows) · `./BarixTerm.sh` (macOS/Linux) · `npm run barixterm` |

## Quick start
```bash
git clone https://github.com/deadbytee-del/BarixAI && cd BarixAI
npm install            # Node 20+
npm test               # 100+ tests: real git, real processes, real model (opt-in), real browser
./BarixTerm.sh doctor  # or BarixTerm.bat doctor
./BarixTerm.sh -p "Create hello.js that prints a greeting, then run it" ./my-project
```
BarixTerm auto-detects a local llama.cpp / Ollama / LM Studio server; otherwise it uses a built-in ONNX model sized to your RAM (CPU is slow — a local GPU server is much faster). Browser: open the site, pick the recommended model, send a message.

## What makes it Barix (and where to read the code)
| Capability | Implementation | Doc |
|---|---|---|
| Context engine (3.5M-token managed context; 1.25M browser coding) | `packages/core/src/context` | [ARCHITECTURE](docs/ARCHITECTURE.md#context-engine) |
| Hierarchical compaction (never truncates) | `packages/core/src/compaction` | [ARCHITECTURE](docs/ARCHITECTURE.md#compaction) |
| Layered memory (task / project / long-term, consent-gated) | `packages/core/src/memory` | |
| Code intelligence: tree-sitter symbols, import graph, hybrid retrieval | `packages/core/src/code`, `retrieval` | |
| Filesystem: OPFS/disk/IDB, versions, audit | `packages/core/src/fs` | |
| Tools + verification ledger (anti-hallucination) | `packages/core/src/tools`, `verify` | [ARCHITECTURE](docs/ARCHITECTURE.md#verification) |
| Vision: classify → perceive → *measure pixels* → compare renders | `packages/core/src/vision` | |
| Provider router, usage/quotas, failover | `packages/core/src/providers` | |
| Worker protocol (WebRTC / WebSocket / MessagePort) | `packages/core/src/p2p` | |
| GitHub reading + verified publishing | `packages/core/src/github`, `apps/term/src/publish.js` | |
| Long outputs (1.65M browser / 2.95M BarixTerm token budgets) | `packages/core/src/agent/continuation.js` | |

## Read this before trusting any number
Barix is explicit about what is real and what is a target — see **[docs/LIMITS.md](docs/LIMITS.md)** and the measured **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**. In short: the 3.5M / 1.25M / 1.65M / 2.95M / 500M figures are engineering budgets that Barix reaches through retrieval, compaction, continuation and routing — they are *not* claims about the model's window or any provider's free quota.

Foundation-model choice and evidence: [docs/FOUNDATION_MODEL.md](docs/FOUNDATION_MODEL.md). Deployment: [docs/DEPLOY.md](docs/DEPLOY.md).

MIT licensed. Models are downloaded from their own hosts under their own licenses (Qwen3.5: Apache-2.0).
