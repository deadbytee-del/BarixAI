// `barixterm self`: wires SelfEdit (self-edit.js) to the real agent, git checkout, tests and GitHub.
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createBarix, NodeBackend, nodeTreeSitter, GitHubClient, parseGitHubUrl } from "@barix/core";
import { execTools, runProcess } from "./exec-tools.js";
import { Git } from "./git.js";
import { setupProviders, githubToken } from "./providers-setup.js";
import { SelfEdit, DEFAULT_HOURS, MAX_HOURS } from "./self-edit.js";
import * as UI from "./ui.js";
import { classifyCommand } from "./policy.js";

const REPO_URL = "https://github.com/deadbytee-del/BarixAI.git";
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const RULES = (hours, branchNote) => `
Self-edit mode lets Barix work on ITS OWN code, unattended, for up to ${hours} hour(s).
  • It edits a working copy of the Barix repository on a separate "barix/self-edit-*" branch ${branchNote}.
  • A change is kept (committed) only if the FULL test suite passes. Otherwise it is rolled back.
  • It cannot touch CI workflows, its own safety code, secrets, lockfiles or launchers (those edits are reverted).
  • It pushes only that branch and keeps one DRAFT pull request. It never merges and never pushes to main.
  • Commands it runs are auto-approved (dangerous ones — sudo, rm -rf, curl|sh, force-push, publish — stay blocked). Use --no-auto-accept to deny anything unfamiliar.
  • Stop any time: Ctrl-C, or create the file .barix/self/STOP in the repo. Progress is saved; use --resume to continue.
  • It runs commands (tests) on this machine and uses a lot of CPU; a local model server (Ollama / llama.cpp) is strongly recommended.
`;

export async function selfEditCommand({ f, out, stdin, stdout, C }) {
  const hours = f.hours ? +f.hours : DEFAULT_HOURS; if (!(hours > 0 && hours <= MAX_HOURS)) return out(`${C.red}--hours must be between 0 and ${MAX_HOURS}${C.off}`);
  const token = await githubToken(); const github = new GitHubClient({ token });
  // 1. a git checkout of Barix itself: this one if it is a git repo, otherwise a clone kept under ~/.barix/self-edit
  let repoDir = f["repo-dir"] ? path.resolve(f["repo-dir"]) : HERE;
  if (!existsSync(path.join(repoDir, ".git"))) {
    repoDir = path.join(os.homedir(), ".barix", "self-edit", "BarixAI"); await mkdir(path.dirname(repoDir), { recursive: true });
    if (!existsSync(path.join(repoDir, ".git"))) {
      out(`${C.dim}Cloning ${REPO_URL} into ${repoDir} …${C.off}`);
      try { await new Git(path.dirname(repoDir), { token }).run(["clone", "--depth", "50", REPO_URL, repoDir], { auth: true, timeoutMs: 600_000 }); } catch (e) { return out(`${C.red}Could not clone Barix: ${e.message}${C.off}`); }
      out(`${C.dim}Installing dependencies …${C.off}`); const r = await runProcess("npm install --no-audit --no-fund", { cwd: repoDir, timeoutMs: 900_000 }); if (r.code !== 0) return out(`${C.red}npm install failed:\n${r.out.slice(-600)}${C.off}`);
    }
  }
  const git = new Git(repoDir, { token });
  const origin = await git.remoteUrl(); const slug = origin ? parseGitHubUrl(origin) : null; const repoSlug = slug ? `${slug.owner}/${slug.repo}` : null;
  if (stdout.isTTY) out(UI.banner("self-edit"));
  out(`${C.bold}BarixTerm self-edit${C.off} · repo ${repoDir}${repoSlug ? ` (${repoSlug})` : " (no remote: commits stay local)"}`);
  out(`reasoning: ${f.reasoning ?? "auto"} · auto-accept: ${f["no-auto-accept"] ? "off" : "ON"}`);
  out(RULES(hours, token && repoSlug ? "and a draft PR" : "(no GitHub token → commits stay local)"));
  if (f.confirm && !f.yes) { const rl = readline.createInterface({ input: stdin, output: stdout }); const a = await new Promise((r) => rl.question(`${C.yellow}Type "start" to begin: ${C.off}`, r)); rl.close(); if (a.trim().toLowerCase() !== "start") return out("Cancelled."); }

  const autoAccept = !f["no-auto-accept"]; const reasoning = ["on", "off"].includes(f.reasoning) ? f.reasoning : "auto";
  const providers = await setupProviders({ cacheDir: path.join(os.homedir(), ".barix", "models"), onProgress: () => {} }, (s) => out(`${C.dim}${s}${C.off}`));
  const runtime = await nodeTreeSitter();
  // a fresh Barix per cycle: re-indexes the changed repo and keeps context from growing without bound over 24h
  const agent = async (prompt, { signal }) => {
    const b = await createBarix({ backend: await NodeBackend.create(repoDir), runtime, providers, tools: [...execTools], capabilities: { exec: true, git: false, github: false }, env: "term", projectId: "barix-self", extraCtx: { root: repoDir, github, signal, confirm: async (cmd) => autoAccept && classifyCommand(cmd).decision !== "deny" } });
    b.setReasoning(reasoning);
    return b.ask(prompt, { signal });
  };
  const se = new SelfEdit({ repoDir, git, agent, github, hours, goals: f.goal ? [String(f.goal)] : [], resume: !!f.resume, repoSlug, log: (s) => out(`${C.dim}${s}${C.off}`), onEvent: (e) => out(UI.selfEvent(e)) });
  const onSig = () => { out(`\n${C.yellow}Stopping after the current step…${C.off}`); se.requestStop(); }; process.on("SIGINT", onSig); process.on("SIGTERM", onSig);
  try { const r = await se.run(); out(`\n${C.green}Self-edit finished${C.off} (${r.reason}): ${r.commits} commit(s) kept, ${r.failures} rolled back, branch ${r.branch}${r.prUrl ? `\nDraft PR: ${r.prUrl}` : ""}\nReport: ${path.join(repoDir, ".barix", "self", "REPORT.md")}`); }
  catch (e) { out(`${C.red}Self-edit could not start: ${e.message}${C.off}`); process.exitCode = 1; }
  finally { process.off("SIGINT", onSig); process.off("SIGTERM", onSig); }
}
