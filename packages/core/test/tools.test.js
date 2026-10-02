import { test } from "node:test";
import assert from "node:assert/strict";
import { BarixFS, MemoryBackend } from "../src/fs/index.js";
import { ProjectIntelligence } from "../src/code/intel.js";
import { nodeTreeSitter } from "../src/code/treesitter.js";
import { TokenCounter } from "../src/tokens/counter.js";
import { ToolRegistry, ToolExecutor, builtinTools, parseToolCalls, validate, renderToolDefs } from "../src/tools/index.js";
import { EvidenceLedger, extractClaims } from "../src/verify/index.js";
import { MemorySystem } from "../src/memory/index.js";

const rt = await nodeTreeSitter();
async function rig() {
  const fs = await new BarixFS(new MemoryBackend()).init(); const counter = new TokenCounter();
  const intel = new ProjectIntelligence({ fs, runtime: rt, counter }); const ledger = new EvidenceLedger({ fs });
  const memory = new MemorySystem({ counter }); await memory.load();
  const registry = new ToolRegistry().registerAll(builtinTools);
  const ctx = { fs, intel, ledger, memory, readSet: new Map(), capabilities: {}, engine: { recall: async (q) => `recalled:${q}` } };
  const exec = new ToolExecutor({ registry, ctx, ledger, counter });
  const call = (tool, args) => exec.run({ id: "t", tool, args });
  return { fs, intel, ledger, exec, call, registry, ctx };
}

test("protocol parser: canonical, Qwen JSON, Qwen XML, fenced; reports malformed calls", () => {
  const a = parseToolCalls('Let me look.\n<barix:call id="x" tool="read_file">{"path":"a.js"}</barix:call>\n<barix:call tool="grep">{"pattern":"foo",}</barix:call>');
  assert.deepEqual(a.calls.map((c) => [c.tool, c.args]), [["read_file", { path: "a.js" }], ["grep", { pattern: "foo" }]]); assert.equal(a.prose, "Let me look.");
  const b = parseToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"b.js"}}</tool_call>'); assert.equal(b.calls[0].args.path, "b.js");
  const c = parseToolCalls("<tool_call><function=write_file><parameter=path>c.js</parameter><parameter=content>hi</parameter></function></tool_call>"); assert.deepEqual(c.calls[0].args, { path: "c.js", content: "hi" });
  const d = parseToolCalls('```json\n{"tool":"list_dir","args":{"path":"src"}}\n```'); assert.equal(d.calls[0].tool, "list_dir");
  const e = parseToolCalls('<barix:call tool="read_file">{path: nope</barix:call>'); assert.equal(e.calls.length, 0); assert.match(e.errors[0].error, /not valid JSON/);
  assert.equal(parseToolCalls('<barix:call tool="read_file">{"path":"a').danglingCall, true);
  assert.equal(parseToolCalls("plain answer, no tools").calls.length, 0);
});

test("schema validation gives model-readable errors and coerces sloppy types", () => {
  const s = { type: "object", properties: { n: { type: "integer", minimum: 1 }, t: { type: "string" }, e: { type: "array", items: { type: "string" } } }, required: ["t"], additionalProperties: false };
  assert.deepEqual(validate(s, { t: "x", n: "3" }).value, { t: "x", n: 3 });
  assert.match(validate(s, { n: 0, z: 1 }).errors.join("|"), /t: required.*n: must be >= 1.*z: unknown parameter/s);
});

test("executor: guards block blind edits, writes are verified, evidence recorded, syntax errors surface", async () => {
  const r = await rig();
  let x = await r.call("patch_file", { path: "a.js", edits: [{ search: "x", replace: "y" }] }); assert.equal(x.ok, false); assert.match(x.output, /No such file/);
  x = await r.call("write_file", { path: "src/a.js", content: "export function add(a, b) { return a + b; }\n" }); assert.equal(x.ok, true); assert.match(x.output, /Verified on disk.*syntax OK/s);
  await r.fs.writeFile("src/blind.js", "export const z = 1;\n"); // exists, but Barix never read it
  x = await r.call("patch_file", { path: "src/blind.js", edits: [{ search: "1", replace: "2" }] }); assert.equal(x.ok, false); assert.match(x.output, /Read src\/blind.js .* before editing/);
  x = await r.call("write_file", { path: "src/blind.js", content: "x" }); assert.equal(x.ok, false); assert.match(x.output, /already exists/);
  x = await r.call("read_file", { path: "src/a.js" }); assert.match(x.output, /1  export function add/);
  x = await r.call("patch_file", { path: "src/a.js", edits: [{ search: "a + b", replace: "a - b" }] }); assert.equal(x.ok, true); assert.match(x.output, /\+export function add\(a, b\) \{ return a - b/);
  x = await r.call("patch_file", { path: "src/a.js", edits: [{ search: "return a - b; }", replace: "return a - b;" }] }); assert.equal(x.ok, true); assert.match(x.output, /SYNTAX ERRORS/); assert.ok(x.data.syntaxErrors.length);
  await r.fs.writeFile("src/a.js", "tampered"); // external change after our last read
  x = await r.call("patch_file", { path: "src/a.js", edits: [{ search: "tampered", replace: "x" }] }); assert.match(x.output, /changed since you last read/);
  assert.equal(r.ledger.records.filter((e) => e.kind === "fs-write").length, 3);
  x = await r.call("nope_tool", {}); assert.match(x.output, /Unknown tool/); x = await r.call("read_fle", { path: "x" }); assert.match(x.output, /Did you mean "read_file"/);
  x = await r.call("read_file", { path: 5 }); assert.match(x.output, /expected string/); x = await r.call("run_tests", {}); assert.match(x.output, /Unknown tool/);
});

test("code tools: search_code, find_symbol, outline, references, impact, move keeps evidence", async () => {
  const r = await rig();
  await r.call("write_file", { path: "src/util.js", content: "export function slugify(s) { return s.toLowerCase().replace(/ /g, '-'); }\n" });
  await r.call("write_file", { path: "src/page.js", content: "import { slugify } from './util.js';\nexport function renderTitle(t) { return '<h1 id=' + slugify(t) + '>' + t + '</h1>'; }\n" });
  assert.match((await r.call("find_symbol", { name: "slugify" })).output, /src\/util.js:1/);
  assert.match((await r.call("outline", { path: "src/page.js" })).output, /renderTitle \[function\] exported/);
  assert.match((await r.call("references", { name: "slugify" })).output, /src\/page.js:2/);
  assert.match((await r.call("impact", { path: "src/util.js" })).output, /src\/page.js@1/);
  assert.match((await r.call("search_code", { query: "convert title to url slug" })).output, /slugify/);
  const m = await r.call("move_file", { from: "src/util.js", to: "lib/util.js" }); assert.equal(m.ok, true);
  assert.deepEqual(r.ledger.changedFiles().sort(), ["lib/util.js", "src/page.js"]);
  assert.match((await r.call("find_symbol", { name: "slugify" })).output, /lib\/util.js/);
});

test("parallel read-only calls, serial mutations, output caps, secret redaction", async () => {
  const r = await rig(); const big = Array.from({ length: 4000 }, (_, i) => `line ${i} aws AKIAIOSFODNN7EXAMPLE9 ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`).join("\n");
  await r.fs.writeFile("big.txt", big);
  const res = await r.exec.runAll([{ id: "1", tool: "read_file", args: { path: "big.txt" } }, { id: "2", tool: "list_dir", args: {} }, { id: "3", tool: "write_file", args: { path: "n.txt", content: "x" } }, { id: "4", tool: "read_file", args: { path: "n.txt" } }]);
  assert.deepEqual(res.map((x) => x.ok), [true, true, true, true]);
  assert.ok(!res[0].output.includes("ghp_a1B2")); assert.match(res[0].output, /REDACTED:github-token/);
  const r2 = await r.exec.run({ id: "9", tool: "grep", args: { pattern: "line" } }); assert.ok(r2.output.length < 20000);
  assert.match(renderToolDefs(r.registry.available({})), /patch_file\(path: string, edits: object\[\]\)/);
});

test("verification ledger: verifies true claims, catches false ones (anti-hallucination)", async () => {
  const r = await rig();
  await r.call("write_file", { path: "src/app.js", content: "export const a = 1;\n" });
  r.ledger.record({ tool: "run_build", kind: "build", ok: true, data: { summary: "built in 1s" } });
  let v = await r.ledger.verify("I created `src/app.js` and the build succeeds.");
  assert.equal(v.ok, true, JSON.stringify(v.unverified)); assert.equal(v.verified.length, 2);
  v = await r.ledger.verify("I also updated src/other.js and all tests pass.");
  assert.deepEqual(v.unverified.map((c) => c.type + ":" + (c.path ?? "")).sort(), ["file:src/other.js", "test:"]);
  await r.call("read_file", { path: "src/app.js" }); await r.call("patch_file", { path: "src/app.js", edits: [{ search: "1", replace: "2" }] });
  v = await r.ledger.verify("The build succeeds."); assert.equal(v.unverified[0].type, "build"); assert.match(v.unverified[0].reason, /not re-run/);
  r.ledger.record({ tool: "run_tests", kind: "test", ok: false, data: { summary: "3 failed" } });
  v = await r.ledger.verify("Tests are passing now."); assert.equal(v.contradicted.length, 1);
  await r.fs.writeFile("src/app.js", "// changed behind our back\n");
  v = await r.ledger.verify("I modified src/app.js."); assert.match(v.unverified[0].reason, /differs from the last write/);
  await r.fs.deleteFile("src/app.js"); r.ledger.record({ tool: "delete_file", kind: "fs-delete", ok: true, data: { path: "src/app.js" } });
  assert.equal((await r.ledger.verify("I deleted src/app.js.")).ok, true);
  assert.equal(extractClaims("I will update src/x.js and then the build should pass. Should I run the tests?").length, 0, "future/hedged statements are not claims");
  assert.equal(extractClaims("```\nI created src/fake.js and tests pass\n```").length, 0, "code blocks are not claims");
});

test("forgiving tool arguments: aliases and lone objects are normalized (small models), real mistakes still rejected", async () => {
  const r = await rig(); await r.fs.writeFile("a.js", "const x = 1;\n");
  await r.call("read_file", { file: "a.js" });
  const x = await r.call("patch_file", { file_path: "a.js", edit: { old: "x = 1", new: "x = 2" } });
  assert.equal(x.ok, true, x.output); assert.equal(await r.fs.readFile("a.js"), "const x = 2;\n");
  assert.equal((await r.call("write_file", { path: "b.js", text: "hi" })).ok, true);
  const bad = await r.call("patch_file", { path: "a.js", edits: [{ replace: "x" }] }); assert.equal(bad.ok, false); assert.match(bad.output, /search: required/);
});
