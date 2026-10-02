// Provider discovery for BarixTerm. Priority: explicit flags/config → local inference servers
// (llama.cpp, Ollama, LM Studio) → built-in ONNX model (Transformers.js on CPU) sized to your RAM.
// All of these are COMPUTE for Barix; none is presented to the user as "the AI".
import os from "node:os";
import { execFile } from "node:child_process";
import { OpenAICompatProvider, TransformersProvider, nodeTransformers, isOpenWeight } from "@barix/core";

const getJson = async (url, ms = 1200) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const PREFER = [/qwen3\.5/i, /qwen3-coder/i, /qwen3/i, /qwen2\.5-coder/i, /gemma-?4/i, /gemma-?3/i, /llama-?3/i, /mistral|ministral/i, /phi/i];
const rank = (id) => { const i = PREFER.findIndex((r) => r.test(id)); return i < 0 ? 99 : i; };

export async function detectLocalServers() {
  const found = [];
  // llama.cpp server / LM Studio / vLLM: OpenAI-compatible /v1/models
  for (const [name, base] of [["llama.cpp", "http://127.0.0.1:8080/v1"], ["LM Studio", "http://127.0.0.1:1234/v1"], ["vLLM", "http://127.0.0.1:8000/v1"]]) {
    const m = await getJson(`${base}/models`); const id = m?.data?.map((x) => x.id).filter(isOpenWeight).sort((a, b) => rank(a) - rank(b))[0] ?? m?.data?.[0]?.id; if (!id) continue;
    const props = name === "llama.cpp" ? await getJson("http://127.0.0.1:8080/props") : null;
    const window = props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? m.data[0]?.meta?.n_ctx_train ?? null;
    found.push({ name, baseUrl: base, model: id, window, promptCache: name === "llama.cpp" });
  }
  // Ollama: native API reports context length
  const tags = await getJson("http://127.0.0.1:11434/api/tags");
  if (tags?.models?.length) {
    const ids = tags.models.map((x) => x.name).filter(isOpenWeight).sort((a, b) => rank(a) - rank(b)); const id = ids[0];
    if (id) { const show = await fetch("http://127.0.0.1:11434/api/show", { method: "POST", body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null); const ctxKey = show && Object.keys(show.model_info ?? {}).find((k) => k.endsWith(".context_length")); found.push({ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: id, window: ctxKey ? Math.min(show.model_info[ctxKey], 32768) : 8192 }); }
  }
  return found;
}

export function ramTier() {
  const gb = os.totalmem() / 2 ** 30;
  if (gb >= 24) return { model: "onnx-community/Qwen3.5-4B-ONNX", dtype: "q4", window: 16384, label: "Qwen3.5-4B q4 (CPU)" };
  if (gb >= 10) return { model: "onnx-community/Qwen3.5-2B-ONNX", dtype: "q4", window: 12288, label: "Qwen3.5-2B q4 (CPU)" };
  return { model: "onnx-community/Qwen3.5-0.8B-ONNX", dtype: "q4", window: 8192, label: "Qwen3.5-0.8B q4 (CPU)" };
}

/** Build the provider list for this run. `opts`: {endpoint, endpointModel, window, model, builtin:boolean, cacheDir, onProgress} */
export async function setupProviders(opts = {}, log = () => {}) {
  const providers = [];
  if (opts.endpoint) {
    providers.push(new OpenAICompatProvider({ baseUrl: opts.endpoint, model: opts.endpointModel, apiKey: opts.apiKey ?? process.env.BARIX_ENDPOINT_KEY, window: opts.window ?? 8192, kind: /127\.0\.0\.1|localhost|192\.168\.|10\./.test(opts.endpoint) ? "local-machine" : "public-inference", quality: opts.quality ?? 0.6 }));
    log(`provider: endpoint ${opts.endpoint} (${opts.endpointModel})`);
  } else {
    for (const s of await detectLocalServers()) {
      if (!s.window) { log(`found ${s.name} at ${s.baseUrl} (${s.model}) but cannot read its context window; pass --window N to use it`); continue; }
      providers.push(new OpenAICompatProvider({ baseUrl: s.baseUrl, model: s.model, window: s.window, kind: "local-machine", promptCache: s.promptCache, quality: 0.7, id: `local:${s.name}`, hardware: "local" })); log(`provider: ${s.name} ${s.model} (window ${s.window})`);
    }
  }
  if (opts.builtin !== false && (!providers.length || opts.alsoBuiltin)) {
    const t = opts.model ? { model: opts.model, dtype: opts.dtype ?? "q4", window: opts.window ?? 8192, label: opts.model } : ramTier();
    const tf = await nodeTransformers({ cacheDir: opts.cacheDir });
    providers.push(new TransformersProvider({ loadTransformers: async () => tf, model: t.model, dtype: t.dtype, device: "cpu", window: t.window, maxOutput: 1024, quality: /4B|9B/.test(t.model) ? 0.7 : /2B/.test(t.model) ? 0.55 : 0.4, progress: opts.onProgress, id: "builtin-onnx" }));
    log(`provider: built-in ${t.label} — first use downloads the model; CPU inference is slow (a local llama.cpp/Ollama server or GPU is much faster)`);
  }
  return providers;
}

export async function githubToken() {
  const env = process.env.BARIX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN; if (env) return env;
  return new Promise((res) => execFile("gh", ["auth", "token"], { timeout: 4000, windowsHide: true }, (e, out) => res(e ? undefined : String(out).trim() || undefined)));
}
export function systemInfo() { return { node: process.version, platform: `${process.platform}/${process.arch}`, cores: os.cpus().length, ramGB: +(os.totalmem() / 2 ** 30).toFixed(1), freeGB: +(os.freemem() / 2 ** 30).toFixed(1) }; }
