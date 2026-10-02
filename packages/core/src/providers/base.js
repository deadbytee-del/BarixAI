// Provider interface. A provider is *compute*: it turns a prepared Barix prompt into tokens.
// It never decides context, tools, memory or verification — that is all Barix.
//
// interface Provider {
//   id: string                       unique, e.g. "browser-webgpu", "local-llama", "worker:ab12"
//   kind: "browser-local" | "local-machine" | "public-inference" | "barix-worker" | "mock"
//   caps: { model:string, family:string, quant?:string, window:number, maxOutput:number, vision:boolean,
//           streaming:true, promptCache?:boolean, hardware?:string }
//   health(): Promise<{ok:boolean, latencyMs?:number, load?:number, reason?:string}>
//   generate(req): AsyncIterable<{type:"token"|"thinking"|"usage"|"done", ...}>
//       req = { messages, maxTokens, temperature?, topP?, stop?:string[], signal?, images?, reasoning?:"off"|"on", cacheKey? }
// }
import { BarixError } from "../util/misc.js";

/** Open-weight families Barix is allowed to treat as "foundation" (guards against wrapping proprietary chatbots). */
export const OPEN_WEIGHT_FAMILIES = ["qwen", "gemma", "llama", "mistral", "ministral", "phi", "olmo", "smollm", "granite", "deepseek", "glm", "kimi", "gpt-oss", "nemotron", "yi", "internlm", "falcon", "starcoder"];
export const isOpenWeight = (modelId) => OPEN_WEIGHT_FAMILIES.some((f) => modelId.toLowerCase().includes(f));

/**
 * Normalize Barix messages for any chat template:
 *  - tool results become user turns (Barix's own protocol is template-agnostic),
 *  - consecutive same-role messages are merged (strict-alternation templates),
 *  - system message first.
 */
export function toChatMessages(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === "tool" ? "user" : m.role;
    const content = m.role === "tool" ? `<barix:result${m.tool_call_id ? ` id="${m.tool_call_id}"` : ""} tool="${m.name ?? "tool"}">\n${m.content}\n</barix:result>` : m.content;
    const last = out[out.length - 1];
    if (last && last.role === role && role !== "system" && !m.images?.length && !last.images?.length) last.content += "\n\n" + content; else out.push({ role, content, ...(m.images?.length ? { images: m.images } : {}) });
  }
  return out;
}

/** Streaming splitter that separates <think>…</think> from visible text, even across token boundaries. */
export class ThinkSplitter {
  constructor() { this.buf = ""; this.inThink = false; }
  /** @returns {{type:"token"|"thinking", text:string}[]} */
  push(chunk) {
    this.buf += chunk; const out = [];
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>"; const i = this.buf.indexOf(tag);
      if (i >= 0) { if (i) out.push({ type: this.inThink ? "thinking" : "token", text: this.buf.slice(0, i) }); this.buf = this.buf.slice(i + tag.length); this.inThink = !this.inThink; continue; }
      // hold back a possible partial tag at the end
      let hold = 0; for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) if (tag.startsWith(this.buf.slice(-k))) { hold = k; break; }
      const emit = this.buf.slice(0, this.buf.length - hold); if (emit) out.push({ type: this.inThink ? "thinking" : "token", text: emit });
      this.buf = this.buf.slice(this.buf.length - hold); break;
    }
    return out;
  }
  flush() { const t = this.buf; this.buf = ""; return t ? [{ type: this.inThink ? "thinking" : "token", text: t }] : []; }
}

/** Cut `text` at the first stop sequence; returns {text, stopped}. */
export function applyStop(text, stops) {
  if (!stops?.length) return { text, stopped: false };
  let cut = -1; for (const s of stops) { const i = text.indexOf(s); if (i >= 0 && (cut < 0 || i < cut)) cut = i; }
  return cut >= 0 ? { text: text.slice(0, cut + (stops.find((s) => text.indexOf(s) === cut)?.length ?? 0)), stopped: true } : { text, stopped: false };
}

/** Collect a full generation (convenience for non-streaming callers). */
export async function collect(iter, { onToken, onThinking } = {}) {
  let text = "", thinking = "", usage = null, finish = "stop";
  for await (const e of iter) {
    if (e.type === "token") { text += e.text; onToken?.(e.text); }
    else if (e.type === "thinking") { thinking += e.text; onThinking?.(e.text); }
    else if (e.type === "usage") usage = e;
    else if (e.type === "done") finish = e.finishReason;
  }
  return { text, thinking, usage, finishReason: finish };
}

/**
 * Deterministic scripted provider for TESTS ONLY (never registered by apps). It lets orchestration,
 * routing and failure handling be tested without a model. Real-model tests use the actual providers.
 */
export class ScriptedProvider {
  constructor({ id = "scripted", script = [], window = 8192, maxOutput = 2048, vision = false, delayMs = 0, kind = "mock", failWith = null, unhealthy = null } = {}) {
    this.id = id; this.kind = kind; this.script = [...script]; this.calls = []; this.delayMs = delayMs; this.failWith = failWith; this.unhealthy = unhealthy;
    this.caps = { model: "scripted-test-model", family: "test", window, maxOutput, vision, streaming: true };
  }
  async health() { return this.unhealthy ? { ok: false, reason: String(this.unhealthy) } : { ok: true, latencyMs: this.delayMs }; }
  async *generate(req) {
    this.calls.push(req);
    if (this.failWith) throw this.failWith instanceof Error ? this.failWith : new BarixError("EPROVIDER", String(this.failWith));
    const next = this.script.shift(); const reply = typeof next === "function" ? await next(req) : next ?? "(script exhausted)";
    const text = typeof reply === "string" ? reply : reply.text; const finish = reply.finishReason ?? "stop";
    for (let i = 0; i < text.length; i += 12) { if (req.signal?.aborted) { yield { type: "done", finishReason: "abort" }; return; } if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); yield { type: "token", text: text.slice(i, i + 12) }; }
    yield { type: "usage", promptTokens: req.messages.reduce((a, m) => a + Math.ceil(m.content.length / 4), 0), completionTokens: Math.ceil(text.length / 4) };
    yield { type: "done", finishReason: finish };
  }
}
