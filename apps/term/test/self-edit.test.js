import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { SelfEdit, isProtected } from "../src/self-edit.js";
import { Git } from "../src/git.js";

async function repo() {
  const d = await mkdtemp(join(tmpdir(), "selfedit-")); const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" }).toString();
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  await mkdir(join(d, "src")); await mkdir(join(d, "test")); await mkdir(join(d, "apps/term/src"), { recursive: true });
  await writeFile(join(d, "src/a.js"), "export const x = 1;\n"); await writeFile(join(d, "test/a.test.js"), "// test\n"); await writeFile(join(d, "apps/term/src/policy.js"), "// policy\n"); await writeFile(join(d, ".gitignore"), ".barix/\n");
  g("add", "-A"); g("commit", "-qm", "init"); return { d, g };
}
// fake clock: every sleep advances time; the tests "pass" unless src/a.js contains BREAK
function make(d, agent, extra = {}) {
  let t = Date.parse("2026-01-01T00:00:00Z"); const events = [];
  const se = new SelfEdit({ repoDir: d, git: new Git(d), agent, hours: 1, now: () => t, sleep: async (ms) => { t += ms; }, log: (s) => events.push(s), limits: { cooldownSeconds: 60 }, runTests: async () => { const s = await readFile(join(d, "src/a.js"), "utf8"); return s.includes("BREAK") ? { ok: false, output: "FAIL a.test.js: BREAK" } : { ok: true, output: "ok" }; }, goals: ["improve a"], ...extra });
  return { se, events, advance: (ms) => { t += ms; }, now: () => t };
}

test("isProtected covers safety code, CI, secrets and launchers", () => {
  for (const p of ["apps/term/src/self-edit.js", "apps/term/src/policy.js", ".github/workflows/ci.yml", ".env", "keys/server.pem", "BarixTerm.bat", "package-lock.json", "scripts/publish-site.mjs"]) assert.ok(isProtected(p), p);
  for (const p of ["packages/core/src/x.js", "README.md", "apps/web/src/main.js"]) assert.ok(!isProtected(p), p);
});

test("a passing change is committed on a barix/self-edit-* branch, never on main", async () => {
  const { d, g } = await repo(); let n = 0;
  const { se } = make(d, async () => { await writeFile(join(d, "src/a.js"), `export const x = ${++n + 1};\n`); return { answer: "bumped x" }; });
  const r = await se.run(); assert.equal(r.reason, "deadline"); assert.ok(r.commits >= 2, "ran many cycles within the hour");
  const br = g("rev-parse", "--abbrev-ref", "HEAD").trim(); assert.match(br, /^barix\/self-edit-/); assert.equal(g("rev-parse", "main").trim(), g("rev-list", "--max-parents=0", "HEAD").trim(), "main untouched");
  assert.match(g("log", "-1", "--pretty=%s"), /^self-edit: bumped x/);
});

test("a change that breaks the tests is rolled back and recorded as a lesson", async () => {
  const { d, g } = await repo(); const prompts = [];
  const { se } = make(d, async (p) => { prompts.push(p); await writeFile(join(d, "src/a.js"), "export const x = 'BREAK';\n"); return { answer: "oops" }; }, { hours: 0.05 });
  const r = await se.run(); assert.equal(r.commits, 0); assert.ok(r.failures >= 1);
  assert.equal(await readFile(join(d, "src/a.js"), "utf8"), "export const x = 1;\n", "file restored");
  assert.equal(g("status", "--porcelain").trim(), "", "working tree clean after rollback");
  assert.ok(prompts.length > 1 && /Lessons from earlier failed attempts[\s\S]*tests failed/.test(prompts.at(-1)), "failure fed back into the next prompt");
});

test("edits to protected files are reverted; other edits in the same cycle still count only if tests pass", async () => {
  const { d, g } = await repo(); let once = true;
  const { se } = make(d, async () => { if (once) { once = false; await writeFile(join(d, "apps/term/src/policy.js"), "// weakened\n"); await writeFile(join(d, "src/a.js"), "export const x = 2;\n"); } return { answer: "edit" }; }, { hours: 0.05 });
  const r = await se.run(); assert.ok(r.violations >= 1);
  assert.equal(await readFile(join(d, "apps/term/src/policy.js"), "utf8"), "// policy\n", "protected file restored");
  assert.equal(await readFile(join(d, "src/a.js"), "utf8"), "export const x = 2;\n"); assert.equal(r.commits, 1);
  assert.ok(!g("show", "--name-only", "--pretty=", "HEAD").includes("policy.js"));
});

test("deleting a test file or an oversized change is refused", async () => {
  const { d } = await repo(); let k = 0;
  const { se } = make(d, async () => { k++; if (k === 1) await rm(join(d, "test/a.test.js")); else await writeFile(join(d, "src/big.js"), "x\n".repeat(2000)); return { answer: "x" }; }, { hours: 0.5 });
  const r = await se.run(); assert.equal(r.commits, 0); assert.ok(r.lessons.some((l) => /deleted test files/.test(l)) && r.lessons.some((l) => /too large/.test(l)));
  assert.equal(await readFile(join(d, "test/a.test.js"), "utf8"), "// test\n");
});

test("the STOP file ends the run; state is persisted and the report written", async () => {
  const { d } = await repo(); let n = 0; let stopper;
  const { se } = make(d, async () => { await writeFile(join(d, "src/a.js"), `export const x = ${100 + ++n};\n`); if (n === 2) await writeFile(join(d, ".barix/self/STOP"), "x"); return { answer: "n" + n }; }, { hours: 24 });
  const r = await se.run(); assert.match(r.reason, /STOP file/); assert.equal(r.commits, 2);
  const state = JSON.parse(await readFile(join(d, ".barix/self/state.json"), "utf8")); assert.equal(state.commits, 2);
  assert.match(await readFile(join(d, ".barix/self/REPORT.md"), "utf8"), /commits kept: 2/);
});

test("refuses to start on a dirty tree, rejects hours beyond the cap, and never runs for more than the requested time", async () => {
  const { d } = await repo(); await writeFile(join(d, "src/a.js"), "dirty\n");
  await assert.rejects(make(d, async () => ({})).se.run(), /uncommitted changes/);
  assert.throws(() => make(d, async () => ({}), { hours: 1000 }), /hours must be/);
});

test("a commit that just passed the suite is not re-tested at the start of the next cycle", async () => {
  const { d } = await repo(); let n = 0, runs = 0;
  const { se } = make(d, async () => { await writeFile(join(d, "src/a.js"), `export const x = ${200 + ++n};\n`); return { answer: "n" }; }, { hours: 0.2, runTests: async () => { runs++; return { ok: true, output: "ok" }; } });
  const r = await se.run(); assert.ok(r.commits >= 2);
  assert.equal(runs, 1 + r.commits, "one baseline run total + one gate run per attempted change, not two per cycle");
});
