// GitHub integration: REST client + repo importer.
// - No credentials in code. A token (fine-grained PAT / OAuth token / `gh auth token`) is supplied at runtime
//   by the user and only sent to api.github.com / uploads, never logged or persisted by Barix.
// - Conditional requests (ETag) so repeated reads are free; rate-limit headers are tracked and a
//   depleted limit raises ERATELIMIT with the exact reset time (Barix waits; it does not retry-spam).
// - File bodies are fetched from raw.githubusercontent.com (not counted against API quota) for public repos.
import { BarixError } from "../util/misc.js";
import { LRU } from "../util/lru.js";

export function parseGitHubUrl(input) {
  const s = String(input).trim().replace(/[?#].*$/, (m) => (/^#\d+$/.test(m) ? m : ""));
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob|pull|pulls|issues|commit|commits|releases|actions|wiki)(?:\/(.*))?)?(?:[?#].*)?$/i.exec(s);
  if (m) {
    const [, owner, repo, kind, rest = ""] = m; const out = { owner, repo, type: "repo" };
    if (kind === "tree" || kind === "blob") { const parts = rest.split("/"); out.type = kind; out.ref = parts[0]; out.path = parts.slice(1).join("/"); out.refAndPath = rest; }
    else if (kind === "pull") { out.type = "pull"; out.number = +rest.split("/")[0]; }
    else if (kind === "issues") { out.type = rest ? "issue" : "issues"; if (rest) out.number = +rest.split("/")[0]; }
    else if (kind === "commit") { out.type = "commit"; out.sha = rest.split("/")[0]; }
    else if (kind === "commits") { out.type = "commits"; out.ref = rest.split("/")[0] || undefined; }
    else if (kind === "releases") { out.type = "releases"; if (rest.startsWith("tag/")) out.tag = rest.slice(4); }
    else if (kind) out.type = kind;
    return out;
  }
  m = /^([\w.-]+)\/([\w.-]+)(?:#(\d+))?$/.exec(s); if (m) return { owner: m[1], repo: m[2], type: m[3] ? "issue-or-pull" : "repo", ...(m[3] ? { number: +m[3] } : {}) };
  return null;
}

const TEXT_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|json|jsonc|md|mdx|txt|rst|html?|css|scss|less|py|pyi|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|ya?ml|toml|ini|cfg|conf|sql|vue|svelte|astro|swift|dart|lua|r|ex|exs|erl|hs|ml|scala|gradle|xml|env\.example|gitignore|editorconfig|dockerfile|makefile|cmake)$/i;
const NAMED = /(^|\/)(README|LICENSE|CHANGELOG|CONTRIBUTING|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|CMakeLists\.txt|go\.mod|Cargo\.toml|package\.json|tsconfig\.json|pyproject\.toml|requirements\.txt)(\.\w+)?$/i;
const NOISE = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|__pycache__|\.next|coverage|\.venv|\.idea|\.vscode)\//;
const LOCK = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|\.min\.(js|css)|\.map)$/i;

export class GitHubClient {
  /** @param {{token?:string|(()=>string|undefined), fetch?:typeof fetch, apiBase?:string, rawBase?:string, cache?:LRU, userAgent?:string}} o */
  constructor({ token, fetch: f, apiBase = "https://api.github.com", rawBase = "https://raw.githubusercontent.com", cache = new LRU(500), userAgent = "Barix" } = {}) {
    this.token = token; this._fetch = f ?? ((...a) => globalThis.fetch(...a)); this.apiBase = apiBase; this.rawBase = rawBase; this.cache = cache;
    this.limit = { remaining: null, reset: null, limit: null }; this.stats = { requests: 0, cached: 0, raw: 0 }; this.userAgent = userAgent;
  }
  #token() { return typeof this.token === "function" ? this.token() : this.token; }
  get authenticated() { return !!this.#token(); }
  async #req(path, { method = "GET", body, accept = "application/vnd.github+json", base = this.apiBase, noCache = false } = {}) {
    if (this.limit.remaining === 0 && this.limit.reset && this.limit.reset * 1000 > Date.now()) throw new BarixError("ERATELIMIT", `GitHub API rate limit exhausted; resets at ${new Date(this.limit.reset * 1000).toISOString()}`, { retryAfter: Math.ceil(this.limit.reset - Date.now() / 1000) });
    const url = path.startsWith("http") ? path : base + path; const tok = this.#token();
    const headers = { accept, "x-github-api-version": "2022-11-28", ...(tok && (url.startsWith(this.apiBase) || (this.apiBase !== "https://api.github.com" && url.startsWith(this.rawBase))) ? { authorization: `Bearer ${tok}` } : {}) };
    const cached = method === "GET" && !noCache ? this.cache.get(url + "|" + (tok ? "a" : "n")) : null; if (cached?.etag) headers["if-none-match"] = cached.etag;
    this.stats.requests++; let res;
    try { res = await this._fetch(url, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch (e) { throw new BarixError("ENETWORK", `GitHub request failed: ${e.message}`); }
    const rem = res.headers.get("x-ratelimit-remaining"); if (rem !== null) this.limit = { remaining: +rem, reset: +res.headers.get("x-ratelimit-reset"), limit: +res.headers.get("x-ratelimit-limit") };
    if (res.status === 304 && cached) { this.stats.cached++; return cached.data; }
    if (res.status === 403 || res.status === 429) {
      const ra = res.headers.get("retry-after"); const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
      if (ra || exhausted) throw new BarixError("ERATELIMIT", `GitHub rate limit (${res.status})`, { status: res.status, retryAfter: ra ?? Math.max(1, +res.headers.get("x-ratelimit-reset") - Math.floor(Date.now() / 1000)) });
    }
    if (res.status === 404) throw new BarixError("ENOTFOUND", `GitHub: not found (${path}). ${tok ? "Check the name and your token's access." : "If this is a private repository, authorize Barix with a token."}`, { status: 404 });
    if (res.status === 401) throw new BarixError("EAUTH", "GitHub rejected the token (401). It may be expired or revoked.", { status: 401 });
    if (!res.ok) throw new BarixError("EGITHUB", `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`, { status: res.status });
    const data = res.status === 204 ? null : accept.includes("json") ? await res.json() : await res.text();
    const etag = res.headers.get("etag"); if (method === "GET" && etag && !noCache) this.cache.set(url + "|" + (tok ? "a" : "n"), { etag, data });
    return data;
  }
  get = (p, o) => this.#req(p, o);
  repo = (o, r) => this.#req(`/repos/${o}/${r}`);
  branches = (o, r, per = 30) => this.#req(`/repos/${o}/${r}/branches?per_page=${per}`);
  languages = (o, r) => this.#req(`/repos/${o}/${r}/languages`);
  readme = (o, r, ref) => this.#req(`/repos/${o}/${r}/readme${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`).then((j) => ({ ...j, text: j.encoding === "base64" ? b64(j.content) : j.content }));
  commits = (o, r, { ref, path, per = 20 } = {}) => this.#req(`/repos/${o}/${r}/commits?per_page=${per}${ref ? `&sha=${encodeURIComponent(ref)}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`);
  commit = (o, r, sha) => this.#req(`/repos/${o}/${r}/commits/${sha}`);
  compare = (o, r, a, b) => this.#req(`/repos/${o}/${r}/compare/${a}...${b}`);
  issues = (o, r, { state = "open", per = 20 } = {}) => this.#req(`/repos/${o}/${r}/issues?state=${state}&per_page=${per}`).then((a) => a.filter((i) => !i.pull_request));
  issue = async (o, r, n) => ({ ...(await this.#req(`/repos/${o}/${r}/issues/${n}`)), comments_data: await this.#req(`/repos/${o}/${r}/issues/${n}/comments?per_page=30`) });
  pulls = (o, r, { state = "open", per = 20 } = {}) => this.#req(`/repos/${o}/${r}/pulls?state=${state}&per_page=${per}`);
  pull = async (o, r, n) => ({ ...(await this.#req(`/repos/${o}/${r}/pulls/${n}`)), files_data: await this.#req(`/repos/${o}/${r}/pulls/${n}/files?per_page=100`) });
  releases = (o, r, per = 10) => this.#req(`/repos/${o}/${r}/releases?per_page=${per}`);
  latestRelease = (o, r) => this.#req(`/repos/${o}/${r}/releases/latest`);
  searchCode = (q, per = 15) => this.#req(`/search/code?q=${encodeURIComponent(q)}&per_page=${per}`); // requires auth
  pagesInfo = (o, r) => this.#req(`/repos/${o}/${r}/pages`, { noCache: true });
  pagesLatestBuild = (o, r) => this.#req(`/repos/${o}/${r}/pages/builds/latest`, { noCache: true });
  workflowRuns = (o, r, per = 5) => this.#req(`/repos/${o}/${r}/actions/runs?per_page=${per}`, { noCache: true });
  rateLimit = () => this.#req("/rate_limit", { noCache: true });
  /** Resolve the default branch + recursive tree. `truncated` is surfaced, never hidden. */
  async tree(o, r, ref) {
    const refName = ref ?? (await this.repo(o, r)).default_branch;
    const t = await this.#req(`/repos/${o}/${r}/git/trees/${encodeURIComponent(refName)}?recursive=1`);
    return { ref: refName, sha: t.sha, truncated: !!t.truncated, entries: t.tree.map((e) => ({ path: e.path, type: e.type === "tree" ? "dir" : "file", size: e.size, sha: e.sha })) };
  }
  /** Raw file text (public repos; not API-rate-limited). Falls back to the contents API when authenticated. */
  async rawFile(o, r, ref, path) {
    const tok = this.#token();
    if (!tok) { this.stats.raw++; this.stats.requests++; const res = await this._fetch(`${this.rawBase}/${o}/${r}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`); if (res.status === 404) throw new BarixError("ENOTFOUND", `no such file ${path} @ ${ref}`); if (!res.ok) throw new BarixError("EGITHUB", `raw fetch ${res.status}`); return res.text(); }
    const j = await this.#req(`/repos/${o}/${r}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(j)) throw new BarixError("EISDIR", `${path} is a directory`);
    return j.encoding === "base64" ? b64(j.content) : j.content;
  }

  /**
   * Import a repository (or a sub-path) into a BarixFS under `prefix` so Barix's code intelligence can index it.
   * Prioritizes manifests/README/entry points, skips binaries/lockfiles/vendor, bounds size, reports what it skipped.
   */
  async importRepo(fs, { owner, repo, ref, path = "", prefix, maxFiles = 400, maxFileBytes = 200_000, maxTotalBytes = 8_000_000, concurrency = 6, onProgress } = {}) {
    const t = await this.tree(owner, repo, ref); prefix ??= `remote/${owner}/${repo}`;
    const under = path ? t.entries.filter((e) => e.path.startsWith(path.replace(/\/$/, "") + "/") || e.path === path) : t.entries;
    const files = under.filter((e) => e.type === "file" && !NOISE.test(e.path) && !LOCK.test(e.path) && (TEXT_EXT.test(e.path) || NAMED.test(e.path)) && (e.size ?? 0) <= maxFileBytes);
    const prio = (p) => (NAMED.test(p) ? 0 : /^(src|lib|app|packages|cmd|pkg)\//.test(p) ? 1 : /^(docs?|examples?)\//.test(p) ? 3 : /(^|\/)(test|tests|__tests__|spec)\//.test(p) ? 4 : 2) * 100 + p.split("/").length;
    files.sort((a, b) => prio(a.path) - prio(b.path)); let bytes = 0; const pick = [];
    for (const f of files) { if (pick.length >= maxFiles || bytes + (f.size ?? 0) > maxTotalBytes) break; pick.push(f); bytes += f.size ?? 0; }
    let done = 0, failed = 0; const queue = [...pick];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) { const f = queue.shift(); try { const text = await this.rawFile(owner, repo, t.ref, f.path); await fs.writeFile(`${prefix}/${f.path}`, text); done++; } catch (e) { if (e.code === "ERATELIMIT") throw e; failed++; } onProgress?.({ done, total: pick.length }); }
    }));
    return { ref: t.ref, sha: t.sha, prefix, imported: done, failed, skipped: under.filter((e) => e.type === "file").length - pick.length, truncatedTree: t.truncated, bytes };
  }
}
const b64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
