import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeTreeSitter, extractFile, checkSyntax, SymbolIndex, chunkFile, analyzeProject, scanExtract, languageFor } from "../src/code/index.js";
import { BarixFS, MemoryBackend } from "../src/fs/index.js";
import { TokenCounter } from "../src/tokens/counter.js";

const rt = await nodeTreeSitter();
const TS = `import { helper } from "./util.js";
import fs from "node:fs";
/** Adds numbers. */
export function add(a: number, b: number): number { return a + b; }
export class Store extends Base {
  private n = 0;
  inc(by = 1) { this.n += by; return this.n; }
  get value() { return this.n; }
}
export const double = (x) => x * 2;
const internal = 5;
export interface Shape { area(): number }
export type Id = string | number;
const lib = require("lodash");
`;

test("tree-sitter extracts TS symbols, members, imports, exports", async () => {
  const r = await extractFile(rt, "src/a.ts", TS);
  assert.equal(r.parser, "tree-sitter");
  const by = Object.fromEntries(r.symbols.map((s) => [s.parent ? `${s.parent}.${s.name}` : s.name, s]));
  assert.equal(by.add.kind, "function"); assert.equal(by.add.exported, true); assert.equal(by.add.doc, "Adds numbers.");
  assert.equal(by.Store.kind, "class"); assert.equal(by["Store.inc"].kind, "method"); assert.equal(by.double.kind, "function");
  assert.equal(by.internal.exported, false); assert.equal(by.Shape.kind, "interface"); assert.equal(by.Id.kind, "type");
  assert.deepEqual(r.imports.map((i) => i.spec).sort(), ["./util.js", "lodash", "node:fs"]);
  assert.ok(r.exports.some((e) => e.name === "add") && !r.exports.some((e) => e.name === "internal"));
  assert.equal(by.add.startLine, 4); assert.equal(by.Store.endLine, 9);
});

test("tree-sitter handles python, go, rust, java", async () => {
  const py = await extractFile(rt, "m.py", "import os\nfrom .util import x\nMAX = 3\n@dec\ndef top(a):\n    pass\nclass K:\n    def m(self):\n        pass\n");
  assert.deepEqual(py.symbols.map((s) => `${s.parent ?? ""}.${s.name}:${s.kind}`), [".MAX:const", ".top:function", ".K:class", "K.m:method"]);
  assert.deepEqual(py.imports.map((i) => i.spec), ["os", ".util"]);
  const go = await extractFile(rt, "a.go", 'package a\nimport "fmt"\ntype Srv struct{}\nfunc (s *Srv) Run() {}\nfunc helper() {}\n');
  assert.deepEqual(go.symbols.map((s) => `${s.name}:${s.kind}:${s.exported}`), ["Srv:struct:true", "Run:method:true", "helper:function:false"]);
  assert.equal(go.symbols[1].parent, "Srv"); assert.equal(go.imports[0].spec, "fmt");
  const rs = await extractFile(rt, "a.rs", "use std::io;\npub struct P;\nimpl P { pub fn go(&self) {} }\nfn private() {}\n");
  assert.ok(rs.symbols.some((s) => s.name === "go" && s.kind === "method" && s.parent === "P")); assert.equal(rs.imports[0].spec, "std::io");
  const jv = await extractFile(rt, "A.java", "import java.util.List;\npublic class A { public void m() {} }\n");
  assert.deepEqual(jv.symbols.map((s) => s.name), ["A", "m"]);
});

test("syntax checking uses the real grammar (verification primitive)", async () => {
  assert.deepEqual(await checkSyntax(rt, "ok.js", "const a = 1;\nfunction f() { return a }\n"), []);
  const bad = await checkSyntax(rt, "bad.js", "function f( {\n  return 1;\n");
  assert.ok(bad.length > 0 && bad[0].line >= 1);
  assert.equal(await checkSyntax(rt, "x.json", "{}"), null); // no grammar -> honest null, not "ok"
});

test("scanner fallback matches tree-sitter on core symbols", async () => {
  const s = scanExtract(languageFor("a.ts"), TS);
  const names = s.symbols.map((x) => x.name);
  for (const n of ["add", "Store", "double", "Shape", "Id"]) assert.ok(names.includes(n), n);
  assert.ok(s.imports.some((i) => i.spec === "./util.js"));
  const nr = await extractFile(null, "a.ts", TS); assert.equal(nr.parser, "scanner");
});

async function project(files) {
  const fs = await new BarixFS(new MemoryBackend(), { versioning: false }).init();
  for (const [p, c] of Object.entries(files)) await fs.writeFile(p, c);
  const idx = new SymbolIndex({ runtime: rt });
  for (const p of fs.files()) await idx.updateFile(p, await fs.readFile(p));
  return { fs, idx };
}

test("symbol index: find, references, import graph, impact, incremental skip", async () => {
  const { fs, idx } = await project({
    "src/util.js": "export function slugify(s) { return s.toLowerCase(); }\nexport const VERSION = 1;\n",
    "src/app.js": 'import { slugify } from "./util.js";\nexport function render(t) { return slugify(t); }\n',
    "src/main.js": 'import { render } from "./app";\nimport pkg from "left-pad";\nrender("x");\n',
    "pkg/mod.py": "from .helpers import h\n", "pkg/helpers.py": "def h(): pass\n",
  });
  assert.equal(idx.find("slugify")[0].path, "src/util.js");
  assert.equal(idx.find("slug")[0].name, "slugify");
  assert.deepEqual(idx.dependencies("src/main.js"), ["src/app.js"]);
  assert.deepEqual(idx.externalPackages("src/main.js"), ["left-pad"]);
  assert.deepEqual(idx.dependents("src/util.js"), ["src/app.js"]);
  assert.deepEqual(idx.impactOf("src/util.js").map((x) => `${x.path}@${x.distance}`), ["src/app.js@1", "src/main.js@2"]);
  assert.deepEqual(idx.dependencies("pkg/mod.py"), ["pkg/helpers.py"]);
  const refs = await idx.references("slugify", (p) => fs.readFile(p));
  assert.deepEqual(refs.map((r) => `${r.path}:${r.line}`), ["src/util.js:1", "src/app.js:1", "src/app.js:2"]);
  assert.equal(idx.symbolAt("src/app.js", 2).name, "render");
  const before = idx.parseCount; await idx.updateFile("src/util.js", await fs.readFile("src/util.js")); assert.equal(idx.parseCount, before); // unchanged => no reparse
  await idx.updateFile("src/util.js", "export function slugify2(s) {}\n"); assert.equal(idx.find("slugify2").length, 1); assert.equal(idx.definitions("slugify").length, 0);
  assert.equal(idx.hubs(10).find((x) => x.path === "src/util.js").dependents, 1);
});

test("chunker respects symbol boundaries and token budget", async () => {
  const counter = new TokenCounter();
  const body = (n) => Array.from({ length: n }, (_, i) => `  const v${i} = compute(${i}) + other(${i});`).join("\n");
  const src = `import x from "y";\n\nexport function small() { return 1; }\n\nexport function big() {\n${body(120)}\n}\n\nexport function tail() { return 2; }\n`;
  const r = await extractFile(rt, "a.js", src);
  const chunks = chunkFile("a.js", src, { symbols: r.symbols, counter, maxTokens: 200 });
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.tokens <= 200 * 1.3, `${c.id} has ${c.tokens}`);
  assert.ok(chunks.some((c) => c.names.includes("tail")) && chunks.some((c) => c.names.includes("small")));
  const covered = new Set(); for (const c of chunks) for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
  src.split("\n").forEach((line, i) => { if (line.trim()) assert.ok(covered.has(i + 1), `line ${i + 1} not covered by any chunk`); });
  const md = chunkFile("README.md", "# A\ntext\n## B\nmore text\n## C\nlast\n", { counter, maxTokens: 5 });
  assert.ok(md.some((c) => c.header.includes("A › B")));
});

test("project analyzer reads real manifests", async () => {
  const { fs } = await project({
    "package.json": JSON.stringify({ name: "demo", type: "module", scripts: { build: "vite build", test: "vitest run", lint: "eslint ." }, dependencies: { react: "18" }, devDependencies: { vite: "5", vitest: "1" } }),
    "src/main.jsx": "import React from 'react';\nconst a = 'x';\nexport default a;\n", "src/main.test.js": "test('x', () => {});\n", "pnpm-lock.yaml": "",
  });
  const p = await analyzeProject(fs);
  assert.equal(p.name, "demo"); assert.equal(p.packageManager, "pnpm");
  assert.deepEqual(p.commands, { build: "pnpm build", test: "pnpm test", lint: "pnpm lint" });
  assert.ok(p.frameworks.includes("React") && p.frameworks.includes("Vite") && p.frameworks.includes("Vitest"));
  assert.equal(p.testFiles, 1); assert.equal(p.conventions.quotes, "single"); assert.match(p.summary, /pnpm test/);
});
