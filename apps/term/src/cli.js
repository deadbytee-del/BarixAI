// BarixTerm command line. Same Barix as the browser (createBarix) — different backend (your disk),
// plus capabilities browsers cannot safely have: commands, git, builds, tests, local models.
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import { createBarix, NodeBackend, nodeTreeSitter, GitHubClient, githubTools, parseGitHubUrl, OUTPUT_TARGETS } from "@barix/core";
import { execTools } from "./exec-tools.js";
import { gitTools, Git } from "./git.js";
import { Publisher } from "./publish.js";
import { setupProviders, githubToken, systemInfo, detectLocalServers } from "./providers-setup.js";

const C = process.stdout.isTTY && !process.env.NO_COLOR ? { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", off: "\x1b[0m" } : { dim: "", bold: "", cyan: "", green: "", red: "", yellow: "", off: "" };
export const VERSION = "0.1.0";

const HELP = `${C.bold}BarixTerm${C.off} ${VERSION} — the local Barix agent

Usage
  barixterm [project-dir]                    interactive session in a project (default: current directory)
  barixterm -p "prompt" [project-dir]        one-shot: run a single request and exit
  barixterm publish [project-dir] --repo owner/name [--create] [--private] [--pages] [--yes]
  barixterm doctor                           check Node, git, RAM, local model servers, GitHub auth
  barixterm worker [--port 8787]             share this machine's model as an opt-in Barix worker

Options
  --endpoint URL --endpoint-model ID --window N    use an OpenAI-compatible server (llama.cpp, Ollama, LM Studio, vLLM)
  --model HF_ID --dtype q4|q4f16|fp16              use a specific built-in ONNX model (Transformers.js)
  --yes                                            auto-approve command/commit prompts (use with care)
  --no-exec                                        disable command execution (read/edit only)

In a session: /help /status /providers /memory /forget ID /compact /undo /tools /clear /exit
GitHub token: set GITHUB_TOKEN (or sign in with \`gh auth login\`). It is never stored by Barix.
`;

export function parseArgs(argv) {
  const o = { _: [], flags: {} }; const takes = new Set(["-p", "--print", "--repo", "--endpoint", "--endpoint-model", "--window", "--model", "--dtype", "--port", "--message", "--branch", "--allow-secret", "--expect"]);
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("-")) { const [k, v] = a.includes("=") ? a.split(/=(.*)/s) : [a, null]; if (takes.has(k)) o.flags[k.replace(/^-+/, "")] = v ?? argv[++i]; else o.flags[k.replace(/^-+/, "")] = true; } else o._.push(a); }
  return o;
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout } = {}) {
  const args = parseArgs(argv); const f = args.flags; const out = (s = "") => stdout.write(s + "\n");
  if (f.help || f.h) return out(HELP); if (f.version || f.v) return out(VERSION);
  const cmd = ["doctor", "publish", "worker"].includes(args._[0]) ? args._.shift() : null;
  if (cmd === "doctor") return doctor(out);
  if (cmd === "worker") return (await import("./worker.js")).runWorker(f, out);

  // ---- project directory
  let dir = args._[0] ? path.resolve(args._[0]) : process.cwd();
  if (!args._[0] && isBarixRepo(dir) && stdin.isTTY) { const rl0 = readline.createInterface({ input: stdin, output: stdout }); const def = path.join(os.homedir(), "BarixProjects", "project"); const ans = await new Promise((r) => rl0.question(`Project folder (Enter = ${def}): `, r)); rl0.close(); dir = path.resolve(ans.trim() || def); }
  await mkdir(dir, { recursive: true });

  const token = await githubToken(); const github = new GitHubClient({ token });
  const rl = stdin.isTTY || !f.p ? readline.createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY }) : null;
  const ask = (q) => new Promise((res) => (rl ? rl.question(q, res) : res("n")));
  const confirm = async (q) => { if (f.yes) return true; const a = await ask(`${C.yellow}? ${q} [y/N] ${C.off}`); return /^y(es)?$/i.test(a.trim()); };
  const log = (s) => out(`${C.dim}${s}${C.off}`);

  log(`BarixTerm ${VERSION} · project ${dir}`);
  const providers = await setupProviders({ endpoint: f.endpoint, endpointModel: f["endpoint-model"], window: f.window ? +f.window : undefined, model: f.model, dtype: f.dtype, cacheDir: path.join(os.homedir(), ".barix", "models"), onProgress: progressBar(stdout) }, log);
  const caps = { exec: !f["no-exec"], git: !f["no-exec"], github: true };
  const b = await createBarix({ backend: await NodeBackend.create(dir), runtime: await nodeTreeSitter(), providers, tools: [...execTools, ...gitTools, ...githubTools], capabilities: caps, env: "term", projectId: path.basename(dir), extraCtx: { root: dir, github, confirm, identity: undefined } });
  if (providers[0]?.exactCounter) b.counter.exact = await providers[0].exactCounter().catch(() => null);
  const prof = await b.intel.getProfile(); log(`indexed ${b.fs.files().length} files · ${b.intel.health().symbols} symbols · ${prof.primaryLanguage ?? "empty project"}`);

  if (cmd === "publish") return publishCommand({ b, dir, github, f, confirm, out });
  const run = async (text) => {
    process.stdout.write(`\n${C.cyan}barix${C.off} › `); let started = false;
    const r = await b.ask(text, { onEvent: (e) => render(e, stdout), sink: undefined }).catch((e) => ({ error: e }));
    if (r.error) { out(`\n${C.red}✗ ${r.error.code ?? "error"}: ${r.error.message}${C.off}`); return; }
    if (r.text !== r.answer) out(`\n${C.dim}${r.text.slice(r.answer.length).trim()}${C.off}`); else out("");
    out(`${C.dim}[${r.steps} step(s) · ${r.usage.promptTokens}+${r.usage.completionTokens} tokens · ${(r.ms / 1000).toFixed(1)}s · ${r.routes.join(",")}${r.changedFiles.length ? ` · changed: ${r.changedFiles.join(", ")}` : ""}]${C.off}`);
  };
  if (f.p) { await run(f.p); rl?.close(); return; }

  out(`${C.dim}Type a request. /help for commands. Barix will ask before running unfamiliar commands.${C.off}`);
  for (;;) {
    const line = (await ask(`\n${C.green}you${C.off} › `)).trim(); if (!line) continue;
    if (line.startsWith("/")) { if (await slash(line, { b, out, dir, providers })) break; continue; }
    await run(line);
  }
  rl?.close();
}

async function slash(line, { b, out, dir }) {
  const [c, ...rest] = line.slice(1).split(/\s+/);
  switch (c) {
    case "exit": case "quit": return true;
    case "help": out(HELP); break;
    case "status": { const s = b.store.stats(), h = b.intel.health(); out(`context: ${s.retrievable} tokens retrievable (cap ${b.store.maxTotalTokens}), ${s.live} live, ${s.summaries} summaries · index: ${h.files} files, ${h.symbols} symbols, ${h.chunks} chunks · prefix reuse ${(b.engine.history.reusedPrefixTokens / Math.max(1, b.engine.history.totalPromptTokens) * 100).toFixed(0)}% · output budget ${OUTPUT_TARGETS.term} tokens/message`); break; }
    case "providers": for (const p of b.router.status()) out(`${p.circuitOpen ? "✗" : "●"} ${p.id} [${p.kind}] ${p.model} window ${p.window} ${p.tps ? p.tps + " tok/s" : ""} served ${p.served} month ${p.monthTokens} tokens`); out(JSON.stringify(b.router.capacity())); break;
    case "memory": out(["long-term:", ...b.memory.list("long-term").map((m) => `  ${m.id} ${m.text}`), "project:", ...b.memory.list("project").map((m) => `  ${m.id} ${m.text}`), b.memory.renderTask() ? "task:\n" + b.memory.renderTask() : ""].join("\n")); break;
    case "forget": out((await b.memory.forget(rest[0])) ? "forgotten" : "no such memory id"); break;
    case "compact": { const r = await b.compactor.compact(0); out(JSON.stringify(r)); break; }
    case "tools": out(b.registry.available(b.ctx.capabilities).map((t) => t.name).join(", ")); break;
    case "undo": { const g = new Git(dir); out((await g.isRepo()) ? "Use git (git restore / git revert) or Barix's restore_version tool: ask me to restore a file's previous version." : "Ask me: \"restore the previous version of <file>\"."); break; }
    case "clear": process.stdout.write("\x1bc"); break;
    default: out(`unknown command /${c}`);
  }
  return false;
}

function render(e, stdout) {
  switch (e.type) {
    case "plan": stdout.write(`${C.dim}[${e.plan.explain}]${C.off}\n`); break;
    case "token": stdout.write(e.text); break;
    case "tool": stdout.write(`\n${C.dim}  ⚙ ${e.tool}${e.args?.path ? " " + e.args.path : ""} → ${e.ok ? C.green + "ok" : C.red + "failed"}${C.dim} ${String(e.summary).slice(0, 80)}${C.off}\n`); break;
    case "gate": stdout.write(`\n${C.yellow}  ✓ verifying: ${e.action}${C.off}\n`); break;
    case "failover": stdout.write(`\n${C.yellow}  ↪ ${e.from} failed (${e.reason}); switching provider${C.off}\n`); break;
    case "memory": stdout.write(`${C.dim}  (remembered: ${e.stored})${C.off}\n`); break;
    case "continuing": stdout.write(`${C.dim}  … continuing (output exceeded one call)${C.off}\n`); break;
  }
}
function progressBar(stdout) { let last = ""; return (p) => { if (p.status === "progress" && p.file) { const s = `\r${C.dim}downloading ${p.file.split("/").pop()} ${Math.round(p.progress ?? 0)}%${C.off}   `; if (s !== last) { stdout.write(s); last = s; } } else if (p.status === "done") stdout.write("\n"); }; }
const isBarixRepo = (d) => { try { return path.basename(path.dirname(path.dirname(d))) === "BarixAI" || (path.basename(d) === "BarixAI"); } catch { return false; } };

async function doctor(out) {
  const s = systemInfo(); out(`${C.bold}BarixTerm doctor${C.off}`); out(`node ${s.node} on ${s.platform}, ${s.cores} cores, ${s.ramGB} GB RAM (${s.freeGB} GB free)`);
  out(parseInt(s.node.slice(1)) >= 20 ? `${C.green}✓${C.off} Node 20+` : `${C.red}✗${C.off} Node 20+ required`);
  try { const g = await new Git(process.cwd()).run(["--version"]); out(`${C.green}✓${C.off} ${g.out}`); } catch (e) { out(`${C.red}✗${C.off} git: ${e.message}`); }
  const servers = await detectLocalServers(); out(servers.length ? servers.map((x) => `${C.green}✓${C.off} local server: ${x.name} ${x.baseUrl} model ${x.model}${x.window ? ` window ${x.window}` : " (window unknown: pass --window)"}`).join("\n") : `${C.dim}· no local llama.cpp/Ollama/LM Studio server found; BarixTerm will use the built-in ONNX model (CPU)${C.off}`);
  const t = await githubToken(); out(t ? `${C.green}✓${C.off} GitHub token available (env or gh)` : `${C.dim}· no GitHub token: public repos work; private repos/publishing need GITHUB_TOKEN or \`gh auth login\`${C.off}`);
  try { const rt = await nodeTreeSitter(); const p = await rt.parserFor("javascript"); out(p ? `${C.green}✓${C.off} tree-sitter WASM parsers` : `${C.yellow}!${C.off} tree-sitter unavailable; using the fallback scanner`); } catch (e) { out(`${C.yellow}!${C.off} tree-sitter: ${e.message}`); }
}

async function publishCommand({ b, dir, github, f, confirm, out }) {
  const target = f.repo ? (parseGitHubUrl(f.repo) ?? null) : null; if (!f.repo) return out(`${C.red}publish needs --repo owner/name (or a github.com URL)${C.off}`);
  const pub = new Publisher({ root: dir, fs: b.fs, intel: b.intel, github, ledger: b.ledger, confirm, onStep: (s) => out(`${{ ok: C.green + "✓", fail: C.red + "✗", warn: C.yellow + "!", skipped: C.dim + "·" }[s.status]} ${s.name}${C.off}  ${s.detail}`) });
  const r = await pub.publish({ repo: { owner: target?.owner, name: target?.repo ?? f.repo, url: target ? `https://github.com/${target.owner}/${target.repo}.git` : undefined, create: !!f.create, private: !!f.private }, branch: f.branch ?? "main", message: f.message, pages: { enable: !!f.pages, mode: "auto", expectText: f.expect }, yes: !!f.yes, force: !!f.force, allowSecrets: f["allow-secret"] ? [].concat(f["allow-secret"]) : [] });
  out(r.ok ? `\n${C.green}Published and verified${C.off}: ${r.url}${r.pagesUrl ? `\nLive: ${r.pagesUrl}` : ""}` : `\n${C.red}Not published.${C.off} See the failed step above; nothing is reported as done unless verified.`);
  process.exitCode = r.ok ? 0 : 1;
}
