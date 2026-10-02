// Transformers.js provider: runs an ONNX foundation model locally via ONNX Runtime
// (WebGPU/WASM in browsers & workers, CPU in Node). This is *compute*; Barix supplies everything else.
import { ThinkSplitter, toChatMessages, applyStop } from "./base.js";
import { BarixError, now } from "../util/misc.js";

export class TransformersProvider {
  /**
   * @param {{loadTransformers:()=>Promise<any>, model:string, dtype?:string|object, device?:"cpu"|"wasm"|"webgpu", window?:number, maxOutput?:number,
   *   id?:string, kind?:string, quality?:number, family?:string, hardware?:string, progress?:Function, vision?:boolean}} o
   */
  constructor({ loadTransformers, model, dtype = "q4", device, window = 8192, maxOutput = 4096, id, kind, quality = 0.5, family = "qwen", hardware = "unknown", progress, vision = false, quant }) {
    Object.assign(this, { loadTransformers, modelId: model, dtype, device, progress });
    this.id = id ?? `tjs:${model}:${device ?? "auto"}`; this.kind = kind ?? (device === "cpu" ? "local-machine" : "browser-local");
    this.caps = { model, family, quant: quant ?? (typeof dtype === "string" ? dtype : "mixed"), window, maxOutput, vision, streaming: true, promptCache: false, quality, hardware };
    this._load = null; this._lock = Promise.resolve(); this.loadMs = null;
  }
  async load() {
    if (!this._load) this._load = (async () => {
      const t0 = now(); const tf = await this.loadTransformers(); this.tf = tf;
      if (this.caps.vision) {   // one multimodal model object serves both text and image prompts (no duplicate weights)
        this.processor = await tf.AutoProcessor.from_pretrained(this.modelId, { progress_callback: this.progress }); this.tok = this.processor.tokenizer;
        const d = typeof this.dtype === "string" ? { embed_tokens: this.dtype, vision_encoder: this.dtype, decoder_model_merged: this.dtype } : this.dtype;
        this.model = await tf.AutoModelForImageTextToText.from_pretrained(this.modelId, { dtype: d, ...(this.device ? { device: this.device } : {}), progress_callback: this.progress });
      } else {
        this.tok = await tf.AutoTokenizer.from_pretrained(this.modelId, { progress_callback: this.progress });
        this.model = await tf.AutoModelForCausalLM.from_pretrained(this.modelId, { dtype: this.dtype, ...(this.device ? { device: this.device } : {}), progress_callback: this.progress });
      }
      this.loadMs = now() - t0; return this;
    })().catch((e) => { this._load = null; throw e; });
    return this._load;
  }
  /** Exact token counter backed by the model's real tokenizer (for calibration and billing-grade counts). */
  async exactCounter() { await this.load(); return (text) => this.tok(text).input_ids.size; }
  async health() { try { await this.load(); return { ok: true, latencyMs: 0, load: this._busy ? 0.9 : 0 }; } catch (e) { return { ok: false, reason: e.message }; } }

  async *generate(req) {
    await this.load(); const { tf, tok, model } = this;
    const prev = this._lock; let release; this._lock = new Promise((r) => (release = r)); await prev; this._busy = true;
    try {
      const msgs = toChatMessages(req.messages);
      const hasImages = msgs.some((m) => m.images?.length);
      if (hasImages && !this.processor) throw new BarixError("EVISION", "this provider was created without vision support");
      let prompt, inputs;
      if (hasImages) {
        const imgs = []; const parts = msgs.map((m) => (m.images?.length ? { role: m.role, content: [...m.images.map(() => ({ type: "image" })), { type: "text", text: m.content }] } : m));
        for (const m of msgs) for (const url of m.images ?? []) imgs.push(await this.tf.RawImage.fromBlob(dataUrlToBlob(url)));
        prompt = this.processor.apply_chat_template(parts, { add_generation_prompt: true, enable_thinking: req.reasoning === "on" }) + (req.prefill ?? "");
        inputs = await this.processor(prompt, imgs.length === 1 ? imgs[0] : imgs);
      } else {
        prompt = tok.apply_chat_template(msgs, { add_generation_prompt: true, tokenize: false, enable_thinking: req.reasoning === "on" }) + (req.prefill ?? ""); inputs = tok(prompt);
      }
      const promptTokens = inputs.input_ids.dims[1];
      if (promptTokens + 1 > this.caps.window) throw new BarixError("ECONTEXT", `prompt (${promptTokens}) exceeds provider window ${this.caps.window}`);
      const q = []; let wake = null; const push = (e) => { q.push(e); wake?.(); wake = null; };
      const splitter = new ThinkSplitter(); let visible = "", stopped = false;
      const stops = req.stop ?? []; const stopping = new tf.InterruptableStoppingCriteria();
      const streamer = new tf.TextStreamer(tok, {
        skip_prompt: true, skip_special_tokens: true,
        callback_function: (chunk) => {
          if (stopped) return;
          for (const ev of splitter.push(chunk)) {
            if (ev.type === "thinking") { push(ev); continue; }
            const before = visible.length; visible += ev.text; const cut = applyStop(visible, stops);
            if (cut.stopped) { stopped = true; const t = cut.text.slice(before); if (t) push({ type: "token", text: t }); stopping.interrupt(); return; }
            push(ev);
          }
        },
      });
      const onAbort = () => stopping.interrupt(); req.signal?.addEventListener("abort", onAbort, { once: true });
      const temp = req.temperature ?? 0;
      const run = model.generate({ ...inputs, max_new_tokens: Math.min(req.maxTokens ?? 512, this.caps.maxOutput), do_sample: temp > 0, ...(temp > 0 ? { temperature: temp, top_p: req.topP ?? 0.95 } : {}), streamer, stopping_criteria: stopping, repetition_penalty: req.repetitionPenalty ?? 1.0 })
        .then((out) => { for (const ev of splitter.flush()) if (ev.type === "token" && !stopped) { visible += ev.text; push(ev); } const completionTokens = out.dims[1] - promptTokens; push({ type: "usage", promptTokens, completionTokens }); push({ type: "done", finishReason: req.signal?.aborted ? "abort" : stopped ? "stop" : completionTokens >= (req.maxTokens ?? 512) - 1 ? "length" : "stop" }); })
        .catch((e) => push({ type: "error", error: e }));
      for (;;) {
        while (q.length) { const e = q.shift(); if (e.type === "error") throw new BarixError("EPROVIDER", `inference failed: ${e.error?.message ?? e.error}`); yield e; if (e.type === "done") { await run; req.signal?.removeEventListener("abort", onAbort); return; } }
        await new Promise((r) => (wake = r));
      }
    } finally { this._busy = false; release(); }
  }
}

function dataUrlToBlob(url) { const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url); if (!m) throw new BarixError("EIMAGE", "image must be a data: URL"); const bin = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)); return new Blob([bin], { type: m[1] }); }

/** Load Transformers.js in Node with a local cache dir (BarixTerm, tests, benchmarks). */
export async function nodeTransformers({ cacheDir } = {}) {
  const tf = await import("@huggingface/transformers"); if (cacheDir) tf.env.cacheDir = cacheDir; return tf;
}
