// WebLLM provider (WebGPU, MLC-compiled weights). The engine is injected so this file has no hard
// dependency on @mlc-ai/web-llm and stays tree-shakeable; the web app passes CreateMLCEngine.
// WebLLM keeps a KV cache between calls, so Barix's stable prompt prefix gets real prefix-cache reuse here.
import { BarixError } from "../util/misc.js";
import { ThinkSplitter, toChatMessages } from "./base.js";

export class WebLLMProvider {
  constructor({ createEngine, model, window = 32768, maxOutput = 4096, quality = 0.6, id, progress, vision = false, family = "qwen", quant }) {
    Object.assign(this, { createEngine, model, progress }); this.id = id ?? `webllm:${model}`; this.kind = "browser-local";
    this.caps = { model, family, quant, window, maxOutput, vision, streaming: true, promptCache: true, quality, hardware: "webgpu" }; this._eng = null;
  }
  async load() { return (this._eng ??= this.createEngine(this.model, { initProgressCallback: this.progress }).catch((e) => { this._eng = null; throw e; })); }
  async health() { try { await this.load(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; } }
  async *generate(req) {
    const eng = await this.load(); const sp = new ThinkSplitter();
    const stream = await eng.chat.completions.create({ messages: toChatMessages(req.messages), stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(req.maxTokens ?? 512, this.caps.maxOutput), temperature: req.temperature ?? 0, ...(req.stop?.length ? { stop: req.stop } : {}) });
    let usage = null, finish = "stop";
    try {
      for await (const c of stream) {
        if (req.signal?.aborted) { await eng.interruptGenerate?.(); finish = "abort"; break; }
        const t = c.choices?.[0]?.delta?.content; if (t) for (const ev of sp.push(t)) yield ev;
        if (c.choices?.[0]?.finish_reason) finish = c.choices[0].finish_reason === "length" ? "length" : "stop";
        if (c.usage) usage = { type: "usage", promptTokens: c.usage.prompt_tokens, completionTokens: c.usage.completion_tokens };
      }
    } catch (e) { throw new BarixError("EPROVIDER", `webllm: ${e.message}`); }
    for (const ev of sp.flush()) yield ev; yield usage ?? { type: "usage", promptTokens: 0, completionTokens: 0 }; yield { type: "done", finishReason: finish };
  }
}
