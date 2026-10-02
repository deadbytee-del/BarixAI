import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, parseGitHubUrl, githubTools } from "../src/github/index.js";
import { BarixFS, MemoryBackend } from "../src/fs/index.js";
import { ToolRegistry, ToolExecutor } from "../src/tools/index.js";
import { EvidenceLedger } from "../src/verify/index.js";
import { TokenCounter } from "../src/tokens/counter.js";

test("URL parsing covers repo, tree, blob, pull, issue, commit, releases and shorthand", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/vitejs/vite"), { owner: "vitejs", repo: "vite", type: "repo" });
  assert.deepEqual(parseGitHubUrl("github.com/a/b.git"), { owner: "a", repo: "b", type: "repo" });
  const blob = parseGitHubUrl("https://github.com/a/b/blob/main/src/x.js#L10"); assert.deepEqual([blob.type, blob.ref, blob.path], ["blob", "main", "src/x.js"]);
  assert.equal(parseGitHubUrl("https://github.com/a/b/pull/42").number, 42); assert.equal(parseGitHubUrl("https://github.com/a/b/issues/7").type, "issue");
  assert.equal(parseGitHubUrl("https://github.com/a/b/commit/abc123").sha, "abc123"); assert.equal(parseGitHubUrl("https://github.com/a/b/releases/tag/v1.0").tag, "v1.0");
  assert.deepEqual(parseGitHubUrl("facebook/react#123"), { owner: "facebook", repo: "react", type: "issue-or-pull", number: 123 });
  assert.equal(parseGitHubUrl("not a url"), null);
});

// A tiny faithful GitHub API double: ETags, rate-limit headers, trees, raw files.
function mockGitHub({ remaining = 59, truncated = false } = {}) {
  const calls = []; const files = { "README.md": "# Demo\nhello", "package.json": '{"name":"demo","main":"src/index.js"}', "src/index.js": "export const x = 1;\n", "src/util/math.js": "export const sq = (n) => n * n;\n", "logo.png": "binary", "node_modules/a/index.js": "x", "package-lock.json": "{}" };
  const hdr = (extra = {}) => new Headers({ "x-ratelimit-remaining": String(remaining), "x-ratelimit-limit": "60", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), ...extra });
  const json = (o, h) => new Response(JSON.stringify(o), { status: 200, headers: hdr({ etag: '"v1"', ...h }) });
  const fetch = async (url, init = {}) => {
    calls.push({ url, h: init.headers }); const u = new URL(url);
    if (u.host === "raw.githubusercontent.com") { const p = decodeURIComponent(u.pathname.split("/").slice(4).join("/")); return files[p] != null ? new Response(files[p]) : new Response("nf", { status: 404 }); }
    if (init.headers?.["if-none-match"] === '"v1"') return new Response(null, { status: 304, headers: hdr() });
    if (u.pathname === "/repos/o/r") return json({ full_name: "o/r", default_branch: "main", description: "Demo repo", stargazers_count: 5, forks_count: 1, open_issues_count: 2, pushed_at: "2026-01-01", license: { spdx_id: "MIT" } });
    if (u.pathname.startsWith("/repos/o/r/git/trees/")) return json({ sha: "treesha", truncated, tree: [...Object.entries(files).map(([path, c]) => ({ path, type: "blob", size: c.length })), { path: "src", type: "tree" }] });
    if (u.pathname === "/repos/o/missing") return new Response("{}", { status: 404, headers: hdr() });
    if (u.pathname === "/repos/o/r/languages") return json({ JavaScript: 900, HTML: 100 });
    if (u.pathname === "/repos/o/r/readme") return json({ encoding: "base64", content: Buffer.from(files["README.md"]).toString("base64") });
    if (u.pathname === "/repos/o/r/commits") return json([{ sha: "abcdef123456", commit: { message: "feat: add x\n\nbody", author: { name: "Ann", date: "2026-01-01T00:00:00Z" } } }]);
    if (u.pathname === "/repos/o/r/branches") return json([{ name: "main" }, { name: "dev" }]);
    return new Response("{}", { status: 404, headers: hdr() });
  };
  return { fetch, calls };
}

test("client: ETag conditional requests, rate-limit tracking, honest errors", async () => {
  const m = mockGitHub(); const gh = new GitHubClient({ fetch: m.fetch });
  const a = await gh.repo("o", "r"); const b = await gh.repo("o", "r");
  assert.deepEqual(a, b); assert.equal(gh.stats.cached, 1); assert.equal(m.calls.at(-1).h["if-none-match"], '"v1"'); assert.equal(gh.limit.remaining, 59); assert.ok(!("authorization" in m.calls[0].h), "no token => no auth header");
  await assert.rejects(gh.repo("o", "missing"), (e) => e.code === "ENOTFOUND" && /private repository/.test(e.message));
  const authed = new GitHubClient({ fetch: m.fetch, token: () => "tok_runtime" }); await authed.repo("o", "r"); assert.equal(m.calls.at(-1).h.authorization, "Bearer tok_runtime");
  const dep = new GitHubClient({ fetch: mockGitHub({ remaining: 0 }).fetch }); await dep.repo("o", "r");
  await assert.rejects(dep.repo("o", "r"), (e) => e.code === "ERATELIMIT" && e.retryAfter > 0); 
});

test("importRepo: prioritizes sources, skips binaries/vendor/lockfiles, uses raw (no API quota), reports truncation", async () => {
  const m = mockGitHub({ truncated: true }); const gh = new GitHubClient({ fetch: m.fetch }); const fs = await new BarixFS(new MemoryBackend()).init();
  const r = await gh.importRepo(fs, { owner: "o", repo: "r" });
  assert.deepEqual(fs.files().sort(), ["remote/o/r/README.md", "remote/o/r/package.json", "remote/o/r/src/index.js", "remote/o/r/src/util/math.js"]);
  assert.equal(r.imported, 4); assert.equal(r.truncatedTree, true); assert.ok(gh.stats.raw === 4);
  assert.equal(await fs.readFile("remote/o/r/src/util/math.js"), "export const sq = (n) => n * n;\n");
});

test("github tools run through the Barix executor with capability gating", async () => {
  const m = mockGitHub(); const fs = await new BarixFS(new MemoryBackend()).init(); const counter = new TokenCounter(); const ledger = new EvidenceLedger({ fs });
  const registry = new ToolRegistry().registerAll(githubTools); const gh = new GitHubClient({ fetch: m.fetch });
  const exec = new ToolExecutor({ registry, ledger, counter, ctx: { fs, github: gh, capabilities: { github: true }, readSet: new Map() } });
  let r = await exec.run({ id: "1", tool: "github_repo", args: { repo: "https://github.com/o/r" } });
  assert.equal(r.ok, true); assert.match(r.output, /o\/r — Demo repo/); assert.match(r.output, /JavaScript 90%/); assert.match(r.output, /abcdef1 feat: add x \(Ann\)/);
  r = await exec.run({ id: "2", tool: "github_read", args: { repo: "o/r", path: "src/index.js" } }); assert.match(r.output, /o\/r@main:src\/index.js.*\n\s+1  export const x = 1;/s);
  r = await exec.run({ id: "3", tool: "github_repo", args: { repo: "not a repo" } }); assert.equal(r.ok, false); assert.match(r.output, /not a GitHub repository reference/);
  r = await exec.run({ id: "4", tool: "github_import", args: { repo: "o/r" } }); assert.equal(r.ok, true); assert.match(r.output, /Imported 4 files/);
  const noCap = new ToolExecutor({ registry, ledger, counter, ctx: { fs, capabilities: {}, readSet: new Map() } }); assert.match((await noCap.run({ id: "5", tool: "github_repo", args: { repo: "o/r" } })).output, /unavailable here/);
  assert.match((await exec.run({ id: "6", tool: "github_search_code", args: { query: "x" } })).output, /requires authorization/);
});
