// Turns raw tool output into (a) a one-line summary and (b) structured diagnostics (file:line + message)
// that Barix's correction loop can act on directly. Pure functions; unit-tested.
export function summarizeRun(kind, output, ok) {
  const t = output.replace(/\x1b\[[0-9;]*m/g, "");
  let m;
  if ((m = /# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/.exec(t))) return `${m[2]} passed, ${m[3]} failed of ${m[1]} (node:test)`;
  if ((m = /Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total/.exec(t))) return `${m[3] ?? 0} passed, ${m[1] ?? 0} failed of ${m[4]} (jest/vitest)`;
  if ((m = /(\d+) passed(?:,\s*(\d+) failed)?/.exec(t)) && /pytest|=====/.test(t)) return `${m[1]} passed, ${m[2] ?? 0} failed (pytest)`;
  if ((m = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/.exec(t))) return `${m[2]} passed, ${m[3]} failed (cargo)`;
  if (/^(ok|FAIL)\s+\S+/m.test(t) && /go test|\bPASS\b|\bFAIL\b/.test(t)) return `${(t.match(/^ok\s/gm) ?? []).length} packages ok, ${(t.match(/^FAIL\s/gm) ?? []).length} failed (go)`;
  if ((m = /Found (\d+) errors?/.exec(t))) return `${m[1]} TypeScript error(s)`;
  if ((m = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(t))) return `${m[2]} lint error(s), ${m[3]} warning(s)`;
  const lines = t.trim().split("\n").filter(Boolean); const last = lines.slice(-2).join(" ").slice(0, 160);
  return ok ? (last || `${kind} finished`) : (firstError(t) || last || `${kind} failed`);
}
function firstError(t) { const m = /^(?:.*\b(?:error|Error|ERROR|FAIL|fatal|Traceback)\b.*)$/m.exec(t); return m ? m[0].trim().slice(0, 200) : ""; }

/** Extract file:line diagnostics from common toolchains. */
export function parseDiagnostics(output, { max = 12 } = {}) {
  const t = output.replace(/\x1b\[[0-9;]*m/g, ""); const out = []; const seen = new Set();
  const add = (file, line, col, message, tool) => { const k = `${file}:${line}:${message}`; if (seen.has(k) || out.length >= max) return; seen.add(k); out.push({ file: file.replace(/\\/g, "/").replace(/^\.\//, ""), line: +line, col: col ? +col : undefined, message: message.trim().slice(0, 240), tool }); };
  for (const m of t.matchAll(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+:[^\n]+)/gm)) add(m[1], m[2], m[3], m[4], "tsc");
  for (const m of t.matchAll(/^(.+?):(\d+):(\d+):\s*(?:error|warning)?:?\s*(.+)$/gm)) if (/\.\w{1,5}$/.test(m[1]) && !/^\s*at /.test(m[1])) add(m[1], m[2], m[3], m[4], "compiler/lint");
  for (const m of t.matchAll(/File "([^"]+)", line (\d+)(?:, in [^\n]+)?\n(?:[^\n]*\n){0,2}?(\w*(?:Error|Exception)[^\n]*)/g)) add(m[1], m[2], undefined, m[3], "python");
  for (const m of t.matchAll(/at (?:[^\s(]+ \()?((?:file:\/\/)?[^\s():]+\.(?:m?js|cjs|ts|tsx|jsx)):(\d+):(\d+)\)?/g)) if (!/node_modules|node:internal/.test(m[1])) add(m[1].replace(/^file:\/\//, ""), m[2], m[3], (/^(?:\w*Error[^\n]*)/m.exec(t)?.[0] ?? "runtime error"), "node");
  for (const m of t.matchAll(/^\s+[\w.<>$]+ \((file:\/\/[^)]+?):(\d+):(\d+)\)$/gm)) if (!/node_modules|node:internal/.test(m[1])) add(m[1].replace(/^file:\/\//, ""), m[2], m[3], /^\s*error: (.+)$/m.exec(t)?.[1] ?? /^not ok \d+ - (.+)$/m.exec(t)?.[1] ?? "test failure", "node:test");
  for (const m of t.matchAll(/^\s*--> (.+?):(\d+):(\d+)\n(?:[^\n]*\n){0,3}?/gm)) add(m[1], m[2], m[3], /error(?:\[E\d+\])?: ([^\n]+)/.exec(t)?.[1] ?? "rust error", "rustc");
  for (const m of t.matchAll(/^(.+?):(\d+):\s+(.+)$/gm)) if (/\.(go|c|cc|cpp|h|java)$/.test(m[1])) add(m[1], m[2], undefined, m[3], "build");
  return out;
}
