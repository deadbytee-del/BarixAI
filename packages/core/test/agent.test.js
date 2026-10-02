import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { createBarix, ScriptedProvider, nodeTreeSitter, CallStreamFilter, understand } from "../src/index.js";

const rt = await nodeTreeSitter();
// A REAL test runner tool: materializes the BarixFS project to a temp dir and runs `node test.js` (real execution).
const runTests = (barixRef) => ({
  name: "run_tests", group: "exec", requires: ["exec"], description: "Run the project's tests.", parameters: { type: "object", properties: {}, additionalProperties: false },
  evidence: undefined,
  async run(_, ctx) {
    const dir = await mkdtemp(join(tmpdir(), "barix-run-"));
    try {
      for (const p of ctx.fs.files()) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), await ctx.fs.readFile(p)); }
      const r = await new Promise((res) => execFile("node", ["test.js"], { cwd: dir, timeout: 20000 }, (err, stdout, stderr) => res({ code: err ? err.code ?? 1 : 0, out: (stdout + stderr).trim() })));
      return { ok: r.code === 0, output: `exit ${r.code}\n${r.out}`, evidence: { kind: "test", data: { exitCode: r.code, summary: r.out.split("\n").slice(-2).join(" ").slice(0, 120) } }, meta: { summary: r.out.split("\n").pop() } };
    } finally { await rm(dir, { recursive: true, force: true }); }
  },
});
const call = (tool, args) => `<barix:call tool="${tool}">${JSON.stringify(args)}</barix:call>`;
async function rig(script, files = {}) {
  const { MemoryBackend } = await import("../src/fs/backends.js"); const backend = new MemoryBackend();
  const model = new ScriptedProvider({ id: "m", kind: "local-machine", window: 16384, maxOutput: 2048, script });
  const b = await createBarix({ backend, runtime: rt, providers: [model], tools: [runTests()], capabilities: { exec: true }, persist: false });
  for (const [p, c] of Object.entries(files)) await b.fs.writeFile(p, c); await b.intel.sync();
  return { b, model };
}
const PROJECT_OK = { "package.json": JSON.stringify({ name: "calc", scripts: { test: "node test.js" } }), "src/calc.js": "export function add(a, b) {\n  return a + b;\n}\n", "test.js": "import { add } from './src/calc.js';\nif (add(2, 3) !== 5) process.exit(1);\nconsole.log('ok: 1 test passed');\n" };
const PROJECT = {
  "package.json": JSON.stringify({ name: "calc", scripts: { test: "node test.js" } }),
  "src/calc.js": "export function add(a, b) {\n  return a - b;\n}\n",
  "test.js": "import { add } from './src/calc.js';\nif (add(2, 3) !== 5) { console.error('FAIL add(2,3) =', add(2, 3)); process.exit(1); }\nconsole.log('ok: 1 test passed');\n",
};

test("coding loop: inspect → read → patch → (gate runs tests) → verified answer", async () => {
  const { b, model } = await rig([
    `I'll look at the code.\n${call("search_code", { query: "add function" })}`,
    call("read_file", { path: "src/calc.js" }),
    `${call("patch_file", { path: "src/calc.js", edits: [{ search: "a - b", replace: "a + b" }] })}`,
    "I fixed `add` in `src/calc.js` so it adds instead of subtracts, and all tests pass.",
    "Fixed: `add` in `src/calc.js` now returns `a + b`. The test suite passes.",
  ], PROJECT);
  const events = []; const r = await b.ask("Fix the bug in src/calc.js: add(2,3) should be 5. Then run the tests.", { onEvent: (e) => events.push(e) });
  assert.equal(r.plan.intent, "debug"); assert.ok(r.plan.toolGroups.includes("exec"));
  assert.equal(await b.fs.readFile("src/calc.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  assert.equal(r.ok, true, JSON.stringify(r.verification.unverified)); assert.ok(events.some((e) => e.type === "gate" && /run_tests/.test(e.action)), "Barix ran the tests itself to verify the claim");
  assert.equal(b.ledger.last("test").ok, true); assert.deepEqual(r.changedFiles, ["src/calc.js"]); assert.match(r.text, /✓ changed src\/calc.js/); assert.match(r.text, /✓ test ok/);
  assert.ok(!events.some((e) => e.type === "token" && /barix:call/.test(e.text)), "tool-call syntax is never shown to the user");
});

test("anti-hallucination: a false claim is caught, the model is told, and the final answer is honest or corrected", async () => {
  const { b } = await rig([
    "Done! I created `src/utils.js` with the helper and the build succeeds.",       // no tool use at all
    call("write_file", { path: "src/utils.js", content: "export const helper = () => 1;\n" }),
    "I created `src/utils.js` with the helper.",
  ], PROJECT_OK);
  const r = await b.ask("Create src/utils.js exporting a helper function.");
  assert.ok(b.fs.exists("src/utils.js")); assert.equal(r.ok, true); assert.equal(r.corrections, 1); assert.match(r.text, /Barix ran run_tests after the changes — passed/);
  assert.ok(!/build succeeds/.test(r.answer));
  // stubborn model: keeps claiming without doing it → final footer must say NOT verified
  const { b: b2 } = await rig(Array(8).fill("I created `src/ghost.js` and all tests pass."), PROJECT);
  const r2 = await b2.ask("Create src/ghost.js"); assert.equal(r2.ok, false); assert.match(r2.text, /\? changed src\/ghost.js — not verified/); assert.ok(!b2.fs.exists("src/ghost.js"));
});

test("failed tests feed back into the loop; model fixes; final state is verified green", async () => {
  const { b, model } = await rig([
    call("read_file", { path: "src/calc.js" }),
    "I fixed `src/calc.js`, tests pass.",   // claims success without changing anything → gate runs tests → FAIL → loop continues
    call("patch_file", { path: "src/calc.js", edits: [{ search: "a - b", replace: "a + b" }] }),
    "Now `src/calc.js` adds correctly and the tests pass.",
  ], PROJECT);
  const r = await b.ask("tests are failing for add in src/calc.js, fix it");
  assert.equal(r.ok, true); assert.equal(b.ledger.last("test").ok, true);
  const second = model.calls[2].messages.map((m) => m.content).join("\n"); assert.match(second, /FAIL add\(2,3\) = -1/); assert.match(second, /verification: the run above FAILED/i);
});

test("tool-call mistakes are corrected by Barix, not the user: bad JSON, unknown tool, blind edit", async () => {
  const { b, model } = await rig([
    `<barix:call tool="read_file">{path: src/calc.js}</barix:call>`,
    call("read_fil", { path: "src/calc.js" }),
    call("patch_file", { path: "src/calc.js", edits: [{ search: "a - b", replace: "a * b" }] }),
    call("read_file", { path: "src/calc.js" }),
    "The file `src/calc.js` contains an `add` function.",
  ], PROJECT);
  const r = await b.ask("What does src/calc.js export?"); assert.equal(r.ok, true);
  const all = model.calls.map((c) => c.messages.at(-1).content).join("\n---\n");
  assert.match(all, /Could not run your tool call/); assert.match(all, /Did you mean "read_file"/); assert.match(all, /Read src\/calc.js with read_file before editing/);
  assert.equal(await b.fs.readFile("src/calc.js"), PROJECT["src/calc.js"], "blind edit never touched the file");
});

test("plain chat uses no tools and no project context; identity is Barix", async () => {
  const { b, model } = await rig(["Hi! I'm Barix."], PROJECT);
  const r = await b.ask("hello, who are you?"); assert.equal(r.plan.intent, "chat"); assert.equal(r.plan.needs.tools, false);
  const sys = model.calls[0].messages[0].content; assert.match(sys, /You are Barix/); assert.ok(!/barix:call/.test(sys), "no tool protocol for plain chat"); assert.ok(!/Qwen|GPT|Claude|Gemini/.test(sys));
});

test("understanding: intents, tool groups, verbosity, long-form size, history recall", () => {
  const u = (t, o) => understand(t, { projectFiles: 5, capabilities: { exec: true }, ...o });
  assert.equal(u("explain how a binary tree works briefly").intent, "explain"); assert.equal(u("explain how a binary tree works briefly").verbosity, "concise");
  assert.equal(u("refactor src/auth.ts to use async/await").intent, "refactor");
  assert.equal(u("here's a screenshot of the bug", { hasImages: true }).intent, "vision-coding");
  assert.equal(u("publish this project to GitHub pages").intent, "publish"); assert.ok(u("publish this project to GitHub pages").toolGroups.includes("github"));
  assert.equal(u("look at https://github.com/vitejs/vite/pull/123").intent, "github");
  assert.equal(u("write a 40000 word novel about a robot").expectedOutputTokens, 56000);
  assert.equal(u("what did we decide earlier about the database?").needs.recall, true);
  assert.equal(u("add a dark mode toggle to the settings page").needs.code, true);
});

test("CallStreamFilter hides tool-call blocks across arbitrary chunking", () => {
  const f = new CallStreamFilter(); const out = []; const s = 'Let me check.\n<barix:call tool="x">{"a":"<b>"}</barix:call> and then done <3';
  for (let i = 0; i < s.length; i += 3) out.push(...f.push(s.slice(i, i + 3))); out.push(...f.flush());
  assert.equal(out.join(""), "Let me check.\n and then done <3");
});

test("termination guarantee: a model that loops on tool calls has tools withdrawn and must answer from evidence", async () => {
  const { b, model } = await rig([call("read_file", { path: "src/calc.js" }), call("read_file", { path: "src/calc.js" }), call("read_file", { path: "src/calc.js" }), "The file `src/calc.js` defines `add` (currently subtracting).", "unused"], PROJECT);
  const r = await b.ask("What does src/calc.js do?"); assert.equal(r.steps, 4); assert.match(r.answer, /defines `add`/);
  const last = model.calls.at(-1); assert.ok(!/barix:call/.test(last.messages[0].content), "tool protocol is gone from the final prompt"); assert.match(last.messages.at(-1).content, /No more tool calls are available/);
});

test("weak-model resilience: a call-syntax 'final answer' is replaced by a deterministic evidence report", async () => {
  const { b } = await rig([
    call("read_file", { path: "src/calc.js" }),
    call("patch_file", { path: "src/calc.js", edits: [{ search: "a - b", replace: "a + b" }] }),
    call("run_tests", {}), call("run_tests", {}),               // loops → tools withdrawn
    call("run_tests", {}),                                        // …and it STILL emits a call as its final answer
  ], PROJECT);
  const r = await b.ask("fix add in src/calc.js and run the tests");
  assert.ok(!/barix:call/.test(r.text), "no raw tool syntax reaches the user"); assert.match(r.answer, /Changed files[\s\S]*- src\/calc\.js \(patch\)/); assert.match(r.answer, /Tests: PASSED/);
  assert.equal(r.ok, true); assert.equal(await b.fs.readFile("src/calc.js"), "export function add(a, b) {\n  return a + b;\n}\n");
});
