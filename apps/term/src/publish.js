// GitHub publishing workflow for BarixTerm.
//  1 inspect  2 secrets  3 build system  4 validate  5 repo  6 remote  7 review  8 commit  9 push
//  10 verify remote  11 Pages  12 deployment errors
// Each step returns {name, status, detail}. Success is only ever claimed from verification evidence:
// the remote ref must equal the local HEAD; Pages must report a finished build; the live URL must answer.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeProject, detectSecrets, isSensitiveFilename } from "@barix/core";
import { Git } from "./git.js";
import { runProcess } from "./exec-tools.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|json|md|txt|html?|css|scss|py|go|rs|java|rb|php|sh|ya?ml|toml|ini|cfg|conf|env|properties|xml|sql|vue|svelte|ipynb)$|(^|\/)(\.env.*|Dockerfile|Makefile)$/i;

export class Publisher {
  /**
   * @param {{root:string, fs:any, intel:any, github?:any, git?:Git, confirm?:(q:string)=>Promise<boolean>, onStep?:Function, fetch?:typeof fetch,
   *   ledger?:any, sleepFn?:(ms:number)=>Promise<void>, pagesTimeoutMs?:number}} o
   */
  constructor({ root, fs, intel, github, git, confirm = async () => false, onStep = () => {}, fetch: f, ledger, sleepFn = sleep, pagesTimeoutMs = 300_000 }) {
    Object.assign(this, { root, fs, intel, github, confirm, onStep, ledger, sleepFn, pagesTimeoutMs }); this.git = git ?? new Git(root, { token: () => github?.token && (typeof github.token === "function" ? github.token() : github.token) });
    this._fetch = f ?? ((...a) => globalThis.fetch(...a)); this.steps = [];
  }
  #step(name, status, detail, extra = {}) { const s = { name, status, detail, ...extra }; this.steps.push(s); this.onStep(s); return s; }
  #fail(name, detail, extra) { this.#step(name, "fail", detail, extra); return this.#result(false); }
  #result(ok, extra = {}) { return { ok, steps: this.steps, ...this.out, ...extra }; }

  /**
   * @param {{repo:{owner?:string, name?:string, url?:string, create?:boolean, private?:boolean}, branch?:string, message?:string, pages?:{enable:boolean, mode?:"auto"|"branch"|"workflow", folder?:"/"|"/docs", expectText?:string},
   *   yes?:boolean, validate?:boolean, force?:boolean, allowSecrets?:string[], autoIgnoreSensitive?:boolean}} o
   */
  async publish({ repo, branch = "main", message, pages = { enable: false }, yes = false, validate = true, force = false, allowSecrets = [], autoIgnoreSensitive = true }) {
    this.out = { url: null, sha: null, verified: { push: false, pages: pages.enable ? false : null } };
    const { git, fs, intel } = this;
    // 1 ---- inspect
    const profile = await analyzeProject(fs); const files = fs.files();
    if (!files.length) return this.#fail("inspect", "the project is empty");
    this.#step("inspect", "ok", `${files.length} files · ${profile.summary}`);

    // 5 (early) ---- repo must exist so we can ask git which files would be committed
    const hadRepo = await git.isRepo();
    if (!hadRepo) { await git.init(branch); this.#step("repo", "ok", `initialized a new git repository on ${branch}`); }
    else { const cur = await git.currentBranch(); if (cur && cur !== branch && cur !== "HEAD") { this.#step("repo", "warn", `current branch is "${cur}"; publishing "${cur}" instead of "${branch}"`); branch = cur; } else this.#step("repo", "ok", "existing git repository"); }
    await this.#ensureGitignore(autoIgnoreSensitive);

    // 2 ---- secrets (only files git would actually commit)
    const candidates = (await git.run(["ls-files", "-co", "--exclude-standard"])).out.split("\n").filter(Boolean);
    const hits = [];
    for (const p of candidates) {
      if (isSensitiveFilename(p)) { hits.push({ path: p, type: "sensitive-filename", line: 0 }); continue; }
      if (!TEXT.test(p)) continue; const st = fs.statSync(p); if (!st || st.size > 2_000_000) continue;
      const text = await fs.readFile(p).catch(() => null); if (text) for (const s of detectSecrets(text)) hits.push({ path: p, type: s.type, line: s.line, preview: s.preview });
    }
    const blocked = hits.filter((h) => !allowSecrets.includes(`${h.path}:${h.type}`));
    if (blocked.length) return this.#fail("secrets", `possible secrets would be published:\n${blocked.slice(0, 12).map((h) => `  ${h.path}${h.line ? ":" + h.line : ""} — ${h.type}${h.preview ? " (" + h.preview + ")" : ""}`).join("\n")}\nRemove them, rotate any real credentials, or list them in --allow-secret after review.`, { hits: blocked });
    this.#step("secrets", "ok", `scanned ${candidates.length} files to be committed; none found`);

    // 3 ---- build system / Pages strategy
    const plan = await this.#pagesPlan(profile, pages);
    this.#step("build-system", "ok", `${profile.buildSystems.join(", ") || "none (static)"}${plan ? ` · Pages via ${plan.mode}${plan.dir ? ` from ${plan.dir}` : ""}` : ""}`);
    for (const w of plan?.warnings ?? []) this.#step("pages-readiness", "warn", w);

    // 4 ---- validate
    if (validate) {
      const checks = [["build", profile.commands.build], ["test", profile.commands.test], ["lint", profile.commands.lint]].filter(([, c]) => c);
      for (const [kind, cmd] of checks) {
        const r = await runProcess(cmd, { cwd: this.root, timeoutMs: 600_000 }); const ok = r.code === 0;
        this.ledger?.record({ tool: "publish", kind, ok, data: { command: cmd, exitCode: r.code, summary: r.out.trim().split("\n").slice(-1)[0]?.slice(0, 120) } });
        if (!ok && !force) return this.#fail("validate", `${kind} failed (\`${cmd}\`, exit ${r.code}):\n${r.out.trim().split("\n").slice(-15).join("\n")}`);
        this.#step("validate", ok ? "ok" : "warn", `${kind}: \`${cmd}\` ${ok ? "passed" : "FAILED (forced)"}`);
      }
      await fs.refresh(); await intel.sync(); const se = intel.symbols.syntaxErrors();
      if (se.length && !force) return this.#fail("validate", `syntax errors:\n${se.slice(0, 8).map((e) => `  ${e.path}:${e.line} ${e.message}`).join("\n")}`);
      if (!checks.length) this.#step("validate", "ok", "no build/test/lint commands detected; syntax check only");
    }
    if (plan?.mode === "workflow" && plan.writeWorkflow) { await fs.writeFile(".github/workflows/pages.yml", pagesWorkflow(plan)); this.#step("pages-workflow", "ok", "wrote .github/workflows/pages.yml (build + deploy to GitHub Pages)"); }

    // 6 ---- remote
    const gh = this.github; let owner = repo.owner, name = repo.name, url = repo.url;
    if (url) { const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url); if (m) { owner = m[1]; name = m[2]; } }
    if (!url && repo.create) {
      if (!gh?.authenticated) return this.#fail("remote", "creating a repository needs a GitHub token (set GITHUB_TOKEN, or run `gh auth login`)");
      if (!yes && !(await this.confirm(`Create ${repo.private ? "private" : "PUBLIC"} GitHub repository "${name}" under your account?`))) return this.#fail("remote", "repository creation declined");
      const created = await gh.get("/user/repos", { method: "POST", body: { name, private: !!repo.private, auto_init: false, description: profile.name ? `${profile.name} — published with Barix` : undefined }, noCache: true });
      owner = created.owner.login; url = created.clone_url; this.#step("remote", "ok", `created ${created.full_name} (${created.private ? "private" : "public"})`);
    } else if (url) { await git.setRemote(url); this.#step("remote", "ok", `origin → ${url.replace(/\/\/[^@/]+@/, "//")}`); }
    else { url = await git.remoteUrl(); if (!url) return this.#fail("remote", "no repository given and no `origin` remote configured"); const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url); if (m) { owner = m[1]; name = m[2]; } this.#step("remote", "ok", `using existing origin ${url}`); }
    if (!(await git.remoteUrl()) && url) await git.setRemote(url);

    // 7 ---- review
    await git.add(["-A"]); const st = await git.status(); const stat = await git.diff({ staged: true, stat: true });
    this.#step("review", "ok", st.staged.length ? `${st.staged.length} file(s) to commit:\n${stat}` : "no uncommitted changes");
    const hasHead = !!(await git.headSha());
    if (st.staged.length && !yes && !(await this.confirm(`Commit and push ${st.staged.length} file(s) to ${url ?? "origin"} (${branch})?`))) { await git.run(["reset", "-q"], { allowFail: true }); return this.#fail("review", "declined by user; nothing was committed or pushed"); }

    // 8 ---- commit
    if (st.staged.length) {
      const id = (await git.userIdentity()) ?? (gh?.authenticated ? await this.#ghIdentity() : null);
      if (!id) return this.#fail("commit", "git user.name / user.email are not configured; run `git config --global user.name \"…\"` and `user.email`");
      const sha = await git.commit(message ?? `Publish ${profile.name ?? "project"} with Barix`, id); this.out.sha = sha; this.#step("commit", "ok", `committed ${sha.slice(0, 8)}`);
    } else if (hasHead) { this.out.sha = await git.headSha(); this.#step("commit", "skipped", `nothing new to commit; HEAD is ${this.out.sha.slice(0, 8)}`); }
    else return this.#fail("commit", "nothing to commit");

    // 9 ---- push
    try { const r = await git.push({ branch }); this.#step("push", "ok", (r.err || r.out || "pushed").split("\n").slice(-2).join(" | ")); }
    catch (e) { return this.#fail("push", `${e.message}${/403|denied|auth|credential|could not read/i.test(e.message) ? "\nCheck that your token has write access (fine-grained: Contents read/write; classic: repo)." : ""}`); }

    // 10 ---- verify remote
    const remoteSha = await git.lsRemote("origin", `refs/heads/${branch}`);
    if (remoteSha !== this.out.sha) return this.#fail("verify-remote", `remote ref refs/heads/${branch} is ${remoteSha?.slice(0, 8) ?? "missing"} but local HEAD is ${this.out.sha.slice(0, 8)} — NOT verified`);
    this.out.verified.push = true; this.ledger?.record({ tool: "publish", kind: "remote-verified", ok: true, data: { sha: this.out.sha, branch, url } });
    this.#step("verify-remote", "ok", `origin/${branch} = ${remoteSha.slice(0, 8)} matches local HEAD`);
    this.out.url = owner && name ? `https://github.com/${owner}/${name}` : url;

    // 11/12 ---- Pages + deployment verification
    if (pages.enable) {
      if (!owner || !name) return this.#fail("pages", "Pages verification needs a github.com repository");
      const r = await this.#pages({ owner, name, branch, plan, pages }); if (!r.ok) return this.#result(false);
    }
    return this.#result(true);
  }

  async #ghIdentity() { try { const u = await this.github.get("/user"); return { name: u.name ?? u.login, email: u.email ?? `${u.id}+${u.login}@users.noreply.github.com` }; } catch { return null; } }
  async #ensureGitignore(autoIgnore) {
    const p = ".gitignore"; const cur = this.fs.exists(p) ? await this.fs.readFile(p) : ""; const want = [".barix/", "node_modules/"].filter((x) => !cur.split("\n").some((l) => l.trim() === x || l.trim() === x.slice(0, -1)));
    if (autoIgnore) for (const x of [".env", ".env.*", "*.pem", "*.key"]) if (!cur.split("\n").some((l) => l.trim() === x)) want.push(x);
    if (want.length) { await this.fs.writeFile(p, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + want.join("\n") + "\n"); this.#step("gitignore", "ok", `added to .gitignore: ${want.join(", ")}`); }
  }
  async #pagesPlan(profile, pages) {
    if (!pages.enable) return null; const fsx = this.fs; const warnings = [];
    let mode = pages.mode ?? "auto";
    if (mode === "auto") mode = profile.commands.build && (profile.frameworks.some((f) => ["Vite", "React", "Vue", "Svelte", "Astro", "webpack"].includes(f)) || profile.buildSystems.includes("vite")) ? "workflow" : "branch";
    const dir = mode === "workflow" ? (["dist", "build", "out", "public"].find((d) => fsx.exists(d)) ?? "dist") : pages.folder ?? (fsx.exists("docs/index.html") ? "/docs" : "/");
    if (mode === "branch" && !fsx.exists(dir === "/" ? "index.html" : `${dir.slice(1)}/index.html`)) warnings.push(`no index.html at ${dir} — Pages would serve a 404`);
    // subpath readiness: absolute asset URLs break on https://user.github.io/<repo>/
    const htmlFiles = fsx.files({ glob: dir === "/" || mode === "workflow" ? "*.html" : `${dir.slice(1)}/*.html` });
    for (const f of htmlFiles.slice(0, 5)) { const t = await fsx.readFile(f); const abs = [...t.matchAll(/(?:src|href)=["'](\/[^"'/][^"']*)["']/g)].map((m) => m[1]).filter((u) => !u.startsWith("//")); if (abs.length) warnings.push(`${f} uses root-absolute URLs (${abs.slice(0, 3).join(", ")}); on a project page they resolve to the wrong place — use relative URLs (./…)`); }
    for (const c of ["vite.config.js", "vite.config.ts", "vite.config.mjs"]) if (fsx.exists(c)) { const t = await fsx.readFile(c); if (!/base\s*:/.test(t)) warnings.push(`${c} has no \`base\`; set base: "./" (or "/<repo>/") so assets load under the repository subpath`); }
    return { mode, dir, warnings, writeWorkflow: mode === "workflow" && !fsx.exists(".github/workflows/pages.yml"), buildCmd: profile.commands.build, pm: profile.packageManager ?? "npm" };
  }
  async #pages({ owner, name, branch, plan, pages }) {
    const gh = this.github; if (!gh?.authenticated) { this.#step("pages", "fail", "enabling/inspecting Pages needs a GitHub token"); return { ok: false }; }
    try {
      let info = await gh.pagesInfo(owner, name).catch((e) => (e.code === "ENOTFOUND" ? null : Promise.reject(e)));
      if (!info) { await gh.get(`/repos/${owner}/${name}/pages`, { method: "POST", body: plan.mode === "workflow" ? { build_type: "workflow" } : { source: { branch, path: plan.dir } }, noCache: true }); this.#step("pages", "ok", `enabled Pages (${plan.mode}${plan.mode === "branch" ? `, ${branch}:${plan.dir}` : ""})`); info = await gh.pagesInfo(owner, name).catch(() => null); }
      else this.#step("pages", "ok", `Pages already enabled (${info.build_type ?? "legacy"})`);
      const liveUrl = info?.html_url ?? `https://${owner}.github.io/${name}/`;
      // poll for a finished build / deployment
      const t0 = Date.now(); let state = "pending", detail = "";
      while (Date.now() - t0 < this.pagesTimeoutMs) {
        if (plan.mode === "workflow") { const runs = await gh.workflowRuns(owner, name, 5); const run = (runs.workflow_runs ?? []).find((r) => r.head_sha === this.out.sha) ?? null; if (run) { if (run.status === "completed") { state = run.conclusion === "success" ? "built" : "errored"; detail = `workflow "${run.name}" ${run.conclusion} (${run.html_url})`; break; } detail = `workflow ${run.status}`; } }
        else { const b = await gh.pagesLatestBuild(owner, name).catch(() => null); if (b) { detail = `build ${b.status}${b.error?.message ? ": " + b.error.message : ""}`; if (b.status === "built") { state = "built"; break; } if (b.status === "errored") { state = "errored"; break; } } }
        await this.sleepFn(8000);
      }
      if (state !== "built") { this.#step("deployment", "fail", state === "errored" ? `Pages deployment FAILED — ${detail}` : `Pages did not finish within ${Math.round(this.pagesTimeoutMs / 1000)}s (${detail || "no build seen"}) — NOT verified`); return { ok: false }; }
      // fetch the live page (CDN may lag a few seconds)
      let res = null, body = ""; for (let i = 0; i < 6; i++) { try { res = await this._fetch(liveUrl, { headers: { "cache-control": "no-cache" } }); if (res.ok) { body = await res.text(); break; } } catch { /* retry */ } await this.sleepFn(5000); }
      if (!res?.ok) { this.#step("deployment", "fail", `${liveUrl} answered ${res?.status ?? "no response"} — NOT verified`); return { ok: false }; }
      if (pages.expectText && !body.includes(pages.expectText)) { this.#step("deployment", "fail", `${liveUrl} is up but does not contain the expected text "${pages.expectText}"`); return { ok: false }; }
      const missing = []; for (const m of [...body.matchAll(/(?:src|href)=["']([^"'#]+\.(?:js|css|mjs|png|svg|jpg|webp|wasm))["']/g)].slice(0, 6)) { try { const u = new URL(m[1], liveUrl).toString(); const r2 = await this._fetch(u); if (!r2.ok) missing.push(`${m[1]} → ${r2.status}`); } catch { missing.push(`${m[1]} → unreachable`); } }
      if (missing.length) { this.#step("deployment", "fail", `page loads but assets are broken (subpath problem?): ${missing.join(", ")}`); return { ok: false }; }
      this.out.verified.pages = true; this.out.pagesUrl = liveUrl; this.ledger?.record({ tool: "publish", kind: "pages-verified", ok: true, data: { url: liveUrl } });
      this.#step("deployment", "ok", `${liveUrl} is live (HTTP ${res.status}, ${detail})`); return { ok: true };
    } catch (e) { this.#step("pages", "fail", `${e.message}`); return { ok: false }; }
  }
}

export function pagesWorkflow({ buildCmd = "npm run build", dir = "dist", pm = "npm" }) {
  const install = pm === "pnpm" ? "corepack enable && pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install --frozen-lockfile" : "npm ci";
  return `name: Deploy to GitHub Pages
on:
  push:
    branches: [main, master]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: ${install}
      - run: ${buildCmd}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${dir}
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}
export { readFile, join };
