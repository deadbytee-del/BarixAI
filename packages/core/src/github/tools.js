// GitHub tools for the Barix tool protocol. ctx.github is a GitHubClient; accepts repo URLs or owner/repo.
import { parseGitHubUrl } from "./client.js";

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const P = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ok = (output, extra = {}) => ({ ok: true, output, ...extra });
const bad = (output) => ({ ok: false, output });
const repoRef = (s) => { const p = parseGitHubUrl(s); if (!p) throw new Error(`not a GitHub repository reference: ${s} (use https://github.com/owner/repo or owner/repo)`); return p; };
const short = (s, n = 140) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const REPO = S("repository URL or owner/repo");

export const githubTools = [
  {
    name: "github_repo", group: "github", requires: ["github"], description: "Overview of a GitHub repository: description, languages, branches, README start, recent commits.",
    parameters: P({ repo: REPO }, ["repo"]),
    async run({ repo }, { github }) {
      const { owner, repo: r } = repoRef(repo);
      const [info, langs, readme, commits, branches] = await Promise.all([github.repo(owner, r), github.languages(owner, r).catch(() => ({})), github.readme(owner, r).catch(() => null), github.commits(owner, r, { per: 5 }).catch(() => []), github.branches(owner, r, 10).catch(() => [])]);
      const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
      return ok([`${info.full_name} — ${info.description ?? "(no description)"}`, `★ ${info.stargazers_count} · forks ${info.forks_count} · open issues ${info.open_issues_count} · license ${info.license?.spdx_id ?? "none"} · default branch ${info.default_branch} · updated ${info.pushed_at}`,
        `Languages: ${Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${Math.round(v / total * 100)}%`).join(", ") || "n/a"}`, `Branches: ${branches.map((b) => b.name).join(", ")}`,
        `Recent commits:\n${commits.map((c) => `  ${c.sha.slice(0, 7)} ${short(c.commit.message.split("\n")[0], 90)} (${c.commit.author?.name})`).join("\n")}`, readme ? `README (start):\n${readme.text.slice(0, 1500)}` : "No README."].join("\n"));
    },
  },
  {
    name: "github_tree", group: "github", requires: ["github"], description: "List files of a repository at a ref, optionally under a path.",
    parameters: P({ repo: REPO, ref: S("branch, tag or sha (default: default branch)"), path: S("only entries under this path") }, ["repo"]),
    async run({ repo, ref, path = "" }, { github }) {
      const p = repoRef(repo); const t = await github.tree(p.owner, p.repo, ref ?? p.ref); const pre = path ? path.replace(/\/$/, "") + "/" : "";
      const es = t.entries.filter((e) => e.path.startsWith(pre)).slice(0, 400);
      return ok(`${p.owner}/${p.repo}@${t.ref}${t.truncated ? " (GitHub truncated this tree)" : ""}\n` + es.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.path}${e.size ? ` (${e.size}B)` : ""}`).join("\n"));
    },
  },
  {
    name: "github_read", group: "github", requires: ["github"], description: "Read one file from a GitHub repository at a ref.",
    parameters: P({ repo: REPO, path: S("file path in the repo"), ref: S("branch/tag/sha"), startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["repo", "path"]),
    async run({ repo, path, ref, startLine = 1, endLine }, { github }) {
      const p = repoRef(repo); const r = ref ?? p.ref ?? (await github.repo(p.owner, p.repo)).default_branch; const text = await github.rawFile(p.owner, p.repo, r, path);
      const L = text.split("\n"); const end = Math.min(endLine ?? startLine + 399, L.length);
      return ok(`${p.owner}/${p.repo}@${r}:${path} — lines ${startLine}-${end} of ${L.length}\n` + L.slice(startLine - 1, end).map((l, i) => `${String(startLine + i).padStart(5)}  ${l}`).join("\n"));
    },
  },
  {
    name: "github_commits", group: "github", requires: ["github"], description: "Recent commits (optionally for a path/ref), or one commit with its changed files.",
    parameters: P({ repo: REPO, ref: S("branch/tag"), path: S("only commits touching this path"), sha: S("show a single commit") }, ["repo"]),
    async run({ repo, ref, path, sha }, { github }) {
      const p = repoRef(repo);
      if (sha) { const c = await github.commit(p.owner, p.repo, sha); return ok(`${c.sha}\n${c.commit.message}\nby ${c.commit.author?.name} on ${c.commit.author?.date}\n${(c.files ?? []).slice(0, 40).map((f) => `${f.status[0].toUpperCase()} ${f.filename} (+${f.additions} -${f.deletions})`).join("\n")}`); }
      const cs = await github.commits(p.owner, p.repo, { ref: ref ?? p.ref, path, per: 20 }); return ok(cs.map((c) => `${c.sha.slice(0, 7)} ${c.commit.author?.date?.slice(0, 10)} ${short(c.commit.message.split("\n")[0], 100)} (${c.commit.author?.name})`).join("\n"));
    },
  },
  {
    name: "github_issues", group: "github", requires: ["github"], description: "List issues, or read one issue with its comments.",
    parameters: P({ repo: REPO, number: { type: "integer", minimum: 1 }, state: S("open|closed|all", { enum: ["open", "closed", "all"] }) }, ["repo"]),
    async run({ repo, number, state }, { github }) {
      const p = repoRef(repo); const n = number ?? p.number;
      if (n) { const i = await github.issue(p.owner, p.repo, n); return ok(`#${i.number} ${i.title} [${i.state}] by ${i.user?.login}\nlabels: ${(i.labels ?? []).map((l) => l.name).join(", ") || "none"}\n\n${short(i.body, 2500)}\n\nComments (${i.comments_data.length}):\n${i.comments_data.slice(0, 12).map((c) => `- ${c.user?.login}: ${short(c.body, 400)}`).join("\n")}`); }
      const is = await github.issues(p.owner, p.repo, { state: state ?? "open" }); return ok(is.map((i) => `#${i.number} [${i.state}] ${short(i.title, 100)} (${i.user?.login}, ${i.comments} comments)`).join("\n") || "no issues");
    },
  },
  {
    name: "github_pulls", group: "github", requires: ["github"], description: "List pull requests, or read one with its changed files.",
    parameters: P({ repo: REPO, number: { type: "integer", minimum: 1 }, state: S("open|closed|all", { enum: ["open", "closed", "all"] }) }, ["repo"]),
    async run({ repo, number, state }, { github }) {
      const p = repoRef(repo); const n = number ?? p.number;
      if (n) { const x = await github.pull(p.owner, p.repo, n); return ok(`PR #${x.number} ${x.title} [${x.state}${x.merged ? ", merged" : ""}] ${x.head?.ref} → ${x.base?.ref} by ${x.user?.login}\n+${x.additions} -${x.deletions} in ${x.changed_files} files\n\n${short(x.body, 2000)}\n\nFiles:\n${x.files_data.slice(0, 60).map((f) => `${f.status[0].toUpperCase()} ${f.filename} (+${f.additions} -${f.deletions})`).join("\n")}`); }
      const ps = await github.pulls(p.owner, p.repo, { state: state ?? "open" }); return ok(ps.map((x) => `#${x.number} [${x.state}] ${short(x.title, 100)} (${x.user?.login}) ${x.head?.ref}→${x.base?.ref}`).join("\n") || "no pull requests");
    },
  },
  {
    name: "github_releases", group: "github", requires: ["github"], description: "List recent releases with notes.", parameters: P({ repo: REPO }, ["repo"]),
    async run({ repo }, { github }) { const p = repoRef(repo); const rs = await github.releases(p.owner, p.repo, 6); return ok(rs.map((r) => `${r.tag_name} ${r.published_at?.slice(0, 10)} ${r.name ?? ""}${r.prerelease ? " (pre)" : ""}\n  ${short(r.body, 300)}`).join("\n") || "no releases"); },
  },
  {
    name: "github_search_code", group: "github", requires: ["github"], description: "Search code on GitHub (needs an authorized token). Use qualifiers like repo:owner/name.", parameters: P({ query: S("GitHub code search query") }, ["query"]),
    async run({ query }, { github }) { if (!github.authenticated) return bad("GitHub code search requires authorization. Ask the user to provide a token, or import the repo and use search_code."); const r = await github.searchCode(query); return ok(`${r.total_count} results\n` + r.items.map((i) => `${i.repository.full_name}:${i.path}`).join("\n")); },
  },
  {
    name: "github_import", group: "github", requires: ["github"], mutating: true, description: "Import a repository (or sub-path) into the project's virtual workspace under remote/owner/repo so search_code, find_symbol and read_file work on it.",
    parameters: P({ repo: REPO, ref: S("branch/tag/sha"), path: S("only import this sub-path"), maxFiles: { type: "integer", minimum: 10, maximum: 1500 } }, ["repo"]),
    timeoutMs: 600_000,
    async run({ repo, ref, path, maxFiles }, ctx) {
      const p = repoRef(repo); const r = await ctx.github.importRepo(ctx.fs, { owner: p.owner, repo: p.repo, ref: ref ?? p.ref, path: path ?? p.path, maxFiles });
      await ctx.intel?.sync();
      return ok(`Imported ${r.imported} files (${(r.bytes / 1024).toFixed(0)}KB) from ${p.owner}/${p.repo}@${r.ref} into ${r.prefix}/. Skipped ${r.skipped} (binary/vendor/large/over limit)${r.failed ? `, ${r.failed} failed` : ""}${r.truncatedTree ? ". GitHub truncated the tree; import a sub-path for the rest" : ""}. Now use search_code / find_symbol / read_file on ${r.prefix}/.`, { meta: { summary: `imported ${r.imported} files` } });
    },
  },
];
