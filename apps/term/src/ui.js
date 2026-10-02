// BarixTerm UI: black / glossy-silver / ingot-gray, white accent — the same look as the web app. Zero dependencies, plain ANSI
// (works in Windows Terminal, PowerShell 7, cmd on Windows 10+, macOS Terminal, Linux). Falls back to plain text when piped or NO_COLOR is set.
import path from "node:path";

const TTY = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const TRUE = TTY && (/truecolor|24bit/i.test(process.env.COLORTERM ?? "") || !!process.env.WT_SESSION || process.platform === "win32" || /iTerm|vscode/i.test(process.env.TERM_PROGRAM ?? ""));
const esc = (c) => (TTY ? `\x1b[${c}m` : "");
const rgb = (r, g, b, fb) => (TRUE ? esc(`38;2;${r};${g};${b}`) : esc(fb));
export const S = {
  off: esc(0), bold: esc(1), dim: esc(2), ital: esc(3),
  silver: rgb(214, 216, 220, 37), ingot: rgb(110, 114, 122, 90), white: rgb(255, 255, 255, "1;97"), mute: rgb(140, 144, 152, 90),
  ok: rgb(155, 232, 185, 32), warn: rgb(232, 201, 138, 33), bad: rgb(240, 154, 154, 31),
};
export const paint = (c, t) => (TTY ? c + t + S.off : t);
export const width = () => Math.max(40, Math.min(process.stdout.columns || 100, 110));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const vlen = (s) => [...strip(s)].length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - vlen(s)));

// ---- banner / header -----------------------------------------------------------------------------------------
const LOGO = ["█▀▄ ▄▀█ █▀█ █ ▀▄▀", "█▄▀ █▀█ █▀▄ █ █ █"];
function gradient(line, i, n) { if (!TRUE) return paint(S.silver, line); const t = i / Math.max(1, n - 1); const v = Math.round(255 - 70 * Math.abs(Math.sin(t * Math.PI * 1.5))); return `\x1b[38;2;${v};${v};${Math.min(255, v + 4)}m${line}${S.off}`; }
export function banner(version) {
  const rows = LOGO.map((l, i) => "  " + gradient(l, i, LOGO.length)); rows[0] += "  " + paint(S.white + S.bold, "BarixTerm") + paint(S.mute, ` ${version}`); rows[1] += "  " + paint(S.mute, "your own AI engineer, local-first");
  return "\n" + rows.join("\n") + "\n";
}
export function box(title, rows, { w = width() } = {}) {
  const inner = w - 4; const top = `╭─ ${title} ${"─".repeat(Math.max(0, inner - vlen(title) - 1))}╮`; const bot = `╰${"─".repeat(w - 2)}╯`;
  const body = rows.map((r) => `│ ${pad(r, inner)} │`);
  return [paint(S.ingot, top), ...body.map((l) => paint(S.ingot, "│") + l.slice(1, -1) + paint(S.ingot, "│")), paint(S.ingot, bot)].join("\n");
}
export const kv = (k, v) => paint(S.mute, pad(k, 11)) + v;
export function header({ dir, models, ctx, reasoning, mode, files, symbols, lang }) {
  return box("session", [
    kv("project", paint(S.white, path.basename(dir) || dir) + paint(S.mute, `  ${dir}`)),
    kv("model", models), kv("index", `${files} files · ${symbols} symbols${lang ? " · " + lang : ""}`),
    kv("reasoning", reasoning === "on" ? paint(S.white, "on") : reasoning === "off" ? "off" : "auto (thinks on hard problems)"),
    kv("mode", mode), kv("context", ctx),
  ]);
}
export const hint = (t) => paint(S.mute, t);
export const prompt = () => `\n${paint(S.white + S.bold, "❯")} `;

// ---- spinner -------------------------------------------------------------------------------------------------
export class Spinner {
  constructor(out = process.stdout) { this.out = out; this.t = null; this.i = 0; this.label = ""; this.t0 = 0; this.on = false; }
  start(label = "thinking") { if (!TTY || this.on) { this.label = label; return; } this.on = true; this.label = label; this.t0 = Date.now(); this.t = setInterval(() => this.#draw(), 90); this.#draw(); }
  set(label) { this.label = label; }
  #draw() { const f = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[this.i++ % 10]; this.out.write(`\r\x1b[2K${paint(S.silver, f)} ${paint(S.mute, this.label)} ${paint(S.ingot, ((Date.now() - this.t0) / 1000).toFixed(1) + "s")}`); }
  stop() { if (!this.on) return; clearInterval(this.t); this.on = false; this.out.write("\r\x1b[2K"); }
}

// ---- streaming answer renderer: line-buffered mini-markdown with a gutter ------------------------------------
export class AnswerStream {
  constructor(out = process.stdout) { this.out = out; this.buf = ""; this.fence = false; this.started = false; }
  write(text) { this.buf += text; let i; while ((i = this.buf.indexOf("\n")) >= 0) { this.#line(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); } }
  end() { if (this.buf) this.#line(this.buf); this.buf = ""; if (this.started) this.out.write("\n"); this.started = false; this.fence = false; }
  #line(l) {
    const gut = paint(S.ingot, "▎ "); this.started = true;
    if (/^\s*```/.test(l)) { this.fence = !this.fence; this.out.write(`${gut}${paint(S.ingot, l.trim() || "```")}\n`); return; }
    if (this.fence) { this.out.write(`${gut}${paint(S.silver, l)}\n`); return; }
    let t = l.replace(/^(#{1,3})\s+(.*)$/, (_, h, x) => paint(S.white + S.bold, x));
    t = t.replace(/\*\*([^*]+)\*\*/g, (_, x) => paint(S.white + S.bold, x)).replace(/`([^`]+)`/g, (_, x) => paint(S.silver, x));
    t = t.replace(/^(\s*)([-*]) /, (_, a) => `${a}${paint(S.mute, "•")} `).replace(/^(\s*)([✓])/, (_, a, c) => a + paint(S.ok, c)).replace(/^(\s*)([✗])/, (_, a, c) => a + paint(S.bad, c));
    this.out.write(`${gut}${t}\n`);
  }
}

// ---- events --------------------------------------------------------------------------------------------------
const ICON = { ok: paint(S.ok, "✓"), fail: paint(S.bad, "✗"), run: paint(S.silver, "●") };
export function toolLine(e) { const arg = e.args?.path ?? e.args?.command ?? e.args?.query ?? e.args?.pattern ?? ""; return `  ${e.ok ? ICON.ok : ICON.fail} ${paint(S.white, e.tool)}${arg ? " " + paint(S.mute, String(arg).slice(0, 60)) : ""} ${paint(S.ingot, String(e.summary ?? "").replace(/\s+/g, " ").slice(0, 70))}`; }
export const noteLine = (kind, t) => `  ${kind === "warn" ? paint(S.warn, "!") : ICON.run} ${paint(S.mute, t)}`;
export function footer(r, { changed = [] } = {}) {
  const parts = [`${r.steps} step${r.steps === 1 ? "" : "s"}`, `${fmt(r.usage.promptTokens)}+${fmt(r.usage.completionTokens)} tokens`, `${(r.ms / 1000).toFixed(1)}s`, r.routes.join(", ")];
  return paint(S.ingot, "  ") + paint(S.mute, parts.join(" · ")) + (changed.length ? "\n  " + paint(S.ok, "changed ") + paint(S.silver, changed.join(", ")) : "");
}
export const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

export function helpText() {
  const row = (c, d) => `  ${paint(S.white, pad(c, 24))}${paint(S.mute, d)}`;
  return [paint(S.white + S.bold, "Commands"), row("/reasoning on|off|auto", "turn step-by-step thinking on or off (slower, smarter when on)"), row("/auto on|off", "auto-approve commands and commits (dangerous commands stay blocked)"),
    row("/status", "context, index and compute"), row("/providers", "compute Barix can use"), row("/memory", "what Barix remembers"), row("/forget ID", "forget a memory"), row("/compact", "compact the conversation context"),
    row("/tools", "tools available"), row("/clear", "clear the screen"), row("/exit", "leave"), "", paint(S.mute, "Anything else is a request. Barix reads, edits and tests your project and only reports what it verified.")].join("\n");
}

// ---- self-edit dashboard -------------------------------------------------------------------------------------
const KIND = { commit: ["✓", S.ok], fail: ["✗", S.bad], violation: ["!", S.warn], push: ["↑", S.silver], pr: ["⎇", S.silver], error: ["✗", S.bad], start: ["▶", S.white], end: ["■", S.white], task: ["●", S.silver], baseline: ["·", S.mute], idle: ["…", S.mute], "push-failed": ["!", S.warn], "pr-failed": ["!", S.warn] };
export function selfEvent(e) {
  const [ic, col] = KIND[e.type] ?? ["·", S.mute]; const t = (e.t ?? "").slice(11, 19);
  return `${paint(S.ingot, t)} ${paint(col, ic)} ${paint(col === S.mute ? S.mute : S.white, pad(e.type, 9))} ${paint(S.mute, [e.id, e.msg].filter(Boolean).join(" — ").slice(0, width() - 24))}`;
}
