// LongOutput: produces outputs far larger than one model call can emit.
// Targets (budgets, not model guarantees): 1.65M tokens/message in the browser, 2.95M in BarixTerm.
// How it stays honest and cheap:
//   - Output is streamed to a sink (UI / file / paged store) chunk by chunk; only a small TAIL and a
//     running OUTLINE are kept in memory, so a million-token answer never exists as one string.
//   - Each continuation call receives the original request + the tail + a compact reference to what was
//     already produced ("part 41, 168,000 tokens so far, outline …") — never the whole output again.
//   - Overlap between the end of the previous part and the start of the next is detected and removed.
//   - Token counts come from provider usage when available (exact) and the counter otherwise (flagged).
//   - Generation state is serializable (`state`) so an interrupted job resumes without re-sending output.
import { BarixError } from "../util/misc.js";

export const OUTPUT_TARGETS = Object.freeze({ browser: 1_650_000, term: 2_950_000 });

export class LongOutput {
  /**
   * @param {{router:any, counter:any, targetTokens?:number, perCallMax?:number, tailChars?:number, maxCalls?:number, collect?:boolean|number}} o
   */
  constructor({ router, counter, targetTokens = OUTPUT_TARGETS.browser, perCallMax = 2048, tailChars = 1600, maxCalls = 5000, collect = 200_000 }) {
    Object.assign(this, { router, counter, targetTokens, perCallMax, tailChars, maxCalls }); this.collectLimit = collect === true ? Infinity : collect || 0;
  }
  /**
   * @param {{messages:object[], needs?:object, stop?:string[], temperature?:number, reasoning?:string, signal?:AbortSignal,
   *   sink?:(text:string, info:{part:number, tokens:number})=>void|Promise<void>, onState?:(s:object)=>void, resumeFrom?:object, maxTokens?:number}} r
   */
  async run({ messages, needs = {}, stop, temperature = 0, reasoning = "off", signal, sink, onState, resumeFrom, maxTokens }) {
    const budget = Math.min(maxTokens ?? this.targetTokens, this.targetTokens);
    const st = resumeFrom ? structuredClone(resumeFrom) : { tokens: 0, exactTokens: 0, parts: 0, tail: "", outline: [], finished: false, reason: null, stalls: 0, chars: 0 };
    let collected = ""; let route = null;
    while (!st.finished) {
      if (signal?.aborted) { st.reason = "aborted"; break; }
      if (budget - st.tokens < 32) { st.reason = "token-budget"; st.finished = true; break; } // too little left for a useful call
      if (st.parts >= this.maxCalls) { st.reason = "max-calls"; st.finished = true; break; }
      const remaining = budget - st.tokens, per = Math.min(this.perCallMax, remaining);
      const req = { messages: st.parts === 0 ? messages : [...messages, { role: "assistant", content: st.tail }, { role: "user", content: continuationPrompt(st) }], maxTokens: per, temperature, reasoning, stop, signal };
      let chunk = "", finish = "stop", usage = null, emittedFromChunk = 0; const hold = st.parts > 0 ? 240 : 0; // buffer the head of continuation parts so overlap can be cut
      const flushChunk = async (final) => {
        if (st.parts > 0 && emittedFromChunk === 0 && !final && chunk.length < hold) return;
        let text = chunk.slice(emittedFromChunk);
        if (st.parts > 0 && emittedFromChunk === 0) { const cut = overlapLength(st.tail, chunk); chunk = chunk.slice(cut); text = chunk; st.overlapDropped = (st.overlapDropped ?? 0) + cut; }
        if (!text) return; emittedFromChunk = chunk.length; // chunk is now overlap-free
        st.chars += text.length; st.tail = (st.tail + text).slice(-this.tailChars); updateOutline(st, text);
        if (collected.length < this.collectLimit) collected += text;
        await sink?.(text, { part: st.parts + 1, tokens: st.tokens });
      };
      for await (const e of this.router.generate(req, { ...needs, maxTokens: per })) {
        if (e.type === "route") route = e; else if (e.type === "failover" && e.reset) { chunk = ""; emittedFromChunk = 0; }
        else if (e.type === "token") { chunk += e.text; await flushChunk(false); }
        else if (e.type === "usage") usage = e; else if (e.type === "done") finish = e.finishReason;
      }
      const before = chunk.length; await flushChunk(true);
      const newChars = chunk.length; if (newChars < 20 && st.parts > 0) st.stalls++; else st.stalls = 0;
      const dTok = usage?.completionTokens ?? this.counter.count(chunk); st.tokens += dTok; if (usage?.completionTokens) st.exactTokens += dTok; st.parts++;
      onState?.(structuredClone(st));
      if (finish === "abort") { st.reason = "aborted"; break; }
      if (finish !== "length") { st.finished = true; st.reason = "complete"; }
      else if (st.stalls >= 2) { st.finished = true; st.reason = "stalled (model produced no new text)"; }
      void before;
    }
    return { text: collected, collectedAll: collected.length === st.chars, tokens: st.tokens, exactTokens: st.exactTokens, parts: st.parts, finished: st.finished, reason: st.reason, state: st, route, overlapDropped: st.overlapDropped ?? 0 };
  }
}

function continuationPrompt(st) {
  const outline = st.outline.length ? ` Sections so far: ${st.outline.slice(-12).join(" | ")}.` : "";
  return `Continue exactly from where your previous message stopped (it ended mid-output at the text shown above). Do not repeat anything already written, do not restart, do not add preamble. [Output so far: part ${st.parts}, ~${st.tokens} tokens.${outline}]`;
}
function updateOutline(st, text) {
  for (const m of text.matchAll(/^(#{1,4}\s+.{3,80}|(?:chapter|section|part)\s+[\w.]+.{0,60})$/gim)) { const h = m[1].trim(); if (st.outline[st.outline.length - 1] !== h) st.outline.push(h); }
  if (st.outline.length > 60) st.outline.splice(0, st.outline.length - 60);
}
/** Longest k such that the last k chars of `tail` equal the first k chars of `next` (k >= 12), allowing whitespace drift. */
export function overlapLength(tail, next) {
  const max = Math.min(tail.length, next.length, 800);
  for (let k = max; k >= 12; k--) if (tail.endsWith(next.slice(0, k))) return k;
  // models often restart a few words earlier: look for the tail's last line inside the head of `next`
  const last = tail.trimEnd().split("\n").pop()?.trim() ?? ""; if (last.length >= 16) { const i = next.indexOf(last); if (i >= 0 && i < 400) return i + last.length + (next[i + last.length] === "\n" ? 1 : 0); }
  return 0;
}
export { BarixError };
