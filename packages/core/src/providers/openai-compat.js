// OpenAI-compatible HTTP adapter: llama.cpp `llama-server`, Ollama, vLLM, LM Studio (your machine / LAN),
// or a public inference host serving OPEN-WEIGHT models. Used only as a transport for tokens.
// Rules: credentials come from runtime config (never hardcoded); public endpoints must serve an
// open-weight model family (Barix is not a skin over proprietary chatbots); 429/503 are surfaced to the
// router so Retry-After is honored.
import { BarixError } from "../util/misc.js";
import { ThinkSplitter, toChatMessages, isOpenWeight } from "./base.js";

export class OpenAICompatProvider {
  /**
   * @param {{baseUrl:string, model:string, apiKey?:string, id?:string, kind?:"local-machine"|"public-inference"|"barix-worker", window:number, maxOutput?:number,
   *   vision?:boolean, quality?:number, headers?:object, fetch?:typeof fetch, extraBody?:object, family?:string, promptCache?:boolean, hardware?:string, quant?:string}} o
   */
  constructor({ baseUrl, model, apiKey, id, kind = "local-machine", window, maxOutput = 4096, vision = false, quality = 0.5, headers = {}, fetch: f, extraBody = {}, family, promptCache = false, hardware, quant }) {
    if (!isOpenWeight(model) && !isOpenWeight(family ?? "")) throw new BarixError("EFOUNDATION", `"${model}" is not a recognised open-weight model. Barix runs its own intelligence layer around open-weight foundations; it will not proxy proprietary chatbots.`);
    if (!window) throw new BarixError("ECONFIG", "OpenAICompatProvider requires the real context window of the served model");
    Object.assign(this, { baseUrl: baseUrl.replace(/\/+$/, ""), model, apiKey, headers, extraBody });
    this._fetch = f ?? ((...a) => globalThis.fetch(...a));
    this.id = id ?? `${kind}:${new URL(baseUrl).host}:${model}`; this.kind = kind;
    this.caps = { model, family: family ?? model.split(/[/:-]/)[0].toLowerCase(), quant, window, maxOutput, vision, streaming: true, promptCache, quality, hardware };
  }
  #headers() { return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.headers }; }
  async health() {
    try { const t0 = Date.now(); const r = await this._fetch(`${this.baseUrl}/models`, { headers: this.#headers(), signal: AbortSignal.timeout(1200) }); return r.status < 500 && r.status !== 429 ? { ok: true, latencyMs: Date.now() - t0 } : { ok: false, reason: `HTTP ${r.status}` }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }
  async *generate(req) {
    const body = { model: this.model, messages: toChatMessages(req.messages).map((m) => (m.images?.length ? { role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] } : m)), stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(req.maxTokens ?? 512, this.caps.maxOutput), temperature: req.temperature ?? 0, ...(req.topP ? { top_p: req.topP } : {}), ...(req.stop?.length ? { stop: req.stop } : {}), ...(this.caps.promptCache ? { cache_prompt: true } : {}), ...this.extraBody };
    if (req.reasoning === "off") body.chat_template_kwargs = { enable_thinking: false };
    let res; try { res = await this._fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: this.#headers(), body: JSON.stringify(body), signal: req.signal }); }
    catch (e) { if (e.name === "AbortError") throw e; throw new BarixError("EPROVIDER", `cannot reach ${this.baseUrl}: ${e.message}`); }
    if (res.status === 429 || res.status === 503) throw new BarixError("ERATELIMIT", `HTTP ${res.status} from ${this.baseUrl}`, { status: res.status, retryAfter: res.headers.get("retry-after") });
    if (!res.ok) throw new BarixError("EPROVIDER", `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, { status: res.status });
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", finish = "stop", usage = null, n = 0; const sp = new ThinkSplitter();
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim(); if (data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const ch = j.choices?.[0]; const d = ch?.delta;
        if (d?.reasoning_content) yield { type: "thinking", text: d.reasoning_content };
        if (d?.content) { n++; for (const ev of sp.push(d.content)) yield ev; }
        if (ch?.finish_reason) finish = ch.finish_reason === "length" ? "length" : "stop";
        if (j.usage) usage = { type: "usage", promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens };
      }
    }
    for (const ev of sp.flush()) yield ev; yield usage ?? { type: "usage", promptTokens: 0, completionTokens: n }; yield { type: "done", finishReason: finish };
  }
}
