// Project analyzer: reads manifests and samples sources to produce a ProjectProfile — what the
// project is, how it builds/tests/lints, its framework, entry points and style conventions.
// Everything here is derived from actual files; nothing is guessed from the project name.
import { languageFor } from "./languages.js";

const FRAMEWORKS_JS = {
  react: "React", "react-dom": "React", next: "Next.js", vue: "Vue", nuxt: "Nuxt", svelte: "Svelte", "@sveltejs/kit": "SvelteKit", "@angular/core": "Angular",
  solid: "Solid", "solid-js": "Solid", preact: "Preact", astro: "Astro", express: "Express", fastify: "Fastify", koa: "Koa", hono: "Hono", nestjs: "NestJS", "@nestjs/core": "NestJS",
  vite: "Vite", webpack: "webpack", esbuild: "esbuild", rollup: "Rollup", parcel: "Parcel", electron: "Electron", three: "three.js", phaser: "Phaser", tailwindcss: "Tailwind CSS",
  jest: "Jest", vitest: "Vitest", mocha: "Mocha", playwright: "Playwright", "@playwright/test": "Playwright", cypress: "Cypress", typescript: "TypeScript", eslint: "ESLint", prettier: "Prettier", "@biomejs/biome": "Biome",
};
const FRAMEWORKS_PY = { django: "Django", flask: "Flask", fastapi: "FastAPI", pytest: "pytest", numpy: "NumPy", pandas: "pandas", torch: "PyTorch", tensorflow: "TensorFlow", transformers: "Transformers", ruff: "ruff", mypy: "mypy", black: "black" };

/** @param {import("../fs/barixfs.js").BarixFS} fs */
export async function analyzeProject(fs, { sampleFiles = 40 } = {}) {
  const files = fs.files();
  const has = (p) => fs.exists(p);
  const read = async (p) => { try { return await fs.readFile(p); } catch { return null; } };
  const profile = { name: null, languages: {}, primaryLanguage: null, buildSystems: [], frameworks: [], packageManager: null, scripts: {}, commands: {}, entryPoints: [], dependencies: { runtime: [], dev: [] }, conventions: {}, manifests: [], testFiles: 0, sourceFiles: 0, monorepo: false, notes: [] };

  const bump = {}; for (const f of files) { const l = languageFor(f); if (l && !["data", "doc", "markup"].includes(l.family)) { bump[l.id] = (bump[l.id] ?? 0) + 1; profile.sourceFiles++; if (/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.|_test\.(go|py)$|^test_/.test(f)) profile.testFiles++; } }
  profile.languages = bump; profile.primaryLanguage = Object.entries(bump).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // ---- JS / TS ----
  const pkgText = await read("package.json");
  if (pkgText) {
    profile.manifests.push("package.json");
    try {
      const pkg = JSON.parse(pkgText);
      profile.name = pkg.name ?? null; profile.scripts = pkg.scripts ?? {};
      profile.moduleType = pkg.type === "module" ? "esm" : "commonjs";
      if (pkg.workspaces) { profile.monorepo = true; profile.notes.push("npm/yarn workspaces monorepo"); }
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      profile.dependencies = { runtime: Object.keys(pkg.dependencies ?? {}), dev: Object.keys(pkg.devDependencies ?? {}) };
      for (const k of Object.keys(all)) if (FRAMEWORKS_JS[k]) profile.frameworks.push(FRAMEWORKS_JS[k]);
      if (pkg.main) profile.entryPoints.push(pkg.main); if (typeof pkg.bin === "string") profile.entryPoints.push(pkg.bin); else if (pkg.bin) profile.entryPoints.push(...Object.values(pkg.bin));
      profile.buildSystems.push("npm");
      profile.packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
      const run = (s) => (profile.packageManager === "npm" ? `npm run ${s}` : `${profile.packageManager} ${s}`);
      for (const [k, names] of [["build", ["build"]], ["test", ["test"]], ["lint", ["lint", "eslint"]], ["dev", ["dev", "start"]], ["typecheck", ["typecheck", "tsc", "check"]]]) {
        const n = names.find((x) => profile.scripts[x]); if (n) profile.commands[k] = n === "test" && profile.packageManager === "npm" ? "npm test" : run(n);
      }
      if (profile.scripts.test && /no test specified/.test(profile.scripts.test)) { delete profile.commands.test; profile.notes.push("package.json test script is the npm placeholder"); }
    } catch (e) { profile.notes.push(`package.json is not valid JSON: ${e.message}`); }
  }
  if (has("tsconfig.json")) { profile.buildSystems.push("tsc"); profile.manifests.push("tsconfig.json"); if (!profile.commands.typecheck) profile.commands.typecheck = "npx tsc --noEmit"; }
  for (const c of ["vite.config.js", "vite.config.ts", "vite.config.mjs"]) if (has(c)) { profile.buildSystems.push("vite"); profile.manifests.push(c); }
  for (const c of ["webpack.config.js", "rollup.config.js", "esbuild.config.js"]) if (has(c)) { profile.buildSystems.push(c.split(".")[0]); profile.manifests.push(c); }
  if (files.some((f) => f.endsWith(".html")) && !pkgText) { profile.buildSystems.push("static-site"); profile.notes.push("static HTML project (no build step)"); }

  // ---- Python ----
  const req = await read("requirements.txt"), pyproj = await read("pyproject.toml");
  if (req || pyproj || has("setup.py")) {
    profile.buildSystems.push("python"); profile.manifests.push(...["requirements.txt", "pyproject.toml", "setup.py"].filter(has));
    const text = (req ?? "") + "\n" + (pyproj ?? "");
    for (const [k, v] of Object.entries(FRAMEWORKS_PY)) if (new RegExp(`(^|[\\s"'\\[,])${k}([\\s=<>~!\\]"',]|$)`, "im").test(text)) profile.frameworks.push(v);
    if (req) profile.dependencies.runtime.push(...req.split("\n").map((l) => l.trim().split(/[<>=~!\[ ]/)[0]).filter((l) => l && !l.startsWith("#") && !l.startsWith("-")));
    if (profile.frameworks.includes("pytest") || has("pytest.ini") || files.some((f) => /(^|\/)test_.*\.py$/.test(f))) profile.commands.test ??= "python -m pytest -q";
    if (profile.frameworks.includes("ruff")) profile.commands.lint ??= "ruff check .";
  }
  // ---- Rust / Go / Java / others ----
  if (has("Cargo.toml")) { profile.buildSystems.push("cargo"); profile.manifests.push("Cargo.toml"); profile.commands.build ??= "cargo build"; profile.commands.test ??= "cargo test"; profile.commands.lint ??= "cargo clippy"; const t = await read("Cargo.toml"); profile.name ??= /name\s*=\s*"([^"]+)"/.exec(t ?? "")?.[1] ?? null; }
  if (has("go.mod")) { profile.buildSystems.push("go"); profile.manifests.push("go.mod"); profile.commands.build ??= "go build ./..."; profile.commands.test ??= "go test ./..."; profile.commands.lint ??= "go vet ./..."; profile.name ??= /^module\s+(\S+)/m.exec((await read("go.mod")) ?? "")?.[1] ?? null; }
  if (has("pom.xml")) { profile.buildSystems.push("maven"); profile.manifests.push("pom.xml"); profile.commands.build ??= "mvn -q package"; profile.commands.test ??= "mvn -q test"; }
  if (has("build.gradle") || has("build.gradle.kts")) { profile.buildSystems.push("gradle"); profile.commands.build ??= "./gradlew build"; profile.commands.test ??= "./gradlew test"; }
  if (has("Makefile")) { profile.buildSystems.push("make"); profile.manifests.push("Makefile"); const mk = (await read("Makefile")) ?? ""; for (const t of ["build", "test", "lint"]) if (new RegExp(`^${t}:`, "m").test(mk)) profile.commands[t] ??= `make ${t}`; }
  if (has("CMakeLists.txt")) { profile.buildSystems.push("cmake"); profile.commands.build ??= "cmake -S . -B build && cmake --build build"; }
  if (has("Dockerfile")) profile.notes.push("has Dockerfile");
  if (has(".github/workflows") || files.some((f) => f.startsWith(".github/workflows/"))) profile.notes.push("has GitHub Actions workflows");

  // ---- entry points ----
  for (const c of ["src/index.js", "src/index.ts", "src/main.js", "src/main.ts", "src/main.tsx", "index.js", "index.html", "main.py", "app.py", "src/main.rs", "main.go", "cmd/main.go", "src/App.jsx", "src/App.tsx"]) if (has(c)) profile.entryPoints.push(c);
  profile.entryPoints = [...new Set(profile.entryPoints)];

  // ---- conventions from a sample of real sources ----
  const sample = files.filter((f) => { const l = languageFor(f); return l && !["data", "doc", "markup"].includes(l.family) && !/\.min\./.test(f); }).slice(0, sampleFiles);
  let tabs = 0, two = 0, four = 0, semi = 0, noSemi = 0, single = 0, dbl = 0, camel = 0, snake = 0;
  for (const f of sample) {
    const t = await read(f); if (!t || t.length > 200_000) continue;
    for (const line of t.split("\n").slice(0, 400)) {
      if (/^\t/.test(line)) tabs++; else if (/^ {2}\S/.test(line)) two++; else if (/^ {4}\S/.test(line)) four++;
      if (/;\s*$/.test(line)) semi++; else if (/[)\]}\w]\s*$/.test(line) && !/[{,(\[]\s*$/.test(line)) noSemi++;
      single += (line.match(/'/g) ?? []).length; dbl += (line.match(/"/g) ?? []).length;
    }
    camel += (t.match(/\b[a-z]+[A-Z]\w*\s*[(=]/g) ?? []).length; snake += (t.match(/\b[a-z]+_[a-z]+\w*\s*[(=]/g) ?? []).length;
  }
  profile.conventions = {
    indent: tabs > two + four ? "tabs" : two >= four ? "2 spaces" : "4 spaces",
    ...(["javascript", "typescript", "tsx"].includes(profile.primaryLanguage) ? { semicolons: semi > noSemi * 0.5, quotes: single > dbl ? "single" : "double" } : {}),
    naming: camel >= snake ? "camelCase" : "snake_case",
  };
  profile.frameworks = [...new Set(profile.frameworks)]; profile.buildSystems = [...new Set(profile.buildSystems)];
  profile.summary = summarizeProfile(profile);
  return profile;
}

export function summarizeProfile(p) {
  const l = [];
  l.push(`Project${p.name ? ` "${p.name}"` : ""}: ${p.primaryLanguage ?? "unknown language"}${p.frameworks.length ? ` + ${p.frameworks.slice(0, 6).join(", ")}` : ""}; ${p.sourceFiles} source files (${p.testFiles} tests).`);
  if (p.buildSystems.length) l.push(`Build: ${p.buildSystems.join(", ")}${p.packageManager ? ` (${p.packageManager})` : ""}.`);
  const cmds = Object.entries(p.commands).map(([k, v]) => `${k}=\`${v}\``); if (cmds.length) l.push(`Commands: ${cmds.join("; ")}.`);
  if (p.entryPoints.length) l.push(`Entry: ${p.entryPoints.slice(0, 4).join(", ")}.`);
  const c = p.conventions; if (c.indent) l.push(`Style: ${c.indent}${c.quotes ? `, ${c.quotes} quotes` : ""}${c.semicolons === false ? ", no semicolons" : c.semicolons ? ", semicolons" : ""}, ${c.naming}.`);
  if (p.moduleType) l.push(`Modules: ${p.moduleType}.`);
  if (p.notes.length) l.push(p.notes.join("; ") + ".");
  return l.join(" ");
}
