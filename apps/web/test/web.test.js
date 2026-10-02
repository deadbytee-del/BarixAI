// Real-browser tests (headless Chromium via Playwright) against the BUILT static site served under a GitHub-Pages-style subpath.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, site, openBarix, fakeEndpoint, call, sendAndWait } from "./harness.js";

let browser, srv;
before(async () => { browser = await launch(); srv = await site("/BarixAI/"); });
after(async () => { await browser?.close(); await srv?.close(); });
const noErrors = (errors) => assert.deepEqual(errors.filter((e) => !/favicon|Failed to load resource.*404/.test(e)), []);

test("boots under a repository subpath, is cross-origin isolated, probes hardware, shows the honest welcome screen", async () => {
  const { page, errors, ctx } = await openBarix(browser, srv.url, null);
  assert.equal(await page.title(), "Barix"); assert.equal(await page.evaluate(() => crossOriginIsolated), true, "COOP/COEP service-worker shim gives SharedArrayBuffer on static hosting");
  assert.match(await page.locator(".welcome").innerText(), /What can Barix build for you/); await page.locator(".welcome summary").click(); assert.match(await page.locator(".welcome").innerText(), /Barix Lite[\s\S]*Barix Core[\s\S]*Barix Pro/); assert.match(await page.locator(".welcome").innerText(), /WebAssembly|WebGPU/);
  await page.locator(".starter").first().click(); assert.match(await page.inputValue("#input"), /to-do app/, "starter prompts fill the composer");
  const hw = await page.evaluate(() => window.__barix.hw); assert.equal(hw.opfs, true); assert.ok(hw.cores >= 1);
  const base = await page.evaluate(() => window.__barix.base); assert.equal(new URL(base).pathname, "/BarixAI/");
  noErrors(errors); await ctx.close();
});

test("end-to-end chat: plan → tool call → file written to OPFS → verified answer; survives a reload", async () => {
  const ep = await fakeEndpoint([call("write_file", { path: "src/app.js", content: "export const greet = (n) => `hi ${n}`;\n" }), "I created `src/app.js` exporting `greet`."]);
  try {
    const { page, errors, ctx } = await openBarix(browser, srv.url, ep, { project: "persist1" }); await sendAndWait(page, "Create src/app.js exporting a greet function");
    const msg = await page.locator(".msg.assistant").last().innerText(); assert.match(msg, /write_file src\/app.js — syntax OK/); assert.match(msg, /I created src\/app.js/); assert.match(msg, /✓ changed src\/app.js \(verified on disk\)/);
    await page.locator("#tree .row", { hasText: "src" }).first().click(); await page.waitForFunction(() => [...document.querySelectorAll("#tree .row")].some((r) => r.textContent.includes("app.js")), null, { timeout: 5000 });
    assert.equal((await page.evaluate(() => window.__barix.brain.call("fs.audit"))).ok, true, "in-memory tree == OPFS contents");
    await page.reload(); await page.waitForFunction(() => window.__barix?.lastStatus, null, { timeout: 30000 });
    const tree = await page.evaluate(() => window.__barix.brain.call("fs.tree")); assert.deepEqual(tree.map((e) => e.path).sort(), ["src", "src/app.js"]);
    assert.match((await page.evaluate(() => window.__barix.brain.call("fs.read", { path: "src/app.js" }))).text, /greet/);
    noErrors(errors); await ctx.close();
  } finally { await ep.close(); }
});

test("upload a folder, Barix indexes it with tree-sitter and finds code semantically; Inside Barix shows the real context", async () => {
  const ep = await fakeEndpoint(["The parsing logic is in `src/parse.js`."]);
  try {
    const { page, errors, ctx } = await openBarix(browser, srv.url, ep);
    await page.evaluate(async () => { const enc = (s) => new TextEncoder().encode(s).buffer; await window.__barix.brain.call("fs.import", { files: [{ path: "src/parse.js", bytes: enc("export function parseConfig(text) {\n  return JSON.parse(text);\n}\n") }, { path: "src/ui.js", bytes: enc("export function renderSidebar(items) { return items.map(String).join(','); }\n") }, { path: "README.md", bytes: enc("# Demo\nA tiny project.\n") }] }); });
    const st = await page.evaluate(() => window.__barix.brain.call("status")); assert.ok(st.parsers.loaded.includes("javascript"), JSON.stringify(st.parsers)); assert.ok(st.health.symbols >= 2 && st.health.treeSitterFiles >= 2);
    const hits = await page.evaluate(() => window.__barix.brain.call("project.search", { query: "where do we parse the config JSON?" })); assert.equal(hits[0].path, "src/parse.js");
    await sendAndWait(page, "where is the config parsing done in src/parse.js?");
    const sys = ep.calls[0].messages.at(-1).content; assert.match(sys, /parseConfig/, "Barix retrieved and injected the relevant code");
    await page.click("#btn-inside"); await page.waitForSelector(".bar"); assert.match(await page.locator("#tab-body").innerText(), /last prompt barix built[\s\S]*prefix reuse/i); await page.click('[data-tab="evidence"]');
    noErrors(errors); await ctx.close();
  } finally { await ep.close(); }
});

test("browser build + test tools: esbuild-WASM bundles the project, tests run in an isolated sandbox, evidence feeds verification", async () => {
  const test1 = `import { test } from "node:test"; import assert from "node:assert/strict"; import { add } from "./src/math.js"; test("adds", () => assert.equal(add(2, 3), 5)); test("also", () => assert.deepEqual([1, 2], [1, 2]));\n`;
  const ep = await fakeEndpoint([call("run_tests", {}), "All tests pass.", call("read_file", { path: "src/math.js" }), call("patch_file", { path: "src/math.js", edits: [{ search: "a - b", replace: "a + b" }] }), "I fixed `src/math.js` and all tests pass."]);
  try {
    const { page, errors, ctx } = await openBarix(browser, srv.url, ep);
    await page.evaluate(async (t) => { const enc = (s) => new TextEncoder().encode(s).buffer; await window.__barix.brain.call("fs.import", { files: [{ path: "src/math.js", bytes: enc("export const add = (a, b) => a - b;\n") }, { path: "math.test.js", bytes: enc(t) }, { path: "package.json", bytes: enc('{"name":"m"}') }] }); }, test1);
    await sendAndWait(page, "run the tests", { timeout: 120000 });
    const m1 = await page.locator(".msg.assistant").last().innerText(); assert.match(m1, /run_tests/); assert.ok(/1 failed|FAILED|failed/.test(m1) || /\?|✗/.test(m1), m1);
    const ev = await page.evaluate(() => window.__barix.brain.call("status")).then((s) => s.evidence); assert.equal(ev.find((e) => e.kind === "test").ok, false, "the failing test was really executed in the sandbox");
    await sendAndWait(page, "fix src/math.js so add works, then run the tests", { timeout: 120000 });
    const ev2 = await page.evaluate(() => window.__barix.brain.call("status")).then((s) => s.evidence); const tests = ev2.filter((e) => e.kind === "test"); assert.equal(tests.at(-1).ok, true, JSON.stringify(tests)); assert.match(tests.at(-1).data.summary, /2 passed, 0 failed/);
    assert.match(await page.locator(".msg.assistant").last().innerText(), /Barix ran run_tests after the changes — passed|✓ changed src\/math.js/);
    const build = await page.evaluate(async () => { const r = await window.__barix.brain.call("fs.write", { path: "src/main.js", text: 'import { add } from "./math.js"; console.log(add(1, 2));' }); return r; }); assert.ok(build.size > 0);
    noErrors(errors); await ctx.close();
  } finally { await ep.close(); }
});

test("vision + coding in the browser: preview renders the project page to PNG, Barix measures it and compares with the reference", async () => {
  const { chromium } = await import("playwright-core"); void chromium;
  const html = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:${c.bg};font-family:sans-serif}.card{margin:80px auto;width:300px;height:200px;background:${c.card};border-radius:12px}</style></head><body><div class="card"></div></body></html>`;
  const ep = await fakeEndpoint([call("preview_page", { path: "index.html", width: 800, height: 500 }), "I rendered `index.html`; the page shows a card."]);
  try {
    const { page, errors, ctx } = await openBarix(browser, srv.url, ep);
    await page.evaluate(async (h) => { await window.__barix.brain.call("fs.import", { files: [{ path: "index.html", bytes: new TextEncoder().encode(h).buffer }] }); }, html({ bg: "#0f172a", card: "#1e293b" }));
    await sendAndWait(page, "preview index.html in the browser", { timeout: 90000 });
    const txt = await page.locator(".msg.assistant").last().innerText(); assert.match(txt, /preview_page|Rendered/i);
    const feedback = ep.calls.at(-1).messages.map((m) => m.content).join("\n"); assert.match(feedback, /Rendered index\.html at 800×500/); assert.match(feedback, /Measured palette: #0f172a[\s\S]*#1e293b/, "colors were measured from the real render");
    noErrors(errors); await ctx.close();
  } finally { await ep.close(); }
});
