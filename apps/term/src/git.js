// Git wrapper over the system `git` (execFile with argument arrays — no shell, no injection).
// Authentication: a token, if any, is passed to ONE command through GIT_CONFIG_* env vars as an HTTP
// extraheader. It is never written to .git/config, never placed in a URL or argv, never logged.
import { execFile } from "node:child_process";
import { scrubEnv } from "./policy.js";

export class Git {
  constructor(cwd, { token } = {}) { this.cwd = cwd; this.token = token; }
  run(args, { auth = false, input, timeoutMs = 120_000, allowFail = false } = {}) {
    const env = { ...scrubEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LC_ALL: "C" };
    const tok = typeof this.token === "function" ? this.token() : this.token;
    if (auth && tok) { const b = Buffer.from(`x-access-token:${tok}`).toString("base64"); Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b}` }); }
    return new Promise((resolve, reject) => {
      const p = execFile("git", args, { cwd: this.cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : err.killed ? 124 : 1) : 0;
        if (err && err.code === "ENOENT") return reject(new Error("git is not installed or not on PATH. Install Git (https://git-scm.com) and retry."));
        const res = { code, out: String(stdout).trimEnd(), err: redact(String(stderr).trimEnd(), tok) };
        if (code !== 0 && !allowFail) { const e = new Error(`git ${args[0]} failed (${code}): ${res.err || res.out}`.slice(0, 600)); e.result = res; return reject(e); }
        resolve(res);
      });
      if (input) { p.stdin.end(input); }
    });
  }
  async isRepo() { return (await this.run(["rev-parse", "--is-inside-work-tree"], { allowFail: true })).out === "true"; }
  async toplevel() { return (await this.run(["rev-parse", "--show-toplevel"], { allowFail: true })).out; }
  init(branch = "main") { return this.run(["init", "-b", branch]); }
  async currentBranch() { return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })).out; }
  async headSha() { const r = await this.run(["rev-parse", "HEAD"], { allowFail: true }); return r.code === 0 ? r.out : null; }
  async status() {
    const r = await this.run(["status", "--porcelain=v1", "-b", "-uall"]); const lines = r.out.split("\n").filter(Boolean); const branch = lines.shift()?.replace(/^## /, "") ?? "";
    const files = lines.map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^"|"$/g, "") }));
    return { branch, files, clean: files.length === 0, staged: files.filter((f) => f.x !== " " && f.x !== "?"), unstaged: files.filter((f) => f.y !== " " && f.x !== "?"), untracked: files.filter((f) => f.x === "?") };
  }
  diff({ staged = false, stat = false, path } = {}) { return this.run(["diff", ...(staged ? ["--cached"] : []), ...(stat ? ["--stat"] : []), ...(path ? ["--", path] : [])]).then((r) => r.out); }
  log(n = 10) { return this.run(["log", `-${n}`, "--pretty=format:%h %ad %an %s", "--date=short"], { allowFail: true }).then((r) => r.out); }
  add(paths = ["-A"]) { return this.run(["add", ...paths]); }
  async commit(message, { name, email } = {}) {
    const pre = []; if (name) pre.push("-c", `user.name=${name}`); if (email) pre.push("-c", `user.email=${email}`);
    await this.run([...pre, "commit", "-m", message]); return this.headSha();
  }
  async remoteUrl(name = "origin") { const r = await this.run(["remote", "get-url", name], { allowFail: true }); return r.code === 0 ? r.out : null; }
  async setRemote(url, name = "origin") { return (await this.remoteUrl(name)) ? this.run(["remote", "set-url", name, url]) : this.run(["remote", "add", name, url]); }
  push({ remote = "origin", branch, setUpstream = true } = {}) { return this.run(["push", ...(setUpstream ? ["-u"] : []), remote, branch ? `${branch}:${branch}` : "HEAD"], { auth: true, timeoutMs: 300_000 }); }
  async lsRemote(remote = "origin", ref = "HEAD") { const r = await this.run(["ls-remote", remote, ref], { auth: true, allowFail: true }); const first = r.out.split("\n")[0]?.split("\t")[0]; return r.code === 0 && first ? first : null; }
  async userIdentity() { const n = await this.run(["config", "user.name"], { allowFail: true }), e = await this.run(["config", "user.email"], { allowFail: true }); return n.out && e.out ? { name: n.out, email: e.out } : null; }
}
const redact = (s, tok) => (tok ? s.split(tok).join("[token]") : s).replace(/(authorization:\s*basic\s+)\S+/gi, "$1[redacted]");

const P = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const gitTools = [
  { name: "git_status", group: "git", requires: ["git"], tier: 1, description: "Show branch and changed/untracked files.", parameters: P({}), async run(_, ctx) { const g = new Git(ctx.root); if (!(await g.isRepo())) return { ok: true, output: "Not a git repository (use publish or run git init)." }; const s = await g.status(); return { ok: true, output: `branch ${s.branch}\n${s.clean ? "working tree clean" : s.files.map((f) => `${f.x}${f.y} ${f.path}`).join("\n")}` }; } },
  { name: "git_diff", group: "git", requires: ["git"], tier: 1, description: "Show uncommitted changes (optionally staged, or one path).", parameters: P({ staged: { type: "boolean" }, path: { type: "string", description: "limit to path" } }), async run(a, ctx) { const d = await new Git(ctx.root).diff(a); return { ok: true, output: d || "no changes" }; } },
  { name: "git_log", group: "git", requires: ["git"], tier: 1, description: "Recent commits.", parameters: P({ count: { type: "integer", minimum: 1, maximum: 50 } }), async run({ count = 10 }, ctx) { return { ok: true, output: (await new Git(ctx.root).log(count)) || "no commits" }; } },
  {
    name: "git_commit", group: "git", requires: ["git"], mutating: true, tier: 1, description: "Stage all changes (or given paths) and commit. Secrets in the staged changes block the commit.",
    parameters: P({ message: { type: "string", minLength: 3 }, paths: { type: "array", items: { type: "string" } } }, ["message"]),
    async run({ message, paths }, ctx) {
      const g = new Git(ctx.root); if (!(await g.isRepo())) await g.init();
      await g.add(paths?.length ? paths : ["-A"]); const st = await g.status(); if (!st.staged.length) return { ok: false, output: "nothing to commit" };
      const { detectSecrets, isSensitiveFilename } = await import("@barix/core");
      const hits = []; for (const f of st.staged) { if (isSensitiveFilename(f.path)) hits.push(`${f.path}: sensitive filename`); else { const t = await ctx.fs.readFile(f.path).catch(() => null); if (t) for (const s of detectSecrets(t)) hits.push(`${f.path}:${s.line} ${s.type}`); } }
      if (hits.length) { await g.run(["reset", "-q"], { allowFail: true }); return { ok: false, output: `Commit blocked: possible secrets in staged files:\n${hits.slice(0, 10).join("\n")}\nRemove them (or add the file to .gitignore) and retry.`, evidence: { kind: "git-blocked", data: { hits } } }; }
      const id = ctx.identity ?? (await g.userIdentity()) ?? { name: "Barix", email: "barix@users.noreply.github.com" };
      const sha = await g.commit(message, id); return { ok: true, output: `Committed ${sha.slice(0, 8)} on ${await g.currentBranch()}: ${message}\n${st.staged.length} file(s)`, evidence: { kind: "git-commit", data: { sha, message, files: st.staged.length } } };
    },
  },
];
