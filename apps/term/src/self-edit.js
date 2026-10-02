// Self-edit mode: Barix works on its own source for a bounded time (default 24 hours) — unattended, but fenced in.
//
// What it does, cycle after cycle:  pick a task → let the agent edit a working copy of its own repo → REFUSE changes to
// protected files → run the repo's test suite → commit only if tests pass (otherwise roll back and remember why) →
// periodically push to a `barix/self-edit-*` branch and keep ONE draft pull request up to date.
//
// Hard rules (enforced here, in code the agent cannot change because it is itself protected):
//   • never works on or pushes to main/master — only a `barix/self-edit-*` branch
//   • never merges, never opens a non-draft PR, never force-pushes
//   • protected files (this file, the command policy, CI/deploy workflows, secrets, git internals) can't be changed;
//     such edits are reverted and logged
//   • a change is kept only if the test suite passes AND no test file was deleted AND the diff stays small
//   • a STOP file (.barix/self/STOP), Ctrl-C, or the deadline ends the run; state is persisted so it can be resumed
import { mkdir, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./exec-tools.js";

export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 168;
export const PROTECTED = [
  /^apps\/term\/src\/self-edit\.js$/, /^apps\/term\/src\/policy\.js$/, /^apps\/term\/test\/self-edit\.test\.js$/,
  /^\.github\//, /^\.git\//, /^\.gitignore$/, /(^|\/)\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519)/,
  /^BarixTerm\.(bat|sh)$/, /^package-lock\.json$/, /^LICENSE/, /^scripts\/publish-site\.mjs$/,
];
const LIMITS = { maxFiles: 20, maxChangedLines: 800, cycleMinutes: 25, testMinutes: 12, pushEveryCommits: 3, pushEveryMinutes: 45, maxBackoffMinutes: 30, cooldownSeconds: 20 };

// Rotating improvement areas used when there is no failing test, TODO or user goal to work on.
export const FOCUS_AREAS = [
  "Find a function in packages/core/src with weak or missing test coverage and add focused tests for it (fix any real bug the tests reveal).",
  "Improve an error message or edge-case handling in packages/core/src/tools so a model gets clearer, more actionable feedback. Add a test.",
  "Look for a performance hotspot in packages/core/src/retrieval or context and make it measurably faster without changing behavior; keep the benchmark meaning intact.",
  "Re-read docs/LIMITS.md and compare each claim with the code and tests. Correct anything that is out of date or overstated.",
  "Review apps/web/src for accessibility problems (labels, focus, contrast, keyboard use) and fix one concrete issue.",
  "Review apps/term/src for robustness on Windows (paths, quoting, line endings) and fix one concrete issue with a test.",
  "Find duplicated logic in packages/core/src and simplify it while keeping all tests green.",
  "Strengthen input validation for one tool in packages/core/src/tools/builtin.js (bad arguments must give a precise error, never a crash). Add a test.",
];

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
export const isProtected = (p) => PROTECTED.some((re) => re.test(p.replace(/\\/g, "/")));

export class SelfEdit {
  /**
   * @param {object} o
   * @param {string} o.repoDir  git working copy of Barix itself
   * @param {import('./git.js').Git} o.git
   * @param {(prompt:string, opts:{signal:AbortSignal})=>Promise<{answer?:string,text?:string,steps?:number}>} o.agent  runs ONE cycle's request
   * @param {{get:Function}|null} [o.github]  GitHubClient (for the draft PR); null → local commits only
   * @param {number} [o.hours]  how long to run (default 24)
   */
  constructor({ repoDir, git, agent, github = null, hours = DEFAULT_HOURS, goals = [], now = () => Date.now(), sleep = sleepReal, log = () => {}, runTests, limits = {}, resume = false, repoSlug = null, onEvent = null }) {
    if (!(hours > 0) || hours > MAX_HOURS) throw new Error(`hours must be between 0 and ${MAX_HOURS}`);
    Object.assign(this, { onEvent, repoDir, git, agent, github, hours, goals, now, sleep, log, resume, repoSlug, limits: { ...LIMITS, ...limits }, stopRequested: false });
    this.dir = path.join(repoDir, ".barix", "self"); this.stateFile = path.join(this.dir, "state.json"); this.stopFile = path.join(this.dir, "STOP");
    this.runTests = runTests ?? (() => defaultTests(repoDir, this.limits.testMinutes));
    this.state = null;
  }

  requestStop() { this.stopRequested = true; }
  async #stopFileExists() { try { await stat(this.stopFile); return true; } catch { return false; } }
  async #save() { await writeFile(this.stateFile, JSON.stringify(this.state, null, 1)); }
  async #event(type, data = {}) { const e = { t: iso(this.now()), type, ...data }; if (this.onEvent) this.onEvent(e); else this.log(`[self-edit] ${type}${data.msg ? ": " + data.msg : ""}`); await appendFile(path.join(this.dir, "log.jsonl"), JSON.stringify(e) + "\n").catch(() => {}); }

  async #prepare() {
    await mkdir(this.dir, { recursive: true });
    if (!(await this.git.isRepo())) throw new Error("self-edit needs a git checkout of the Barix repository (a folder with .git)");
    let prev = null; if (this.resume) { try { prev = JSON.parse(await readFile(this.stateFile, "utf8")); } catch { /* none */ } }
    const startedAt = prev?.startedAt ?? this.now();
    this.state = prev && prev.deadline > this.now() ? prev : { startedAt, deadline: startedAt + this.hours * 3600_000, cycle: 0, commits: 0, failures: 0, consecutiveFailures: 0, attempted: {}, lessons: [], branch: null, lastPush: 0, unpushed: 0, prUrl: null, violations: 0 };
    if (!prev || prev.deadline <= this.now()) { this.state.startedAt = this.now(); this.state.deadline = this.now() + this.hours * 3600_000; }
    // branch: never main/master
    const cur = await this.git.currentBranch();
    if (/^barix\/self-edit-/.test(cur)) this.state.branch = cur;
    else { const b = `barix/self-edit-${iso(this.now()).slice(0, 16).replace(/[-:T]/g, "")}`; await this.git.run(["checkout", "-b", b]); this.state.branch = b; }
    if (!(await this.#clean())) throw new Error("the working copy has uncommitted changes; commit or stash them before starting self-edit");
    await this.#save();
  }
  async #clean() { const st = await this.git.status(); return st.files.every((f) => f.path.startsWith(".barix/")); }
  async #rollback() { await this.git.run(["reset", "--hard", "HEAD"]); await this.git.run(["clean", "-fd", "-e", ".barix"]); }

  // ---------------------------------------------------------------- task selection
  async #pickTask(baseline) {
    const s = this.state; const tried = (id) => s.attempted[id] ?? 0;
    for (const [i, g] of this.goals.entries()) { const id = `goal:${i}`; if (tried(id) < 3) return { id, kind: "goal", text: g }; }
    if (!baseline.ok) return { id: "fix-tests", kind: "fix", text: `The test suite is failing on the current branch. Make it pass without weakening or deleting tests.\n\nTest output (tail):\n${baseline.output.slice(-3500)}` };
    const todos = await this.git.run(["grep", "-n", "-I", "-E", "(TODO|FIXME)\\b", "--", "packages", "apps/term/src", "apps/web/src", ":!*.min.*"], { allowFail: true });
    const lines = todos.out.split("\n").filter((l) => l && !/node_modules|\/dist\//.test(l));
    for (const l of lines) { const id = "todo:" + l.split(":").slice(0, 2).join(":"); if (tried(id) < 2) return { id, kind: "todo", text: `Resolve this TODO/FIXME if it is real and small, otherwise rewrite the comment so it is accurate:\n${l}` }; }
    for (let k = 0; k < FOCUS_AREAS.length; k++) { const idx = (s.cycle + k) % FOCUS_AREAS.length; const id = "focus:" + idx; if (tried(id) < 2) return { id, kind: "focus", text: FOCUS_AREAS[idx] }; }
    return null;
  }
  #prompt(task) {
    const lessons = this.state.lessons.slice(-6).map((l) => `- ${l}`).join("\n");
    return `You are Barix, working on your OWN source code in this repository (a normal git working copy). Make ONE small, correct, verifiable improvement.\n\nTask (${task.kind}): ${task.text}\n\nRules:\n- Read files before editing; make the smallest change that does the job. Keep the diff small (a few files).\n- Add or update tests for behavior you change. NEVER delete or weaken tests.\n- You may run the project's tests with run_tests / npm test. Do not run git commit or git push — the supervisor commits only if the whole suite passes.\n- Do not touch: .github/, package-lock.json, BarixTerm.bat/.sh, LICENSE, .gitignore, apps/term/src/self-edit.js, apps/term/src/policy.js, any secrets. Such edits are reverted automatically.\n- Do not invent results: say what you actually changed and what the tests showed.${lessons ? `\n\nLessons from earlier failed attempts (avoid repeating them):\n${lessons}` : ""}`;
  }

  // ---------------------------------------------------------------- one cycle
  async #cycle() {
    const s = this.state; s.cycle++; const t0 = this.now();
    // The suite already passed on this exact commit (we only ever commit after a green run, and rollbacks restore HEAD): don't pay for it twice.
    const head = await this.git.headSha(); const known = s.goodSha && s.goodSha === head;
    const baseline = known ? { ok: true, output: "" } : await this.runTests(); if (baseline.ok) s.goodSha = head;
    await this.#event("baseline", { ok: baseline.ok, msg: known ? "tests known green for this commit (skipped)" : baseline.ok ? "tests pass" : "tests FAIL" });
    const task = await this.#pickTask(baseline);
    if (!task) { await this.#event("idle", { msg: "no task available" }); return "idle"; }
    s.attempted[task.id] = (s.attempted[task.id] ?? 0) + 1; await this.#event("task", { id: task.id, msg: task.text.split("\n")[0].slice(0, 160) });
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), this.limits.cycleMinutes * 60_000); let res = null, agentErr = null;
    try { res = await this.agent(this.#prompt(task), { signal: ac.signal }); } catch (e) { agentErr = e; } finally { clearTimeout(timer); }
    // ---- fences
    const st = await this.git.status(); const changed = st.files.filter((f) => !f.path.startsWith(".barix/"));
    if (agentErr) { await this.#rollback(); return this.#fail(task, `agent error: ${agentErr.message}`); }
    if (!changed.length) return this.#fail(task, "the agent made no changes", { soft: true });
    const bad = changed.filter((f) => isProtected(f.path));
    if (bad.length) { s.violations += bad.length; await this.#event("violation", { files: bad.map((f) => f.path), msg: "protected files reverted" }); for (const f of bad) { if (f.x === "?" || f.y === "?") await rm(path.join(this.repoDir, f.path), { force: true, recursive: true }); else await this.git.run(["checkout", "HEAD", "--", f.path], { allowFail: true }); } }
    await this.git.add(["-A"]); const staged = (await this.git.status()).staged.filter((f) => !f.path.startsWith(".barix/"));
    if (!staged.length) { await this.#rollback(); return this.#fail(task, "only protected files were changed", { soft: true }); }
    const deleted = staged.filter((f) => f.x === "D" && /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(f.path));
    if (deleted.length) { await this.#rollback(); return this.#fail(task, `deleted test files: ${deleted.map((f) => f.path).join(", ")}`); }
    const num = (await this.git.run(["diff", "--cached", "--numstat"])).out.split("\n").filter(Boolean).map((l) => l.split("\t")); const lines = num.reduce((a, [x, y]) => a + (+x || 0) + (+y || 0), 0);
    if (staged.length > this.limits.maxFiles || lines > this.limits.maxChangedLines) { await this.#rollback(); return this.#fail(task, `change too large (${staged.length} files, ${lines} lines; limits ${this.limits.maxFiles}/${this.limits.maxChangedLines})`); }
    // ---- gate: the whole suite must pass on the staged tree
    const after = await this.runTests();
    if (!after.ok) { await this.#rollback(); return this.#fail(task, `tests failed after the change: ${after.output.slice(-400).replace(/\s+/g, " ")}`); }
    const summary = String(res?.answer ?? res?.text ?? task.text).replace(/\s+/g, " ").trim().slice(0, 140);
    await this.git.commit(`self-edit: ${summary}\n\nTask: ${task.id}\nFiles: ${staged.length}, changed lines: ${lines}\nTests: passed (full suite) before this commit.\n\nCo-Authored-By: Barix <barix@users.noreply.github.com>`, { name: "Barix", email: "barix@users.noreply.github.com" });
    s.goodSha = await this.git.headSha(); s.commits++; s.unpushed++; s.consecutiveFailures = 0; await this.#event("commit", { id: task.id, files: staged.length, lines, msg: summary, ms: this.now() - t0 });
    return "committed";
  }
  async #fail(task, reason, { soft = false } = {}) {
    const s = this.state; s.failures++; if (!soft) s.consecutiveFailures++; s.lessons.push(`${task.id}: ${reason}`.slice(0, 300)); if (s.lessons.length > 30) s.lessons.shift();
    await this.#event("fail", { id: task.id, msg: reason.slice(0, 300) }); return "failed";
  }

  // ---------------------------------------------------------------- publishing (branch + draft PR only)
  async #publish(force = false) {
    const s = this.state; if (!s.unpushed) return; const due = force || s.unpushed >= this.limits.pushEveryCommits || this.now() - s.lastPush >= this.limits.pushEveryMinutes * 60_000;
    if (!due) return;
    if (!/^barix\/self-edit-/.test(s.branch)) throw new Error("refusing to push: not on a barix/self-edit-* branch");
    try { await this.git.push({ branch: s.branch }); s.unpushed = 0; s.lastPush = this.now(); await this.#event("push", { msg: s.branch }); } catch (e) { return this.#event("push-failed", { msg: e.message.slice(0, 200) }); }
    if (!this.github?.authenticated || !this.repoSlug || s.prUrl) return;
    const [owner, repo] = this.repoSlug.split("/");
    try {
      const open = await this.github.pulls(owner, repo, { state: "open", per: 50 }); const mine = open.find((p) => p.head?.ref === s.branch);
      if (mine) s.prUrl = mine.html_url; else {
        const base = (await this.github.repo(owner, repo)).default_branch;
        const pr = await this.github.get(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: { title: `Barix self-edit (${s.branch})`, head: s.branch, base, draft: true, body: "Automated improvements made by Barix to its own code in self-edit mode. Every commit passed the full test suite before it was made. **Draft — a human must review before merging; Barix never merges.**" } });
        s.prUrl = pr.html_url;
      }
      await this.#event("pr", { msg: s.prUrl });
    } catch (e) { await this.#event("pr-failed", { msg: String(e.message).slice(0, 200) }); }
  }

  // ---------------------------------------------------------------- the loop
  async run() {
    await this.#prepare(); const s = this.state;
    await this.#event("start", { msg: `branch ${s.branch}; runs until ${iso(s.deadline)}` });
    let reason = "deadline";
    for (;;) {
      if (this.stopRequested) { reason = "stopped (signal)"; break; }
      if (await this.#stopFileExists()) { reason = "stopped (STOP file)"; break; }
      if (this.now() >= s.deadline) break;
      let r; try { r = await this.#cycle(); } catch (e) { await this.#rollback().catch(() => {}); await this.#event("error", { msg: String(e.message).slice(0, 300) }); s.consecutiveFailures++; r = "failed"; }
      await this.#publish(); await this.#save();
      const wait = r === "idle" ? 15 * 60_000 : r === "failed" ? Math.min(this.limits.maxBackoffMinutes * 60_000, this.limits.cooldownSeconds * 1000 * 2 ** Math.min(s.consecutiveFailures, 7)) : this.limits.cooldownSeconds * 1000;
      const until = Math.min(this.now() + wait, s.deadline); while (this.now() < until && !this.stopRequested && !(await this.#stopFileExists())) await this.sleep(Math.min(5000, until - this.now()));
    }
    await this.#publish(true).catch(() => {}); await this.#save();
    const report = `# Barix self-edit report\n\n- Ended: ${iso(this.now())} (${reason})\n- Branch: ${s.branch}\n- Cycles: ${s.cycle}, commits kept: ${s.commits}, failed/rolled back: ${s.failures}, protected-file violations blocked: ${s.violations}\n- Pull request (draft): ${s.prUrl ?? "none (no GitHub token, or no remote)"}\n\n## Recent lessons\n${s.lessons.slice(-10).map((l) => "- " + l).join("\n") || "- none"}\n`;
    await writeFile(path.join(this.dir, "REPORT.md"), report); await this.#event("end", { msg: reason });
    return { reason, ...s };
  }
}

async function defaultTests(cwd, minutes) {
  const r = await runProcess("npm test --silent", { cwd, timeoutMs: minutes * 60_000 });
  return { ok: r.code === 0, output: r.out };
}
