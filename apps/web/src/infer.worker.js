// Inference worker: hosts the foundation model (Transformers.js / ONNX Runtime Web: WebGPU or WASM) behind the
// Barix Worker protocol. The brain worker talks to it through a MessagePort exactly like it would to a remote peer.
import { WorkerHost, TransformersProvider, messagePortTransport } from "@barix/core";

let provider = null, host = null, shared = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const { config, base } = m; const tf = await import("@huggingface/transformers");
      tf.env.allowLocalModels = false; tf.env.useBrowserCache = true;
      const ort = tf.env.backends.onnx.wasm; ort.wasmPaths = { mjs: `${base}ort/ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${base}ort/ort-wasm-simd-threaded.asyncify.wasm` };
      ort.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency ?? 2) : 1;
      provider = new TransformersProvider({ loadTransformers: async () => tf, model: config.model, dtype: config.dtype, device: config.device, window: config.window, maxOutput: config.maxOutput ?? 2048, vision: !!config.vision, quality: config.quality, id: "browser-local", kind: "browser-local", hardware: config.device, progress: (p) => self.postMessage({ type: "progress", p }) });
      host = new WorkerHost({ provider, authorize: () => true, hardware: { kind: config.device }, maxConcurrent: 1, maxPromptTokens: config.window, maxOutputTokens: config.maxOutput ?? 2048, requestsPerMinute: 100000, name: "this browser" });
      host.start({ consent: true }); host.accept(messagePortTransport(m.port)); self.postMessage({ type: "ready", caps: provider.caps });
    } else if (m.type === "share-start") {   // owner explicitly started sharing: a SEPARATE host with its own pairing code and limits
      shared?.stop(); shared = new WorkerHost({ provider, authorize: ({ token }) => token === m.code, hardware: { kind: host?.hardware?.kind ?? "wasm" }, maxConcurrent: 1, maxPromptTokens: provider.caps.window, maxOutputTokens: 1024, requestsPerMinute: 20, name: "Shared browser", onActivity: (a) => self.postMessage({ type: "share-activity", a }) }); shared.start({ consent: true });
    } else if (m.type === "share-accept") { shared?.accept(messagePortTransport(m.port, "guest"));
    } else if (m.type === "share-stop") { shared?.stop(); shared = null;
    } else if (m.type === "load") {
      const t0 = performance.now();
      try { await provider.load(); }
      catch (err) { // WebGPU can be advertised yet fail to initialise (driver/flags): fall back to CPU rather than leave the user stuck
        if (provider.device !== "webgpu") throw err;
        console.warn("WebGPU load failed, retrying on CPU/WASM:", err.message); Object.assign(provider, { device: "wasm", dtype: "q4", model: null, _load: null }); provider.caps.window = Math.min(provider.caps.window, 8192); provider.caps.hardware = "wasm"; self.postMessage({ type: "fallback", reason: err.message, device: "wasm" }); await provider.load();
      } self.postMessage({ type: "loaded", ms: Math.round(performance.now() - t0), device: provider.device ?? provider.caps.hardware });
    }
  } catch (err) { self.postMessage({ type: "error", message: err.message, stack: String(err.stack ?? "").slice(0, 500) }); }
};
