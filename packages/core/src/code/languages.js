// Language registry: file extension -> language id -> tree-sitter grammar + extraction rules.
const L = (id, grammar, exts, extra = {}) => ({ id, grammar, exts, ...extra });

export const LANGUAGES = [
  L("javascript", "javascript", [".js", ".mjs", ".cjs", ".jsx"], { comment: "//", family: "js" }),
  L("typescript", "typescript", [".ts", ".mts", ".cts"], { comment: "//", family: "js" }),
  L("tsx", "tsx", [".tsx"], { comment: "//", family: "js" }),
  L("python", "python", [".py", ".pyi"], { comment: "#", family: "py", indent: true }),
  L("go", "go", [".go"], { comment: "//", family: "go" }),
  L("rust", "rust", [".rs"], { comment: "//", family: "rust" }),
  L("java", "java", [".java"], { comment: "//", family: "java" }),
  L("c", "cpp", [".c", ".h"], { comment: "//", family: "c" }),
  L("cpp", "cpp", [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], { comment: "//", family: "c" }),
  L("csharp", "c-sharp", [".cs"], { comment: "//", family: "cs" }),
  L("ruby", "ruby", [".rb"], { comment: "#", family: "rb" }),
  L("php", "php", [".php"], { comment: "//", family: "php" }),
  L("css", "css", [".css", ".scss"], { comment: "/*", family: "css" }),
  L("bash", "bash", [".sh", ".bash"], { comment: "#", family: "sh" }),
  L("html", null, [".html", ".htm"], { comment: "<!--", family: "markup" }),
  L("json", null, [".json", ".jsonc"], { family: "data" }),
  L("yaml", null, [".yml", ".yaml"], { comment: "#", family: "data" }),
  L("toml", null, [".toml"], { comment: "#", family: "data" }),
  L("markdown", null, [".md", ".mdx", ".markdown"], { family: "doc" }),
  L("text", null, [".txt", ".rst"], { family: "doc" }),
];

const byExt = new Map();
for (const l of LANGUAGES) for (const e of l.exts) byExt.set(e, l);
const byId = new Map(LANGUAGES.map((l) => [l.id, l]));

export function languageFor(path) {
  const i = path.lastIndexOf(".");
  const ext = i > path.lastIndexOf("/") ? path.slice(i).toLowerCase() : "";
  return byExt.get(ext) ?? null;
}
export const languageById = (id) => byId.get(id) ?? null;
export const isCode = (path) => { const l = languageFor(path); return !!l && !["data", "doc", "markup"].includes(l.family); };
