import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrain } from "./helpers.js";
import { extractFacts, resolveIssues } from "../src/compaction/index.js";
import { persistencePolicy, MemorySystem } from "../src/memory/index.js";
import { detectSecrets, redactSecrets } from "../src/util/secrets.js";
import { PagedTextStore } from "../src/context/index.js";

const say = (b, role, text, extra = {}) => b.store.append({ role, text, ...extra });

test("fact extraction is extractive and typed", () => {
  const f = extractFacts({ role: "user", kind: "message", seq: 3, meta: {} }, "Hi! I want the app to work offline. We must not use any external CDN. Why does the build fail on Windows? ok thanks");
  const types = Object.fromEntries(f.map((x) => [x.type, x.text]));
  assert.match(types.requirement, /offline|CDN/); assert.match(types.question, /Windows/); assert.ok(!f.some((x) => /thanks/.test(x.text)));
  const c = extractFacts({ role: "tool", kind: "tool-result", seq: 9, meta: { tool: "patch_file", path: "src/a.js", ok: true, stats: "+3 -1" } }, "");
  assert.equal(c[0].type, "change"); assert.match(c[0].text, /patched src\/a.js \(\+3 -1\)/);
  const r = resolveIssues([{ type: "issue", text: "tests failing: parseConfig throws", seq: 1 }, { type: "result", text: "run_tests: PASS — parseConfig tests ok", seq: 5 }]);
  assert.equal(r[0].resolved, true);
});

test("compaction keeps requirements, decisions, open issues, changes; archives instead of deleting", async () => {
  const b = makeBrain();
  await say(b, "user", "I want a todo app. It must persist to localStorage and never call a server.");
  await say(b, "assistant", "We will use vanilla JS with a small store module instead of a framework.");
  await say(b, "tool", "ok", { kind: "tool-result", meta: { tool: "write_file", path: "src/store.js", ok: true, stats: "+40 -0" } });
  await say(b, "tool", "FAIL", { kind: "tool-result", meta: { tool: "run_tests", ok: false, summary: "2 failed: store.load returns undefined" } });
  for (let i = 0; i < 40; i++) { await say(b, "user", `filler question number ${i} about unrelated styling details and colors`); await say(b, "assistant", `filler answer ${i} `.repeat(30)); }
  const before = b.store.stats();
  const rep = await b.compactor.compact(1500);
  assert.ok(rep.compacted > 20 && rep.ratio > 3, JSON.stringify(rep));
  const sum = b.store.activeSummaries()[0].text;
  assert.match(sum, /never call a server/); assert.match(sum, /vanilla JS/); assert.match(sum, /patched?|wrote src\/store.js/); assert.match(sum, /store\.load returns undefined/);
  const after = b.store.stats(); assert.equal(after.all, before.all); assert.ok(after.live < before.live / 2); assert.equal(after.evicted, 0);
  // the originals are still retrievable
  assert.match(await b.engine.recall("#1"), /localStorage/);
  const hits = await b.store.index.search("localStorage server", { k: 3 }); assert.ok(hits.length);
});

test("hierarchical merge: L1 summaries merge into L2, dropping resolved issues, keeping the open one", async () => {
  const b = makeBrain(); b.compactor.mergeFanIn = 4;
  await say(b, "user", "The login bug is critical: login throws TypeError on empty password.");
  await say(b, "tool", "x", { kind: "tool-result", meta: { tool: "run_tests", ok: false, summary: "login throws TypeError on empty password" } });
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 12; i++) { await say(b, "user", `round ${round} chat ${i}: ` + "details about layout and spacing ".repeat(12)); await say(b, "assistant", "reply ".repeat(60)); }
    if (round === 3) { await say(b, "tool", "ok", { kind: "tool-result", meta: { tool: "run_tests", ok: true, summary: "login tests all pass" } }); await say(b, "user", "We still need to ensure the export button must work offline."); }
    await b.compactor.compactIfNeeded(4000);
  }
  const nodes = b.store.activeSummaries(); assert.ok(nodes.some((n) => n.level >= 2), "an L2 node exists: " + nodes.map((n) => n.level));
  const all = nodes.map((n) => n.text).join("\n"); assert.match(all, /export button must work offline/);
  assert.ok(nodes.reduce((a, n) => a + n.tokens, 0) < 1800, "summaries stay bounded");
});

test("engine respects the window, keeps the latest user turn, and measures prefix reuse", async () => {
  const b = makeBrain(); const sys = "You are Barix. ".repeat(40);
  for (let i = 0; i < 60; i++) { await say(b, "user", `Question ${i}: explain topic ${i} in a lot of detail please. `.repeat(8)); await say(b, "assistant", `Answer ${i}: ` + "blah ".repeat(150)); }
  await say(b, "user", "FINAL: what is the secret codename I told you at the start?");
  const r1 = await b.engine.build({ systemPrompt: sys, window: 6000, reserveOutput: 800, mode: "chat" });
  assert.ok(r1.report.promptTokens <= 6000 - 800, `prompt ${r1.report.promptTokens}`);
  assert.match(r1.messages.at(-1).content, /FINAL: what is the secret codename/);
  await say(b, "assistant", "I don't have one."); await say(b, "user", "ok, now continue");
  const r2 = await b.engine.build({ systemPrompt: sys, window: 6000, reserveOutput: 800, mode: "chat" });
  assert.ok(r2.report.reusedPrefixTokens > 500, `reused ${r2.report.reusedPrefixTokens}`);
  assert.throws; await assert.rejects(b.engine.build({ systemPrompt: sys, window: 600, reserveOutput: 500 }));
});

test("long-term memory: policy gates, secrets never stored, recall is ranked and budgeted", async () => {
  assert.equal(persistencePolicy("Remember that I prefer tabs over spaces.").ok, true);
  assert.equal(persistencePolicy("remember my token is ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8").ok, false);
  assert.equal(persistencePolicy("The build is broken right now").ok, false);
  const m = new MemorySystem(); await m.load();
  assert.equal((await m.remember("I prefer TypeScript with strict mode for all new code.")).stored, true);
  assert.equal((await m.remember("My timezone is Europe/Berlin and I work mornings.")).stored, true);
  assert.equal((await m.remember("The weather is nice")).stored, false);
  const r = await m.recall("which language should the new module use? typescript?", { k: 3 }); assert.match(r[0].text, /TypeScript/);
  assert.equal(r.some((x) => /Berlin/.test(x.text)), false, "irrelevant memory is not dumped into the request");
  await m.forget(r[0].id); assert.equal((await m.recall("typescript strict")).length, 0);
  m.startTask("Add dark mode", { plan: ["find theme file", "add toggle"] }); m.noteError("toggle test fails"); m.completeStep(1);
  assert.match(m.renderTask(), /\[x\] find theme file.*\[ \] add toggle/s); assert.match(m.renderTask(), /Open errors: toggle test fails/);
});

test("secret detection finds real tokens, ignores placeholders", () => {
  const txt = `const k = "AKIAIOSFODNN7EXAMPLE";\nGITHUB=ghp_${"x9Y8w7V6u5T4s3R2q1P0o9N8m7L6k5J4i3H2"}\npassword = "password"\napi_key: "<your-key>"\nsecret = "f3a9c1d27b8e4455aa91"`;
  const types = detectSecrets(txt).map((s) => s.type).sort();
  assert.deepEqual(types, ["aws-access-key", "generic-assignment", "github-token"]);
  assert.ok(!redactSecrets(txt).includes("ghp_x9Y8"));
});

test("paged store keeps RAM bounded and round-trips across pages", async () => {
  const p = new PagedTextStore({ pageChars: 10_000, cachePages: 2 }); const refs = [];
  for (let i = 0; i < 500; i++) refs.push(await p.append(`record-${i}-` + "z".repeat(900)));
  assert.ok(p.residentChars < 10_000 * 4); assert.equal((await p.read(refs[3])).slice(0, 9), "record-3-"); assert.equal((await p.read(refs[499])).slice(0, 11), "record-499-");
  assert.ok(p.sealed > 40);
});
