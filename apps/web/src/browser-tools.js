// Build / test / run tools for the BROWSER (no processes available): esbuild compiled to WASM bundles the
// project from BarixFS; the result runs inside a sandboxed iframe (opaque origin: it cannot touch Barix's own
// storage). Same tool names and evidence kinds as BarixTerm, so the verification layer treats both identically.
import * as esbuild from "esbuild-wasm/esm/browser.js";
import { dirname, joinPath } from "@barix/core";

let initP = null;
const ensure = (base) => (initP ??= esbuild.initialize({ wasmURL: `${base}esbuild.wasm`, worker: false }).catch((e) => { initP = null; throw e; }));
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".json", ".css"];
const LOADER = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".mts": "ts", ".json": "json", ".css": "css", ".txt": "text" };
const NODE_BUILTIN = /^(node:)?(fs|path|os|child_process|http|https|net|tls|dns|zlib|crypto|stream|url|util|events|buffer|readline|worker_threads|cluster|vm|module|process|perf_hooks|timers|v8)(\/.*)?$/;

const SHIM_TEST = `
const stack = [{ name: "", before: [], after: [], beforeEach: [], afterEach: [] }];
const cur = () => stack[stack.length - 1];
const reg = (globalThis.__barix_tests ??= []);
export function test(name, opts, fn) { if (typeof opts === "function") fn = opts; const path = stack.map((s) => s.name).filter(Boolean); const ctx = { be: stack.flatMap((s) => s.beforeEach), ae: stack.flatMap((s) => s.afterEach) }; reg.push({ name: [...path, name].join(" › "), fn, skip: opts && opts.skip, ctx }); }
export const it = test;
export function describe(name, opts, fn) { if (typeof opts === "function") fn = opts; stack.push({ name, before: [], after: [], beforeEach: [], afterEach: [] }); try { fn(); } finally { stack.pop(); } }
export const suite = describe;
export const before = (fn) => cur().before.push(fn), after = (fn) => cur().after.push(fn), beforeEach = (fn) => cur().beforeEach.push(fn), afterEach = (fn) => cur().afterEach.push(fn);
test.skip = (n, fn) => test(n, { skip: true }, fn); test.only = test;
export default test;`;
const SHIM_ASSERT = `
class AssertionError extends Error { constructor(m, extra) { super(m); this.name = "AssertionError"; this.code = "ERR_ASSERTION"; Object.assign(this, extra); } }
const fmt = (v) => { try { return typeof v === "string" ? JSON.stringify(v) : typeof v === "function" ? String(v) : JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) + "n" : x)); } catch { return String(v); } };
const deep = (a, b, strict) => { if (strict ? Object.is(a, b) : a == b) return true; if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false; if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false; if (a instanceof Date && b instanceof Date) return +a === +b; if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deep(v, b.get(k), strict)); if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v)); const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => k in b && deep(a[k], b[k], strict)); };
const fail = (m, d) => { throw new AssertionError(m ?? d); };
function assert(v, m) { if (!v) fail(m, "The expression evaluated to a falsy value: " + fmt(v)); }
Object.assign(assert, {
  ok: assert, AssertionError,
  equal: (a, b, m) => { if (!(a == b)) fail(m, fmt(a) + " == " + fmt(b)); }, notEqual: (a, b, m) => { if (a == b) fail(m, fmt(a) + " != " + fmt(b)); },
  strictEqual: (a, b, m) => { if (!Object.is(a, b)) fail(m, "Expected values to be strictly equal:\\n" + fmt(a) + " !== " + fmt(b)); }, notStrictEqual: (a, b, m) => { if (Object.is(a, b)) fail(m, "Expected values to be not strictly equal: " + fmt(a)); },
  deepEqual: (a, b, m) => { if (!deep(a, b, false)) fail(m, "Expected values to be loosely deep-equal:\\n" + fmt(a) + "\\nshould equal\\n" + fmt(b)); }, deepStrictEqual: (a, b, m) => { if (!deep(a, b, true)) fail(m, "Expected values to be strictly deep-equal:\\n" + fmt(a) + "\\nshould equal\\n" + fmt(b)); },
  notDeepStrictEqual: (a, b, m) => { if (deep(a, b, true)) fail(m, "Expected values not to be deep-equal: " + fmt(a)); },
  throws: (fn, exp, m) => { try { fn(); } catch (e) { if (exp instanceof RegExp && !exp.test(String(e && e.message))) fail(m, "error message " + fmt(String(e && e.message)) + " does not match " + exp); return; } fail(m, "Missing expected exception."); },
  doesNotThrow: (fn, m) => { try { fn(); } catch (e) { fail(m, "Got unwanted exception: " + (e && e.message)); } },
  rejects: async (p, exp, m) => { try { await (typeof p === "function" ? p() : p); } catch (e) { if (exp instanceof RegExp && !exp.test(String(e && e.message))) fail(m, "rejection message does not match"); return; } fail(m, "Missing expected rejection."); },
  match: (s, re, m) => { if (!re.test(s)) fail(m, "The input did not match the regular expression " + re + ". Input: " + fmt(s)); }, doesNotMatch: (s, re, m) => { if (re.test(s)) fail(m, "The input was expected not to match " + re); },
  fail: (m) => fail(m, "Failed"), ifError: (e) => { if (e) throw e; },
});
assert.strict = assert;
export default assert; export const { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, match, doesNotMatch, ifError, strict } = assert; export { AssertionError };`;
const STUB_NODE = (name) => `module.exports = new Proxy({}, { get: (_, k) => (k === "__esModule" ? false : k === "default" ? undefined : () => { throw new Error("'${name}' is not available in the browser sandbox (no Node APIs). Use BarixTerm for this project, or avoid ${name} in code that must run in the browser."); }) });`;

function vfs(fs) {
  const find = (p) => { for (const e of EXTS) if (fs.exists(p + e) && fs.statSync(p + e)?.type === "file") return p + e; const stripped = p.replace(/\.(m|c)?jsx?$/, ""); if (stripped !== p) for (const e of [".ts", ".tsx", ".mts"]) if (fs.exists(stripped + e)) return stripped + e; for (const e of EXTS.slice(1)) if (fs.exists(`${p}/index${e}`)) return `${p}/index${e}`; return null; };
  return {
    name: "barix-vfs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => { if (a.kind !== "entry-point") return undefined; let p; try { p = joinPath(a.path.replace(/^\.?\//, "")); } catch { return { errors: [{ text: `bad entry path ${a.path}` }] }; } const f = find(p); return f ? { path: f, namespace: "barix" } : { errors: [{ text: `entry point not found: ${a.path}` }] }; });
      b.onResolve({ filter: /^(node:)?(test|assert)(\/strict)?$/ }, (a) => ({ path: /test$/.test(a.path) ? "node:test" : "node:assert", namespace: "shim" }));
      b.onResolve({ filter: NODE_BUILTIN }, (a) => ({ path: a.path, namespace: "node-stub" }));
      b.onResolve({ filter: /^https?:\/\// }, (a) => ({ path: a.path, external: true }));
      b.onResolve({ filter: /^[./]/ }, (a) => { if (a.kind === "entry-point") { const f = find(joinPath(a.path)); return f ? { path: f, namespace: "barix" } : { errors: [{ text: `entry point not found: ${a.path}` }] }; } const base = a.namespace === "barix" ? dirname(a.importer) : ""; let p; try { p = a.path.startsWith("/") ? joinPath(a.path.slice(1)) : joinPath(base, a.path); } catch { return { errors: [{ text: `import escapes the project: ${a.path}` }] }; } const f = find(p); return f ? { path: f, namespace: "barix" } : { errors: [{ text: `cannot resolve "${a.path}" from ${a.importer || "entry"}` }] }; });
      b.onResolve({ filter: /^[^./]/ }, (a) => ({ path: `https://esm.sh/${a.path}`, external: true })); // bare packages come from a CDN at run time
      b.onLoad({ filter: /.*/, namespace: "shim" }, (a) => ({ contents: a.path === "node:test" ? SHIM_TEST : SHIM_ASSERT, loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "node-stub" }, (a) => ({ contents: STUB_NODE(a.path), loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "barix" }, async (a) => ({ contents: await fs.readFile(a.path), loader: LOADER[a.path.slice(a.path.lastIndexOf("."))] ?? "text", resolveDir: "/" }));
    },
  };
}
const fmtErr = (m) => ({ file: m.location?.file, line: m.location?.line, column: (m.location?.column ?? 0) + 1, text: m.text, lineText: m.location?.lineText?.trim().slice(0, 120) });
const fmtErrs = (es) => es.slice(0, 12).map((e) => `  ${e.file ?? "?"}:${e.line ?? "?"}:${e.column ?? "?"} ${e.text}${e.lineText ? `\n      ${e.lineText}` : ""}`).join("\n");

async function bundle(ctx, entries, extra = {}) {
  await ensure(ctx.base);
  return esbuild.build({ entryPoints: entries, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent", plugins: [vfs(ctx.fs)], jsx: "automatic", jsxImportSource: "https://esm.sh/react", ...extra }).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, errors: (e.errors ?? [{ text: e.message }]).map(fmtErr), warnings: (e.warnings ?? []).map(fmtErr) }));
}
const TESTFILE = /(^|\/)(tests?|__tests__)\/.+\.(m?[jt]sx?)$|\.(test|spec)\.(m?[jt]sx?)$|(^|\/)test\.(m?[jt]s)$/;
export const hasBrowserTests = (fs) => fs.files().some((f) => TESTFILE.test(f) && !f.startsWith("node_modules/") && !f.startsWith("remote/"));
function findEntry(ctx, hint) {
  if (hint && ctx.fs.exists(hint)) return hint;
  return ["src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js", "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js", "index.ts", "index.js", "main.js", "app.js", "script.js"].find((p) => ctx.fs.exists(p)) ?? null;
}
const P = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const browserTools = [
  {
    name: "run_build", group: "exec", requires: ["exec"], mutating: true, tier: 1, timeoutMs: 180_000,
    description: "Bundle the project with esbuild (WASM) to check that it compiles; writes dist/bundle.js. Reports errors with file:line.",
    parameters: P({ entry: { type: "string", description: "entry file (auto-detected if omitted)" } }),
    async run({ entry }, ctx) {
      const e = findEntry(ctx, entry); if (!e) return { ok: false, output: "No JavaScript/TypeScript entry point found (looked for src/main|index.*, index.js, main.js). Pass entry.", evidence: { kind: "command-missing", data: { key: "build" } } };
      const t0 = performance.now(); const r = await bundle(ctx, [e], { outfile: "dist/bundle.js" });
      if (!r.ok) { const d = fmtErrs(r.errors); return { ok: false, output: `build FAILED (${r.errors.length} error(s)) for ${e}\n${d}`, evidence: { kind: "build", data: { entry: e, summary: `${r.errors.length} error(s): ${r.errors[0]?.text}`, diagnostics: r.errors.map((x) => ({ file: x.file, line: x.line, col: x.column, message: x.text })) } }, meta: { summary: `${r.errors.length} error(s)` } }; }
      const out = r.outputFiles[0]; await ctx.fs.writeFile("dist/bundle.js", out.text); const kb = (out.contents.length / 1024).toFixed(1);
      return { ok: true, output: `build OK: ${e} → dist/bundle.js (${kb} KB) in ${(performance.now() - t0).toFixed(0)}ms${r.warnings?.length ? `\n${r.warnings.length} warning(s):\n${fmtErrs(r.warnings)}` : ""}`, evidence: { kind: "build", data: { entry: e, summary: `bundled ${kb} KB`, bytes: out.contents.length } }, meta: { summary: `bundled ${kb} KB` } };
    },
  },
  {
    name: "run_tests", group: "exec", requires: ["exec"], mutating: true, tier: 1, timeoutMs: 180_000,
    description: "Bundle and run the project's tests (*.test.js, *.spec.js, test.js, tests/**) in an isolated sandbox. Supports node:test and node:assert; reports pass/fail per test.",
    parameters: P({ file: { type: "string", description: "run only this test file" } }),
    async run({ file }, ctx) {
      const files = file ? [file] : ctx.fs.files().filter((f) => TESTFILE.test(f) && !f.startsWith("node_modules/") && !f.startsWith("remote/"));
      if (!files.length) return { ok: false, output: "No test files found (looked for *.test.js, *.spec.js, test.js, tests/**).", evidence: { kind: "command-missing", data: { key: "test" } } };
      let passed = 0, failed = 0; const lines = []; const diags = [];
      for (const f of files) {
        const r = await bundle(ctx, [f]); if (!r.ok) { failed++; lines.push(`✗ ${f}: failed to build\n${fmtErrs(r.errors)}`); diags.push(...r.errors.map((x) => ({ file: x.file, line: x.line, col: x.column, message: x.text }))); continue; }
        const run = await ctx.sandbox.run({ code: r.outputFiles[0].text, timeoutMs: 20000 });
        if (run.timedOut) { failed++; lines.push(`✗ ${f}: timed out after 20s`); continue; }
        if (!run.results.length) { if (run.error) { failed++; lines.push(`✗ ${f}: ${run.error}`); } else { passed++; lines.push(`✓ ${f} (script ran without errors)`); } }
        for (const t of run.results) { if (t.skip) continue; if (t.ok) { passed++; lines.push(`✓ ${f} › ${t.name}`); } else { failed++; lines.push(`✗ ${f} › ${t.name}\n    ${String(t.error).split("\n").slice(0, 4).join("\n    ")}`); const m = /\bat .*?:(\d+):(\d+)/.exec(t.stack ?? ""); diags.push({ file: f, line: m ? +m[1] : undefined, message: String(t.error).split("\n")[0] }); } }
        if (run.logs?.length) lines.push(`  console: ${run.logs.slice(0, 5).join(" | ").slice(0, 300)}`);
      }
      const summary = `${passed} passed, ${failed} failed`; const ok = failed === 0 && passed > 0;
      return { ok, output: `${ok ? "tests PASSED" : "tests FAILED"} — ${summary}\n${lines.join("\n")}`, evidence: { kind: "test", data: { summary, passed, failed, diagnostics: diags } }, meta: { summary } };
    },
  },
  {
    name: "run_js", group: "exec", requires: ["exec"], mutating: true, tier: 2, timeoutMs: 60_000,
    description: "Run a project JS/TS file (bundled) in the sandbox and return its console output. For quick experiments.",
    parameters: P({ file: { type: "string", description: "project file to run" } }, ["file"]),
    async run({ file }, ctx) {
      const r = await bundle(ctx, [file]); if (!r.ok) return { ok: false, output: `build failed:\n${fmtErrs(r.errors)}`, evidence: { kind: "command", data: { file, summary: "build failed" } } };
      const run = await ctx.sandbox.run({ code: r.outputFiles[0].text, timeoutMs: 15000 }); const ok = !run.error && !run.timedOut;
      return { ok, output: `${ok ? "ran OK" : "FAILED"}: ${file}${run.timedOut ? " (timed out)" : ""}\n${run.logs.join("\n")}${run.error ? `\nerror: ${run.error}` : ""}`, evidence: { kind: "command", data: { file, summary: ok ? "ok" : run.error } } };
    },
  },
];
