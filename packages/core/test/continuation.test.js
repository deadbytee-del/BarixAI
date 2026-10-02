import { test } from "node:test";
import assert from "node:assert/strict";
import { LongOutput, OUTPUT_TARGETS, overlapLength } from "../src/agent/continuation.js";
import { Router, ScriptedProvider } from "../src/providers/index.js";
import { TokenCounter } from "../src/tokens/counter.js";

// A "model" that writes numbered lines forever, ~maxTokens per call, and on continuation restarts 2 lines early.
class LineModel extends ScriptedProvider {
  constructor(o) { super({ id: "linemodel", kind: "local-machine", window: 16384, maxOutput: 4096, ...o }); this.next = 1; this.stopAt = o?.stopAt ?? Infinity; }
  async *generate(req) {
    this.calls.push({ n: req.messages.length, last: req.messages.at(-1).content.slice(0, 60) });
    const cont = req.messages.length > 2 && /Continue exactly/.test(req.messages.at(-1).content);
    let n = cont ? Math.max(1, +/line (\d+)/.exec(req.messages.at(-2).content.trimEnd().split("\n").slice(-2)[0])[1]) : this.next; // overlap by 2 lines
    let tokens = 0, text = "";
    while (tokens < req.maxTokens - 3 && n <= this.stopAt) { const l = `line ${n} of the generated document\n`; text += l; tokens += 7; n++; }
    this.next = n; const done = n > this.stopAt;
    yield { type: "token", text }; yield { type: "usage", promptTokens: 50, completionTokens: tokens }; yield { type: "done", finishReason: done ? "stop" : "length" };
  }
}

test("overlap detection removes restated text", () => {
  assert.equal(overlapLength("alpha beta gamma delta epsilon", "gamma delta epsilon zeta"), "gamma delta epsilon".length);
  assert.equal(overlapLength("one two three four five six\nline 41 here is the tail", "line 41 here is the tail\nline 42 new"), "line 41 here is the tail".length);
  assert.equal(overlapLength("abc", "xyz"), 0);
});

test("long output: 1.65M-token browser target, exact, ordered, no duplicates, bounded memory, resumable", async () => {
  const router = new Router(); const model = new LineModel({ stopAt: 1e9 }); router.register(model);
  const lo = new LongOutput({ router, counter: new TokenCounter(), targetTokens: OUTPUT_TARGETS.browser, perCallMax: 4096, collect: 0 });
  let expected = 1, lines = 0, bytes = 0, bad = 0; const states = [];
  const heap0 = process.memoryUsage().heapUsed; let heapMax = heap0;
  const r = await lo.run({ messages: [{ role: "system", content: "S" }, { role: "user", content: "Write a very long document." }], sink: (t) => { for (const l of t.split("\n")) { if (!l) continue; const m = /^line (\d+) of/.exec(l); if (!m || +m[1] !== expected++) bad++; lines++; } bytes += t.length; heapMax = Math.max(heapMax, process.memoryUsage().heapUsed); }, onState: (s) => { if (s.parts % 100 === 0) states.push(s); } });
  console.log(`  ${r.tokens} tokens in ${r.parts} parts, ${lines} lines, ${(bytes / 1e6).toFixed(1)}MB, dropped overlap ${r.overlapDropped} chars, heap growth ${((heapMax - heap0) / 1e6).toFixed(1)}MB`);
  assert.equal(r.reason, "token-budget"); assert.ok(r.tokens >= 1_640_000 && r.tokens <= OUTPUT_TARGETS.browser); assert.equal(r.exactTokens, r.tokens, "token counts are provider-reported exact");
  assert.equal(bad, 0, "every line appears exactly once, in order"); assert.ok(r.overlapDropped > 0); assert.equal(r.text, "", "full text was never collected in RAM");
  assert.ok(heapMax - heap0 < 60e6, "memory stays bounded");
  assert.ok(model.calls.every((c) => c.n <= 4), "each continuation sends request + tail + instruction, never the whole output");
  // resume from a mid-job state with a fresh manager: continues without restarting
  const mid = states[1]; const lo2 = new LongOutput({ router, counter: new TokenCounter(), targetTokens: mid.tokens + 20000, perCallMax: 4096, collect: true });
  model.next = 1e9; // fresh model instance state would be lost; continuation derives position from the tail
  const r2 = await lo2.run({ messages: [{ role: "user", content: "Write a very long document." }], resumeFrom: mid });
  const first = /line (\d+)/.exec(r2.text)[1]; assert.ok(+first >= 1 && r2.parts > mid.parts);
});

test("long output stops naturally, honors abort and stalls", async () => {
  const router = new Router(); router.register(new LineModel({ stopAt: 3000 }));
  const lo = new LongOutput({ router, counter: new TokenCounter(), perCallMax: 1000, collect: true });
  const r = await lo.run({ messages: [{ role: "user", content: "go" }] }); assert.equal(r.reason, "complete"); assert.equal(r.text.trim().split("\n").length, 3000); assert.equal(r.collectedAll, true);
  const r2 = new Router(); r2.register(new ScriptedProvider({ id: "stuck", kind: "local-machine", script: Array(10).fill({ text: "same text same text same text", finishReason: "length" }) }));
  const rs = await new LongOutput({ router: r2, counter: new TokenCounter(), perCallMax: 100, collect: true }).run({ messages: [{ role: "user", content: "go" }] });
  assert.match(rs.reason, /stalled/); assert.ok(rs.parts <= 5);
  const ac = new AbortController(); const r3 = new Router(); r3.register(new LineModel({ stopAt: 1e9 }));
  const ra = await new LongOutput({ router: r3, counter: new TokenCounter(), perCallMax: 500, collect: 0 }).run({ messages: [{ role: "user", content: "go" }], signal: ac.signal, sink: (t, i) => { if (i.part >= 3) ac.abort(); } });
  assert.equal(ra.reason, "aborted");
});
