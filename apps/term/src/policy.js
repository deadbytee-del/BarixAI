// Command safety policy for BarixTerm. Barix runs commands on the user's real machine, so:
//  - obviously destructive/escaping commands are refused outright,
//  - well-known dev tools run without prompting,
//  - anything else needs the user's confirmation (or is refused when non-interactive),
//  - child processes never inherit secrets from the environment.
const SAFE_BIN = new Set(["npm", "npx", "node", "pnpm", "yarn", "bun", "deno", "python", "python3", "py", "pip", "pip3", "pytest", "uv", "cargo", "rustc", "go", "make", "cmake", "tsc", "eslint", "prettier", "jest", "vitest", "mocha", "mvn", "gradle", "gradlew", "dotnet", "ls", "dir", "cat", "type", "echo", "pwd", "head", "tail", "wc", "grep", "rg", "find", "findstr", "sort", "uniq", "diff", "tree", "which", "where", "git", "true", "false", "test"]);
const READONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files", "ls-remote", "config", "describe", "tag", "blame", "shortlog", "stash"]);
const DENY = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\*|\.\.|\.\s*$)/i, "recursive delete of root/home/parent"],
  [/\bdel\s+\/[sfq]|\brmdir\s+\/s|\bformat\s+[a-z]:|\bRemove-Item\b.*-Recurse.*-Force/i, "destructive Windows delete/format"],
  [/\bsudo\b|\bsu\s+-|\brunas\b/i, "privilege escalation"],
  [/(curl|wget|iwr|Invoke-WebRequest)[^|;&]*\|\s*(sh|bash|zsh|iex|powershell|pwsh)/i, "piping a download into a shell"],
  [/\bchmod\s+-R\s+7|\bchown\s+-R\b/i, "recursive permission change"],
  [/\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|:\(\)\s*\{|\bdiskpart\b|\breg\s+delete\b/i, "system-level destructive command"],
  [/\bgit\s+push\b[^\n]*--force(?!-with-lease)|\bgit\s+reset\s+--hard\s+origin\b|\bgit\s+clean\s+-[a-z]*f[a-z]*d|\bgit\s+push\b[^\n]*\s-f\b/i, "history-destroying git command (ask the user to run it themselves)"],
  [/(^|[\s;&|])(>|>>)\s*(\/|~|[a-zA-Z]:[\\/]|\.\.)/, "redirect outside the project"],
  [/(^|[\s"'=])\.\.[\\/]\.\.|(^|\s)cd\s+(\/|~|\.\.|[a-zA-Z]:)/, "path escapes the project root"],
  [/\b(powershell|pwsh)\b[^\n]*(-enc|-encodedcommand)\b|\bbase64\s+-d\b[^\n]*\|\s*(sh|bash)/i, "obfuscated command"],
  [/\bnpm\s+(publish|unpublish|deprecate|owner|token)\b|\bpip\s+upload\b|\btwine\s+upload\b|\bcargo\s+publish\b/i, "publishing a package (do this yourself)"],
];
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE|SESSION|COOKIE|AUTH)/i;
const KEEP_ENV = new Set(["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TERM", "SHELL", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData", "HOMEDRIVE", "HOMEPATH", "NODE_ENV", "CI", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE"]);

/** @returns {{decision:"allow"|"confirm"|"deny", reason:string}} */
export function classifyCommand(cmd) {
  const c = cmd.trim();
  if (!c) return { decision: "deny", reason: "empty command" };
  if (c.length > 4000) return { decision: "deny", reason: "command too long" };
  for (const [re, why] of DENY) if (re.test(c)) return { decision: "deny", reason: `refused: ${why}` };
  const segments = c.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  let allSafe = true;
  for (const seg of segments) {
    const toks = seg.replace(/^\(+|\)+$/g, "").split(/\s+/); let i = 0; while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++; // env assignments
    const bin = (toks[i] ?? "").replace(/^\.[\\/]/, "").replace(/\.(cmd|exe|bat)$/i, "").split(/[\\/]/).pop();
    if (!SAFE_BIN.has(bin)) { allSafe = false; break; }
    if (bin === "git") { const sub = toks.slice(i + 1).find((t) => !t.startsWith("-")); if (!READONLY_GIT.has(sub)) { allSafe = false; break; } }
    if ((bin === "npm" || bin === "pnpm" || bin === "yarn") && /\b(install|i|add|ci)\b/.test(seg) && /\s-g\b|--global/.test(seg)) { allSafe = false; break; }
    if (bin === "pip" || bin === "pip3") { if (/\b(install|uninstall)\b/.test(seg)) { allSafe = false; break; } }
  }
  return allSafe ? { decision: "allow", reason: "known development tool" } : { decision: "confirm", reason: "not on the safe list; needs your approval" };
}

/** Child environment with secrets removed. */
const DROP_ENV = new Set(["NODE_TEST_CONTEXT", "NODE_OPTIONS", "npm_lifecycle_event", "npm_lifecycle_script", "npm_command", "npm_execpath", "npm_node_execpath"]);
export function scrubEnv(env = process.env) {
  const out = {}; for (const [k, v] of Object.entries(env)) if (!DROP_ENV.has(k) && (KEEP_ENV.has(k) || (!SECRET_ENV.test(k) && !/^(npm_config_.*(auth|token).*)$/i.test(k)))) out[k] = v; return out;
}
