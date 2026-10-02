// Command-execution tools for BarixTerm (capability: exec). Real processes on the user's machine,
// confined to the project directory, policy-checked, time-limited, secret-free, and always recorded
// as evidence in the verification ledger with parsed diagnostics.
import { spawn } from "node:child_process";
import { classifyCommand, scrubEnv } from "./policy.js";
import { summarizeRun, parseDiagnostics } from "./parse-output.js";

const P = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export function runProcess(command, { cwd, timeoutMs = 120_000, env = scrubEnv(), signal, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); const win = process.platform === "win32";
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", bytes = 0, timedOut = false, killed = false;
    const kill = () => { if (killed) return; killed = true; try { if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs); signal?.addEventListener("abort", kill, { once: true });
    const onData = (d) => { if (bytes < maxBytes) { out += d; bytes += d.length; } };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out: `failed to start: ${e.message}`, ms: Date.now() - t0, timedOut: false }); });
    child.on("close", (code, sig) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code ?? (sig ? 137 : 1), out, ms: Date.now() - t0, timedOut, truncated: bytes >= maxBytes }); });
  });
}

const clip = (out, head = 30, tail = 110) => { const L = out.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n"); return L.length <= head + tail ? L.join("\n") : [...L.slice(0, head), `… ${L.length - head - tail} lines omitted …`, ...L.slice(-tail)].join("\n"); };

async function execute({ command, kind, ctx, timeoutSec = 120, label }) {
  const cls = classifyCommand(command);
  if (cls.decision === "deny") return { ok: false, output: `Command not run — ${cls.reason}.`, evidence: { kind: "command-refused", data: { command, reason: cls.reason } } };
  if (cls.decision === "confirm" && !(await ctx.confirm?.(command, cls.reason))) return { ok: false, output: `Command not run — ${cls.reason}, and the user did not approve it. Ask the user to approve, or use a different approach.`, evidence: { kind: "command-declined", data: { command } } };
  const r = await runProcess(command, { cwd: ctx.root, timeoutMs: timeoutSec * 1000, signal: ctx.signal });
  const ok = r.code === 0; const summary = r.timedOut ? `timed out after ${timeoutSec}s` : summarizeRun(kind, r.out, ok); const diagnostics = ok ? [] : parseDiagnostics(r.out);
  await ctx.fs.refresh().catch(() => {}); await ctx.intel?.sync();   // builds/generators may have changed files behind Barix's back
  const diag = diagnostics.length ? `\nDiagnostics (file:line):\n${diagnostics.map((d) => `  ${d.file}:${d.line}${d.col ? ":" + d.col : ""} ${d.message}`).join("\n")}` : "";
  return {
    ok, output: `$ ${command}\nexit code ${r.code} in ${(r.ms / 1000).toFixed(1)}s — ${summary}\n--- output ---\n${clip(r.out) || "(no output)"}${r.truncated ? "\n[output truncated at 2MB]" : ""}${diag}`,
    evidence: { kind, data: { command, exitCode: r.code, summary, diagnostics, durationMs: r.ms, label } }, meta: { summary, ok }, data: { diagnostics },
  };
}

export const execTools = [
  {
    name: "run_command", group: "exec", requires: ["exec"], mutating: true, tier: 1, timeoutMs: 600_000,
    description: "Run a shell command in the project directory (build tools, scripts, git read commands). Destructive commands are refused; unknown commands need user approval.",
    parameters: P({ command: { type: "string", description: "command line" }, timeoutSec: { type: "integer", minimum: 1, maximum: 600 } }, ["command"]),
    run: ({ command, timeoutSec }, ctx) => execute({ command, kind: "command", ctx, timeoutSec }),
  },
  ...[["run_tests", "test", "test"], ["run_build", "build", "build"], ["run_lint", "lint", "lint"], ["typecheck", "typecheck", "typecheck"]].map(([name, key, kind]) => ({
    name, group: "exec", requires: ["exec"], mutating: true, tier: 1, timeoutMs: 900_000,
    description: `Run the project's ${key} command (auto-detected from package.json / Cargo.toml / go.mod / Makefile / pyproject).`,
    parameters: P({ args: { type: "string", description: "extra arguments appended to the detected command (e.g. a test file)" } }),
    async run({ args }, ctx) {
      const prof = await ctx.intel.getProfile(); const base = prof.commands[key];
      if (!base) return { ok: false, output: `No ${key} command detected for this project (looked at: ${prof.manifests.join(", ") || "no manifests"}). Use run_command with the right command, or tell the user how to ${key} it.`, evidence: { kind: "command-missing", data: { key } } };
      const safeArgs = args && /^[\w@./:=,\- "']+$/.test(args) ? ` ${args}` : "";
      return execute({ command: base + safeArgs, kind, ctx, timeoutSec: 600, label: name });
    },
  })),
];
