// Built-in Barix tools: filesystem, code intelligence, history and memory. These work identically in the
// browser (OPFS/IndexedDB-backed BarixFS) and in BarixTerm (disk-backed BarixFS).
// ctx = { fs, intel, ledger, memory, engine, readSet:Map, capabilities, checkSyntax }
import { hash53 } from "../util/hash.js";
import { checkSyntax } from "../code/extract.js";
import { unifiedDiff } from "../fs/diff.js";

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const P = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ok = (output, extra = {}) => ({ ok: true, output, ...extra });
const bad = (output, extra = {}) => ({ ok: false, output, ...extra });
const lines = (t) => t.split("\n").length;

async function afterWrite(ctx, path, action) {
  const text = await ctx.fs.readFile(path).catch(() => null);        // re-read from storage: proof, not assumption
  if (text === null) return { text: null, hash: null, syntax: "binary or unreadable" };
  const hash = hash53(text); ctx.readSet.set(path, hash);
  await ctx.intel?.sync();
  const errs = ctx.intel ? await checkSyntax(ctx.intel.symbols.runtime, path, text) : null;
  const syntax = errs === null ? "no grammar for this file type (syntax not checked)" : errs.length ? `SYNTAX ERRORS:\n${errs.slice(0, 5).map((e) => `  line ${e.line}:${e.column} ${e.message}${e.text ? ` near ${JSON.stringify(e.text)}` : ""}`).join("\n")}` : "syntax OK";
  return { text, hash, syntax, errors: errs };
}
const needRead = (ctx, args) => {
  if (!ctx.fs.exists(args.path)) return `No such file: ${args.path}. Use write_file to create it, or list_dir/find_files to locate it.`;
  if (!ctx.readSet.has(args.path)) return `Read ${args.path} with read_file before editing it (Barix blocks blind edits).`;
  return null;
};
const staleCheck = async (ctx, args) => {
  const cur = hash53(await ctx.fs.readFile(args.path).catch(() => ""));
  return ctx.readSet.get(args.path) === cur ? null : `${args.path} changed since you last read it. Re-read it with read_file, then retry.`;
};

export const builtinTools = [
  {
    name: "read_file", group: "core", description: "Read a text file with line numbers. Use startLine/endLine for large files.",
    parameters: P({ path: S("project-relative path"), startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["path"]),
    async run({ path, startLine = 1, endLine }, ctx) {
      if (!ctx.fs.exists(path)) { const near = ctx.fs.files().filter((f) => f.endsWith("/" + path.split("/").pop()) || f.split("/").pop() === path).slice(0, 5); return bad(`No such file: ${path}.${near.length ? ` Similar: ${near.join(", ")}` : ""}`); }
      const whole = await ctx.fs.readFile(path); ctx.readSet.set(path, hash53(whole));
      const total = lines(whole); const end = Math.min(endLine ?? startLine + 399, total, startLine + 799);
      const { text } = await ctx.fs.readNumbered(path, { startLine, endLine: end });
      return ok(`${path} — lines ${startLine}-${end} of ${total}${end < total ? ` (use startLine=${end + 1} to continue)` : ""}\n${text}`, { meta: { read: true, startLine, endLine: end, summary: `${total} lines` } });
    },
  },
  {
    name: "list_dir", group: "core", description: "List a directory (name, type, size).",
    parameters: P({ path: S("directory, default project root"), recursive: { type: "boolean" } }),
    async run({ path = "", recursive = false }, ctx) {
      try { const e = ctx.fs.list(path, { recursive }); return ok(e.length ? e.slice(0, 300).map((x) => `${x.type === "dir" ? "d" : "-"} ${x.path}${x.type === "file" ? ` (${x.size}B)` : "/"}`).join("\n") + (e.length > 300 ? `\n… ${e.length - 300} more` : "") : "(empty directory)"); } catch (e) { return bad(e.message); }
    },
  },
  { name: "project_tree", group: "core", description: "Compact tree of the whole project.", parameters: P({ maxEntries: { type: "integer", minimum: 10, maximum: 1000 } }), async run({ maxEntries = 200 }, ctx) { const t = ctx.fs.renderTree({ maxEntries }); return ok(t || "(project is empty)"); } },
  { name: "find_files", group: "core", description: "Find files by glob (e.g. src/**/*.ts).", parameters: P({ glob: S("glob pattern") }, ["glob"]), async run({ glob }, ctx) { const f = ctx.fs.files({ glob }); return ok(f.length ? f.slice(0, 200).join("\n") + (f.length > 200 ? `\n… ${f.length - 200} more` : "") : "no files match"); } },
  {
    name: "grep", group: "core", description: "Exact text/regex search across files. Returns path:line: text.",
    parameters: P({ pattern: S("text or regex"), regex: { type: "boolean" }, glob: S("limit to files matching glob"), ignoreCase: { type: "boolean" } }, ["pattern"]),
    async run(a, ctx) { const r = await ctx.fs.grep(a.pattern, { regex: a.regex, glob: a.glob, ignoreCase: a.ignoreCase, maxResults: 80 }); return ok(r.length ? r.map((x) => `${x.path}:${x.line}: ${x.text.trim()}`).join("\n") : "no matches"); },
  },
  {
    name: "search_code", group: "core", description: "Semantic + lexical + symbol search over the project. Best for 'where is X handled?' questions.",
    parameters: P({ query: S("natural language or identifiers"), k: { type: "integer", minimum: 1, maximum: 15 } }, ["query"]),
    async run({ query, k = 6 }, ctx) {
      if (!ctx.intel) return bad("code index unavailable");
      const r = await ctx.intel.retrieve(query, { budgetTokens: 2500, k, expandGraph: false });
      return ok(r.items.length ? r.items.map((i) => `${i.path}:${i.startLine}-${i.endLine}  (${i.reason})\n${i.text.split("\n").slice(0, 8).join("\n")}${i.text.split("\n").length > 8 ? "\n…" : ""}`).join("\n\n") : "no relevant code found");
    },
  },
  {
    name: "write_file", group: "core", mutating: true, description: "Create a file, or fully overwrite one you have read. Parent directories are created. Verified after writing.",
    parameters: P({ path: S("project-relative path"), content: S("complete file content"), overwrite: { type: "boolean", description: "allow replacing an unread existing file" } }, ["path", "content"]),
    async guard(a, ctx) { if (ctx.fs.exists(a.path) && !a.overwrite) { if (!ctx.readSet.has(a.path)) return `${a.path} already exists. Read it first with read_file (or pass overwrite:true to replace it).`; return staleCheck(ctx, a); } return null; },
    async run({ path, content }, ctx) {
      const existed = ctx.fs.exists(path); const before = existed ? await ctx.fs.readFile(path).catch(() => "") : "";
      await ctx.fs.writeFile(path, content);
      const v = await afterWrite(ctx, path, existed ? "overwrite" : "create");
      const stats = `+${lines(content)} lines${existed ? ` (was ${lines(before)})` : ""}`;
      return ok(`${existed ? "Overwrote" : "Created"} ${path}: ${lines(content)} lines, ${content.length} bytes. Verified on disk (hash ${v.hash?.toString(16).slice(0, 8)}). ${v.syntax}`,
        { evidence: { kind: "fs-write", data: { path, hash: v.hash, size: content.length, action: existed ? "overwrite" : "create" } }, meta: { stats, summary: v.syntax }, data: { syntaxErrors: v.errors } });
    },
  },
  {
    name: "patch_file", group: "core", mutating: true, description: "Edit a file you have read with exact search/replace edits. Each `search` must match exactly once (or set all:true). Prefer this over rewriting files.",
    parameters: P({ path: S("file path"), edits: { type: "array", items: P({ search: S("exact existing text"), replace: S("replacement text"), all: { type: "boolean" } }, ["search"]) } }, ["path", "edits"]),
    async guard(a, ctx) { return needRead(ctx, a) ?? (await staleCheck(ctx, a)); },
    async run({ path, edits }, ctx) {
      let r; try { r = await ctx.fs.patchFile(path, edits); } catch (e) { return bad(`${e.message}\nRe-read the file (read_file) and use text that matches exactly.`); }
      const v = await afterWrite(ctx, path, "patch"); const stats = `+${r.add} -${r.del}`;
      return ok(`Patched ${path} (${stats}). Verified on disk. ${v.syntax}\n${r.diff.split("\n").slice(0, 40).join("\n")}`,
        { evidence: { kind: "fs-write", data: { path, hash: v.hash, size: v.text?.length ?? 0, action: "patch" } }, meta: { stats, summary: v.syntax }, data: { syntaxErrors: v.errors } });
    },
  },
  {
    name: "apply_patch", group: "core", mutating: true, description: "Apply a unified diff (single file) to a file you have read.",
    parameters: P({ path: S("file path"), diff: S("unified diff with @@ hunks") }, ["path", "diff"]),
    async guard(a, ctx) { return needRead(ctx, a) ?? (await staleCheck(ctx, a)); },
    async run({ path, diff }, ctx) {
      let r; try { r = await ctx.fs.applyPatch(path, diff); } catch (e) { return bad(`${e.message}. Re-read the file and regenerate the diff.`); }
      const v = await afterWrite(ctx, path, "patch");
      return ok(`Applied patch to ${path}. Verified on disk. ${v.syntax}`, { evidence: { kind: "fs-write", data: { path, hash: v.hash, size: v.text?.length ?? 0, action: "patch" } }, meta: { summary: v.syntax } });
    },
  },
  {
    name: "delete_file", group: "core", mutating: true, description: "Delete a file (recoverable via restore_version).", parameters: P({ path: S("file path") }, ["path"]),
    async run({ path }, ctx) { try { await ctx.fs.deleteFile(path); } catch (e) { return bad(e.message); } ctx.readSet.delete(path); await ctx.intel?.sync(); const gone = !ctx.fs.exists(path); return gone ? ok(`Deleted ${path}.`, { evidence: { kind: "fs-delete", data: { path } } }) : bad(`${path} still exists after delete`); },
  },
  {
    name: "move_file", group: "core", mutating: true, description: "Move or rename a file or directory.", parameters: P({ from: S("source"), to: S("destination") }, ["from", "to"]),
    async run({ from, to }, ctx) { try { await ctx.fs.move(from, to); } catch (e) { return bad(e.message); } for (const [p, h] of [...ctx.readSet]) if (p === from || p.startsWith(from + "/")) { ctx.readSet.delete(p); ctx.readSet.set(to + p.slice(from.length), h); } await ctx.intel?.sync(); return ctx.fs.exists(to) && !ctx.fs.exists(from) ? ok(`Moved ${from} → ${to}.`, { evidence: { kind: "fs-move", data: { from, path: to } } }) : bad("move did not take effect"); },
  },
  { name: "make_dir", group: "core", mutating: true, description: "Create a directory (and parents).", parameters: P({ path: S("directory") }, ["path"]), async run({ path }, ctx) { await ctx.fs.mkdir(path); return ok(`Directory ${path} exists.`); } },
  {
    name: "outline", group: "code", description: "List the symbols (functions, classes, methods, types) of a file with line ranges.", parameters: P({ path: S("file path") }, ["path"]),
    async run({ path }, ctx) { await ctx.intel?.sync(); const o = ctx.intel?.outline(path) ?? []; return o.length ? ok(o.map((s) => `${String(s.startLine).padStart(4)}-${s.endLine}  ${s.parent ? s.parent + "." : ""}${s.name} [${s.kind}]${s.exported ? " exported" : ""}  ${s.signature.slice(0, 100)}`).join("\n")) : ok("no symbols found (unsupported language or empty file)"); },
  },
  {
    name: "find_symbol", group: "code", description: "Find where a function/class/type is defined (fuzzy name match).", parameters: P({ name: S("symbol name"), kind: S("function|class|method|interface|type|const") }, ["name"]),
    async run({ name, kind }, ctx) { await ctx.intel?.sync(); const r = ctx.intel?.findSymbol(name, { kind, limit: 15 }) ?? []; return ok(r.length ? r.map((s) => `${s.path}:${s.startLine}  ${s.parent ? s.parent + "." : ""}${s.name} [${s.kind}]  ${s.signature.slice(0, 100)}`).join("\n") : `no symbol matching "${name}"`); },
  },
  {
    name: "references", group: "code", description: "Find where an identifier is used (lines).", parameters: P({ name: S("identifier") }, ["name"]),
    async run({ name }, ctx) { const r = await ctx.intel.references(name, { max: 60 }); return ok(r.length ? r.map((x) => `${x.path}:${x.line}: ${x.text}`).join("\n") : `no references to ${name}`); },
  },
  {
    name: "impact", group: "code", description: "What depends on this file? (reverse import graph) — check before changing shared code.", parameters: P({ path: S("file path") }, ["path"]),
    async run({ path }, ctx) { await ctx.intel?.sync(); const d = ctx.intel.symbols.dependencies(path), r = ctx.intel.impactOf(path, 4); return ok(`imports: ${d.join(", ") || "(none in project)"}\nexternal: ${ctx.intel.symbols.externalPackages(path).join(", ") || "(none)"}\nimpacted (transitive dependents): ${r.map((x) => `${x.path}@${x.distance}`).join(", ") || "(none)"}`); },
  },
  { name: "analyze_project", group: "code", description: "Detect languages, frameworks, build/test commands, entry points and code style.", parameters: P({}), async run(_, ctx) { const p = await ctx.intel.getProfile(); return ok(`${p.summary}\nManifests: ${p.manifests.join(", ") || "none"}\nDependencies: ${p.dependencies.runtime.slice(0, 20).join(", ") || "none"}`); } },
  {
    name: "check_syntax", group: "code", description: "Parse a file with its real grammar and report syntax errors.", parameters: P({ path: S("file path") }, ["path"]),
    async run({ path }, ctx) { const text = await ctx.fs.readFile(path); const e = await checkSyntax(ctx.intel?.symbols.runtime, path, text); return e === null ? ok("no grammar available for this file type; syntax NOT checked") : e.length ? bad(e.map((x) => `line ${x.line}:${x.column} ${x.message} ${x.text ? JSON.stringify(x.text) : ""}`).join("\n")) : ok("syntax OK"); },
  },
  {
    name: "file_history", group: "versions", description: "List saved versions of a file.", parameters: P({ path: S("file path") }, ["path"]),
    async run({ path }, ctx) { const h = ctx.fs.history(path); return ok(h.length ? h.map((v) => `v${v.n} ${new Date(v.ts).toISOString()} ${v.op} ${v.size}B${v.deleted ? " (deleted)" : ""}`).join("\n") : "no history"); },
  },
  {
    name: "diff_file", group: "versions", description: "Unified diff between a saved version and the current file.", parameters: P({ path: S("file path"), version: { type: "integer", minimum: 1 } }, ["path"]),
    async run({ path, version }, ctx) { const h = ctx.fs.history(path); if (!h.length) return bad("no history"); try { const d = await ctx.fs.diffVersions(path, version ?? h[h.length - 1].n); return ok(d || "no differences"); } catch (e) { return bad(e.message); } },
  },
  {
    name: "restore_version", group: "versions", mutating: true, description: "Restore a file to a saved version.", parameters: P({ path: S("file path"), version: { type: "integer", minimum: 1 } }, ["path", "version"]),
    async run({ path, version }, ctx) { try { await ctx.fs.restore(path, version); } catch (e) { return bad(e.message); } const v = await afterWrite(ctx, path, "restore"); return ok(`Restored ${path} to v${version}. ${v.syntax}`, { evidence: { kind: "fs-write", data: { path, hash: v.hash, size: v.text?.length ?? 0, action: "restore" } } }); },
  },
  { name: "snapshot", group: "versions", mutating: true, description: "Save a named snapshot of the whole project.", parameters: P({ label: S("snapshot label") }), async run({ label = "" }, ctx) { const s = await ctx.fs.snapshot(label); return ok(`Snapshot ${s.id} saved (${s.files} files).`); } },
  {
    name: "recall", group: "core", description: "Retrieve earlier conversation details: pass a segment ref like #42 or #40-45, or a search query.", parameters: P({ query: S("#n, #a-b, or search text") }, ["query"]),
    async run({ query }, ctx) { return ok(await ctx.engine.recall(query)); },
  },
  {
    name: "remember", group: "memory", description: "Save a durable user preference/fact. Only when the user asks you to remember something.", parameters: P({ text: S("what to remember") }, ["text"]),
    async run({ text }, ctx) { const r = await ctx.memory.remember(text, { force: true, source: "user-request" }); return r.stored ? ok("Remembered.") : bad(`Not stored: ${r.reason}`); },
  },
];

export { afterWrite };
