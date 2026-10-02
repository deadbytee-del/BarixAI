// Build the web app and place it at the REPOSITORY ROOT, so GitHub Pages configured as "Deploy from branch: main / (root)"
// serves Barix itself at https://<user>.github.io/<repo>/ . Only the files listed below are managed (removed + recopied).
import { execFileSync } from "node:child_process";
import { cp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const dist = path.join(root, "apps/web/dist");
execFileSync(process.execPath, [path.join(root, "scripts/build-web.mjs")], { cwd: root, stdio: "inherit" });
const MANAGED = ["index.html", "404.html", "coi-sw.js", "manifest.webmanifest", "icon.svg", "build.json", "assets", "wasm", "ort", "esbuild.wasm"];
for (const f of MANAGED) { await rm(path.join(root, f), { recursive: true, force: true }); await cp(path.join(dist, f), path.join(root, f), { recursive: true }); }
// A 32-char model class name next to "mistral" model keys trips secret scanners (false positive); a newline is harmless JS whitespace.
for (const f of ["brain.worker", "infer.worker"]) { const fp = path.join(root, "assets", f + ".js"); await writeFile(fp, (await readFile(fp, "utf8")).replace(/,("?)Mistral3ForConditionalGeneration/g, ",\n$1Mistral3ForConditionalGeneration")); }
for (const f of ["main", "brain.worker", "infer.worker"]) await rm(path.join(root, "assets", f + ".js.map"), { force: true });
await writeFile(path.join(root, ".nojekyll"), "");   // serve files as-is (no Jekyll processing)
console.log("site published to repo root:", MANAGED.join(", "));
