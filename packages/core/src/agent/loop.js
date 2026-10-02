// BarixAgent: the request pipeline.
//   user request → task understanding → (vision) → context build → tool selection → model inference
//   → tool execution → result inspection → correction → verification gate → final response
// The foundation model is one step inside this loop; everything around it is Barix.
import { understand } from "./understand.js";
import { buildSystemPrompt, styleDirective } from "./identity.js";
import { parseToolCalls } from "../tools/protocol.js";
import { renderVerification } from "../verify/ledger.js";
import { persistencePolicy } from "../memory/memory.js";
import { LongOutput, OUTPUT_TARGETS } from "./continuation.js";
import { BarixError } from "../util/misc.js";

const STOP = ["<barix:result", "<tool_response"]; // the model may never write tool results itself
const RUN_TOOL = { build: "run_build", test: "run_tests", lint: "run_lint" };

export class BarixAgent {
  /**
   * @param {{router:any, store:any, memory:any, engine:any, intel?:any, registry:any, executor:any, ledger:any, counter:any, fs:any,
   *   capabilities?:object, env?:"browser"|"term", vision?:{analyze:Function}, maxSteps?:number, maxCorrections?:number}} o
   */
  constructor(o) {
    Object.assign(this, { env: "browser", capabilities: {}, maxSteps: 14, maxCorrections: 3, vision: null }, o);
    this.maxCallsPerTurn ??= 3;
    this.outputTarget = this.env === "term" ? OUTPUT_TARGETS.term : OUTPUT_TARGETS.browser;
  }

  async run(userText, { images = [], signal, onEvent = () => {}, sink } = {}) {
    const ev = (e) => onEvent({ ts: Date.now(), ...e });
    this._visualRounds = 0; this.lastVisual = null;
    const t0 = Date.now(); const usage = { promptTokens: 0, completionTokens: 0, calls: 0 }; const routes = []; let steps = 0, corrections = 0;
    const { store, memory, engine, registry, executor, ledger, fs } = this;
    const projectFiles = fs.files().length;

    // 1. understand ----------------------------------------------------------------------------
    const plan = understand(userText, { hasImages: images.length > 0, projectFiles, capabilities: this.capabilities, history: store.live() });
    ev({ type: "plan", plan });

    // 2. persist request, memory side-effects, vision pre-pass ----------------------------------
    await store.append({ role: "user", text: userText, importance: 0.8, meta: { intent: plan.intent } });
    const pol = persistencePolicy(userText);
    if (pol.ok && /\b(remember|from now on|always|never)\b/i.test(userText)) { const r = await memory.remember(userText, { source: "user-statement" }); if (r.stored && !r.duplicate) ev({ type: "memory", stored: userText.slice(0, 120) }); }
    if (plan.needs.verify) { ledger.reset(); memory.startTask(userText.slice(0, 200)); }
    let imageTokens = 0;
    if (images.length) {
      if (!this.vision) await store.append({ role: "user", text: "[system note: images were attached but no vision pipeline is available]", meta: { image: true } });
      else { const v = await this.vision.analyze(images, { userText, plan, signal, onEvent: ev }); await store.append({ role: "user", text: `[Image analysis by Barix vision]\n${v.text}`, importance: 0.8, meta: { image: true } }); imageTokens = v.imageTokens ?? 0; ev({ type: "vision", summary: v.text.slice(0, 200) }); }
    }

    // 3. tool selection --------------------------------------------------------------------------
    const bestQuality = (await this.router.rank({}))[0]?.provider.caps.quality ?? 0.5;
    let tools = plan.needs.tools ? registry.select(this.capabilities, plan.toolGroups, { maxTier: bestQuality < 0.65 && plan.complexity < 0.7 ? 1 : 2 }) : [];
    let system = buildSystemPrompt({ tools }); ev({ type: "tools", tools: tools.map((t) => t.name) });

    const seen = new Map(); let gateNotes = []; let finalText = null, finishReason = "stop", verification = null;
    // 4. the loop ----------------------------------------------------------------------------------
    while (steps < this.maxSteps) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      steps++;
      const top = (await this.router.rank({ vision: false }))[0]; if (!top) throw new BarixError("ECAPACITY", "no provider is available to run Barix right now");
      const caps = top.provider.caps; const reserve = Math.min(caps.maxOutput, Math.max(768, Math.round(plan.expectedOutputTokens * 1.2), tools.length ? 1800 : 0));
      const { messages, report } = await engine.build({ systemPrompt: system, window: caps.window, reserveOutput: reserve, mode: plan.mode, needs: plan.needs, mentionedFiles: plan.mentionedFiles, imageTokens, style: styleDirective(plan) });
      ev({ type: "context", step: steps, report });

      // 4b. inference (streamed; tool-call blocks are hidden from the visible stream)
      const filter = new CallStreamFilter(); let text = "", finish = "stop"; const turnAc = new AbortController(); signal?.addEventListener("abort", () => turnAc.abort(), { once: true }); let closings = 0; const reasoning = tools.length || plan.reasoning === "on" ? (plan.reasoning) : "off";
      for await (const e of this.router.generate({ messages, maxTokens: reserve, temperature: 0, stop: tools.length ? STOP : undefined, reasoning, signal: turnAc.signal }, { promptTokens: report.promptTokens, maxTokens: reserve, vision: images.length > 0 && caps.vision })) {
        if (e.type === "token") { text += e.text; for (const v of filter.push(e.text)) ev({ type: "token", text: v }); if (tools.length && e.text.includes(">")) { closings = (text.match(/<\/barix:call>|<\/tool_call>/g) ?? []).length; if (closings >= this.maxCallsPerTurn) turnAc.abort(); } }
        else if (e.type === "thinking") ev({ type: "thinking", text: e.text });
        else if (e.type === "route") { routes.push(e.provider); ev({ type: "route", provider: e.provider, kind: e.kind, why: e.why }); }
        else if (e.type === "failover") ev({ type: "failover", from: e.from, reason: e.reason });
        else if (e.type === "usage") { usage.promptTokens += e.promptTokens ?? 0; usage.completionTokens += e.completionTokens ?? 0; usage.calls++; }
        else if (e.type === "done") finish = e.finishReason;
      }
      for (const v of filter.flush()) ev({ type: "token", text: v });

      // 4c. parse tool calls
      const parsed = tools.length ? parseToolCalls(text) : { calls: [], errors: [], prose: text, danglingCall: false };
      { const uniq = new Map(); for (const c of parsed.calls) { const k = c.tool + JSON.stringify(c.args); if (!uniq.has(k)) uniq.set(k, c); } parsed.deduped = parsed.calls.length - uniq.size; parsed.calls = [...uniq.values()].slice(0, this.maxCallsPerTurn); }
      if (parsed.calls.length || parsed.errors.length || (parsed.danglingCall && finish !== "length")) {
        const keep = parsed.calls.length ? text.slice(0, endOfLastCall(text)) : text;
        await store.append({ role: "assistant", text: keep.trim() || "(tool call)", meta: { step: steps, calls: parsed.calls.map((c) => c.tool) } });
        for (const er of parsed.errors) await store.append({ role: "tool", kind: "tool-result", text: `Could not run your tool call: ${er.error}\nCall was: ${er.raw}\nFormat: <barix:call tool="NAME">{"param": value}</barix:call>`, meta: { tool: "barix-parser", ok: false, summary: er.error } });
        if (parsed.danglingCall && !parsed.calls.length && !parsed.errors.length) await store.append({ role: "tool", kind: "tool-result", text: "Your tool call was cut off before it was closed. Re-send it completely (shorter content, or split into several patch_file edits).", meta: { tool: "barix-parser", ok: false } });
        // stuck detection: identical call 3x
        for (const c of parsed.calls) { const sig = c.tool + JSON.stringify(c.args); seen.set(sig, (seen.get(sig) ?? 0) + 1); }
        const stuck = [...seen].some(([sig, n]) => n >= (/^run_/.test(sig) ? 2 : 3));
        const results = await executor.runAll(parsed.calls, { signal, onEvent: ev });
        for (const r of results) {
          await store.append({ role: "tool", kind: "tool-result", text: r.output, importance: r.ok ? 0.4 : 0.7, meta: { ...r.meta, callId: r.call.id } });
          ev({ type: "tool", tool: r.call.tool, args: r.call.args, ok: r.ok, summary: r.meta?.summary ?? r.output.slice(0, 120), ms: r.ms });
          if (r.meta?.path && ["write_file", "patch_file", "apply_patch", "delete_file", "move_file"].includes(r.call.tool)) memory.touchFile(r.meta.path);
          if (!r.ok) memory.noteError(`${r.call.tool}: ${(r.meta?.summary ?? r.output).slice(0, 160)}`); else if (r.evidence) memory.noteProgress(`${r.call.tool} ${r.meta?.path ?? ""}`.trim());
        }
        if (parsed.deduped) await store.append({ role: "tool", kind: "tool-result", text: `${parsed.deduped} duplicate call(s) in your reply were ignored. Do not repeat a call; use the result you already have.`, meta: { tool: "barix-guard", ok: false } });
        if (stuck) {
          // Guarantee termination: withdraw tools so the model must answer from the evidence it already has.
          await store.append({ role: "user", text: "Barix: you are repeating a tool call that already returned its result. No more tool calls are available. Write your final answer now, based only on the tool results above; state plainly anything that failed or was not done.", meta: { system: true } });
          tools = []; system = buildSystemPrompt({ tools }); ev({ type: "note", text: "tools withdrawn after repeated calls; asking for a final answer" });
        }
        continue;
      }

      // 5. final candidate ----------------------------------------------------------------------------
      let answer = stripCalls(parsed.prose || text).trim(); finishReason = finish;
      if (answer.replace(/\W/g, "").length < 12) { answer = ledger.records.length ? ledger.summary() : "I could not produce an answer for that. Please rephrase or give more detail."; ev({ type: "note", text: "the model returned no usable final text; Barix reported the verified evidence instead" }); }
      if (finish === "length") { // the answer was cut off: continue it (bounded memory, de-duplicated)
        ev({ type: "continuing", reason: "output reached the per-call limit" });
        const lo = new LongOutput({ router: this.router, counter: this.counter, targetTokens: Math.max(plan.expectedOutputTokens * 3, this.outputTarget), perCallMax: caps.maxOutput, collect: true });
        const r = await lo.run({ messages, needs: { promptTokens: report.promptTokens }, reasoning: "off", sink: (t) => { ev({ type: "token", text: t }); sink?.(t); }, resumeFrom: { tokens: usage.completionTokens, exactTokens: 0, parts: 1, tail: text.slice(-1600), outline: [], finished: false, reason: null, stalls: 0, chars: text.length } });
        answer = text + r.text; finishReason = r.reason === "complete" ? "stop" : "length";
        if (!r.collectedAll) ev({ type: "note", text: "very long output was streamed to the sink and not retained in memory" });
      }

      // 6. verification gate: independent of what the model claims ----------------------------------
      verification = await ledger.verify(answer); ev({ type: "verification", result: summarize(verification) });
      const gate = await this.#gate({ answer, verification, plan, ev, signal, corrections });
      if (gate.continueLoop && corrections < this.maxCorrections && steps < this.maxSteps) { corrections++; await store.append({ role: "assistant", text: answer, meta: { draft: true } }); continue; }
      finalText = answer; gateNotes = gate.notes ?? []; break;
    }
    if (finalText === null) finalText = "I stopped before finishing: I reached the step limit. Here is the current state:\n" + (ledger.changedFiles().length ? `Changed files: ${ledger.changedFiles().join(", ")}.` : "No files were changed.");
    verification = await ledger.verify(finalText);
    const vlines = [renderVerification(verification), ...gateNotes].filter(Boolean).join("\n");
    const footer = vlines ? `\n\n---\n**Verification** (checked by Barix against recorded tool results)\n${vlines}` : "";
    await store.append({ role: "assistant", text: finalText, importance: 0.7, meta: { final: true } });
    if (plan.needs.verify) memory.finishTask(verification.ok ? "done" : "needs-attention");
    const result = { text: finalText + footer, answer: finalText, verification, plan, steps, corrections, usage, routes: [...new Set(routes)], changedFiles: ledger.changedFiles(), finishReason, ms: Date.now() - t0, ok: verification.ok };
    ev({ type: "done", result: { ...result, verification: summarize(verification) } }); return result;
  }

  /** Decide whether claims need more work. May run build/test/lint itself and feed failures back to the model. */
  async #gate({ answer, verification, plan, ev, signal, corrections }) {
    const { registry, executor, store, ledger } = this; let ran = false, failed = false; const notes = [];
    const runTool = async (type) => {
      const name = RUN_TOOL[type]; const t = registry.get(name); if (!t || !this.capabilities.exec) return false;
      ev({ type: "gate", action: `auto-running ${name} to verify the claim` });
      const [r] = await executor.runAll([{ id: `gate-${name}`, tool: name, args: {} }], { signal, onEvent: ev });
      await store.append({ role: "tool", kind: "tool-result", text: r.output, meta: { ...r.meta, callId: r.call.id, auto: true } }); ran = true; if (!r.ok) failed = true; else notes.push(`✓ Barix ran ${name} after the changes — passed`); return true;
    };
    // (a) claims about runs that did not happen / are stale → run them now
    for (const c of verification.unverified.filter((u) => RUN_TOOL[u.type])) await runTool(c.type);
    // (b) coding task that changed files but never ran anything after the last change → run tests (else build)
    if (!ran && plan.needs.verify && ledger.changedFiles().length && this.capabilities.exec) {
      const lastMut = [...ledger.records].reverse().find((r) => r.ok && ["fs-write", "fs-delete", "fs-move"].includes(r.kind))?.seq ?? 0;
      const ranAfter = ["test", "build"].some((k) => (ledger.last(k)?.seq ?? 0) > lastMut);
      if (!ranAfter) { const prof = await this.intel?.getProfile(); if (prof?.commands.test && (await runTool("test"))) {} else if (prof?.commands.build) await runTool("build"); }
    }
    if (failed) { await store.append({ role: "user", text: "Barix verification: the run above FAILED. Read the output, fix the cause, and re-run before answering.", meta: { system: true } }); return { continueLoop: true, notes: [] }; }
    if (ran) { const again = await ledger.verify(answer); verification.unverified = again.unverified; verification.contradicted = again.contradicted; verification.verified = again.verified; verification.claims = again.claims; verification.ok = again.ok; }
    // (d) vision+coding: render the result and compare it with the user's reference image
    if (plan.intent === "vision-coding" && this.vision?.referenceId && this.capabilities.browser && ledger.changedFiles().length && (this._visualRounds ?? 0) < 2) {
      const page = ledger.changedFiles().find((p) => /\.html?$/i.test(p)) ?? (this.fs.exists("index.html") ? "index.html" : null);
      if (page) {
        this._visualRounds = (this._visualRounds ?? 0) + 1; ev({ type: "gate", action: `rendering ${page} and comparing it with the reference image` });
        const [pv] = await executor.runAll([{ id: "gate-preview", tool: "preview_page", args: { path: page } }], { signal, onEvent: ev });
        await store.append({ role: "tool", kind: "tool-result", text: pv.output, meta: { ...pv.meta, callId: pv.call.id, auto: true } });
        if (pv.ok) {
          const [cmp] = await executor.runAll([{ id: "gate-compare", tool: "compare_images", args: { reference: this.vision.referenceId, current: pv.meta.summary } }], { signal, onEvent: ev });
          await store.append({ role: "tool", kind: "tool-result", text: cmp.output, meta: { ...cmp.meta, callId: cmp.call.id, auto: true } });
          const sim = cmp.data?.similarity ?? 0; this.lastVisual = { similarity: sim, page };
          if (sim >= 0.93) notes.push(`✓ Barix rendered ${page} and compared it with your image: ${(sim * 100).toFixed(1)}% visually similar`);
          else if (this._visualRounds < 2) { await store.append({ role: "user", text: `Barix visual verification: the rendered page is only ${(sim * 100).toFixed(1)}% similar to the reference. Fix the largest differences listed above (colors/positions), then answer.`, meta: { system: true } }); return { continueLoop: true, notes: [] }; }
          else notes.push(`! After ${this._visualRounds} attempts the render is ${(sim * 100).toFixed(1)}% similar to your image (not a close match); see the differences reported above`);
        }
      }
    }
    // (c) file/remote claims without evidence → ask the model to do it or retract (once per correction round)
    const fileClaims = verification.unverified.filter((u) => u.type === "file" || u.type === "remote").concat(verification.contradicted.filter((u) => u.type === "file"));
    if (fileClaims.length && corrections < this.maxCorrections) {
      await store.append({ role: "user", text: `Barix verification: your draft claims actions that tool evidence does not support:\n${fileClaims.map((c) => `- "${c.sentence.slice(0, 120)}" — ${c.reason}`).join("\n")}\nEither perform them now with tools, or rewrite your answer so it states only what actually happened.`, meta: { system: true } });
      return { continueLoop: true, notes };
    }
    return { continueLoop: false, notes };
  }
}

const stripCalls = (t) => t.replace(/<barix:call[\s\S]*?(?:<\/barix:call>|$)|<tool_call>[\s\S]*?(?:<\/tool_call>|$)|<function=[\s\S]*?(?:<\/function>|$)/g, "");
function endOfLastCall(text) { let end = 0; for (const m of text.matchAll(/<\/barix:call>|<\/tool_call>|<\/function>/g)) end = m.index + m[0].length; return end || text.length; }
function summarize(v) { return { ok: v.ok, verified: v.verified.length, unverified: v.unverified.map((c) => ({ type: c.type, path: c.path, reason: c.reason })), contradicted: v.contradicted.map((c) => ({ type: c.type, path: c.path, reason: c.reason })) }; }

/** Streams prose live but hides <barix:call>/<tool_call> blocks (their text goes to the tool pipeline, not the user). */
export class CallStreamFilter {
  constructor() { this.buf = ""; this.hidden = false; }
  push(chunk) {
    this.buf += chunk; const out = [];
    for (;;) {
      if (this.hidden) { const m = /<\/(barix:call|tool_call|function)>/.exec(this.buf); if (!m) { this.buf = this.buf.slice(-24); return out; } this.buf = this.buf.slice(m.index + m[0].length); this.hidden = false; continue; }
      const m = /<(barix:call|tool_call|function=)/.exec(this.buf);
      if (m) { if (m.index) out.push(this.buf.slice(0, m.index)); this.buf = this.buf.slice(m.index); this.hidden = true; continue; }
      const lt = this.buf.lastIndexOf("<"); const safe = lt >= 0 && this.buf.length - lt < 14 ? lt : this.buf.length;
      if (safe) out.push(this.buf.slice(0, safe)); this.buf = this.buf.slice(safe); return out;
    }
  }
  flush() { const r = this.hidden ? "" : this.buf; this.buf = ""; return r ? [r] : []; }
}
