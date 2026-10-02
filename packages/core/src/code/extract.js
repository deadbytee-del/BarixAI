// Symbol / import / export / syntax-error extraction.
// Primary path: real tree-sitter ASTs. Fallback: a line scanner (used when WASM grammars are unavailable
// or for languages without a grammar). Results are tagged with `parser` so callers know which one ran.
import { languageFor } from "./languages.js";

/** @typedef {{name:string, kind:string, startLine:number, endLine:number, signature:string, parent?:string, exported?:boolean, doc?:string}} Sym */

const firstLine = (t, max = 200) => { const l = t.split("\n")[0].replace(/\s*[{:]\s*$/, "").trim(); return l.length > max ? l.slice(0, max) + "…" : l; };
const unquote = (s) => s.replace(/^[\s'"`]+|[\s'"`;]+$/g, "");

export async function extractFile(runtime, path, text) {
  const lang = languageFor(path);
  if (!lang) return { language: null, symbols: [], imports: [], exports: [], errors: [], parser: "none" };
  if (lang.grammar && runtime) {
    const r = await runtime.withTree(lang.grammar, text, (root) => treeExtract(lang, root, text));
    if (r) return { language: lang.id, ...r, parser: "tree-sitter" };
  }
  return { language: lang.id, ...scanExtract(lang, text), parser: "scanner" };
}

// ---------------------------------------------------------------- tree-sitter
const JS_FUNC_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function treeExtract(lang, root, text) {
  const symbols = [], imports = [], exports = [];
  const emit = (node, name, kind, ctx, extra = {}) => {
    if (!name) return;
    const prev = (ctx.docNode ?? node).previousNamedSibling;
    const docRef = ctx.docNode ?? node;
    let doc;
    if (prev && /comment/.test(prev.type) && prev.endPosition.row >= docRef.startPosition.row - 1) doc = prev.text.replace(/^\s*(\/\*\*?|\/\/\/?|#|\*)+\s*|\s*\*\/\s*$/gm, "").trim().split("\n")[0].slice(0, 160);
    symbols.push({ name, kind, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, signature: firstLine(node.text), parent: ctx.parent, exported: ctx.exported ?? extra.exported ?? false, ...(doc ? { doc } : {}), ...extra });
  };
  const name = (n) => n.childForFieldName("name")?.text;
  const family = lang.family;

  const walkers = {
    js(node, ctx) {
      for (const c of node.namedChildren) {
        switch (c.type) {
          case "export_statement": {
            const decl = c.childForFieldName("declaration");
            if (decl) walkers.js({ namedChildren: [decl] }, { ...ctx, exported: true, docNode: c });
            else if (c.text.startsWith("export default")) { const v = c.childForFieldName("value"); if (v) emit(c, v.type === "identifier" ? v.text : "default", "default-export", { ...ctx, exported: true }); }
            const src = c.childForFieldName("source");
            if (src) imports.push({ spec: unquote(src.text), kind: "reexport", line: c.startPosition.row + 1 });
            for (const sp of c.descendantsOfType?.("export_specifier") ?? []) exports.push({ name: (sp.childForFieldName("alias") ?? sp.childForFieldName("name"))?.text, line: sp.startPosition.row + 1 });
            break;
          }
          case "function_declaration": case "generator_function_declaration": emit(c, name(c), "function", ctx); break;
          case "class_declaration": case "abstract_class_declaration": case "class": {
            const n = name(c); emit(c, n, "class", ctx);
            const body = c.childForFieldName("body"); if (body) walkers.js(body, { parent: n, exported: false, inClass: true });
            break;
          }
          case "interface_declaration": { const n = name(c); emit(c, n, "interface", ctx); const b = c.childForFieldName("body"); if (b) walkers.js(b, { parent: n, exported: false, inClass: true }); break; }
          case "type_alias_declaration": emit(c, name(c), "type", ctx); break;
          case "enum_declaration": emit(c, name(c), "enum", ctx); break;
          case "internal_module": case "module": { const n = name(c); emit(c, n, "namespace", ctx); const b = c.childForFieldName("body"); if (b) walkers.js(b, { parent: n, exported: false }); break; }
          case "method_definition": case "method_signature": case "abstract_method_signature": emit(c, name(c), ctx.parent ? "method" : "function", ctx); break;
          case "public_field_definition": case "field_definition": case "property_signature": {
            const v = c.childForFieldName("value");
            emit(c, name(c) ?? c.childForFieldName("property")?.text, v && JS_FUNC_VALUES.has(v.type) ? "method" : "property", ctx); break;
          }
          case "lexical_declaration": case "variable_declaration": {
            if (ctx.parent || ctx.nested) break;
            for (const d of c.namedChildren) {
              if (d.type !== "variable_declarator") continue;
              const v = d.childForFieldName("value"), n = d.childForFieldName("name");
              if (!n || n.type !== "identifier") continue;
              const isFn = v && JS_FUNC_VALUES.has(v.type), isCls = v && v.type === "class";
              symbols.push({ name: n.text, kind: isFn ? "function" : isCls ? "class" : c.text.startsWith("const") ? "const" : "variable", startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1, signature: firstLine(c.text), exported: ctx.exported ?? false });
            }
            break;
          }
          case "import_statement": {
            const src = c.childForFieldName("source");
            if (src) imports.push({ spec: unquote(src.text), kind: "import", names: (c.namedChildren.find((x) => x.type === "import_clause")?.text ?? "").slice(0, 200), line: c.startPosition.row + 1 });
            break;
          }
          case "expression_statement": case "namespace_export": break;
          case "statement_block": case "program": walkers.js(c, { ...ctx, nested: ctx.nested }); break;
        }
      }
      if (node.type === "program" || node.descendantsOfType) {
        // CommonJS & dynamic imports anywhere in file
        if (node.type === "program") for (const call of node.descendantsOfType("call_expression")) {
          const fn = call.childForFieldName("function"), args = call.childForFieldName("arguments");
          const a0 = args?.namedChildren?.[0];
          if (fn && a0 && a0.type === "string" && (fn.text === "require" || fn.type === "import")) imports.push({ spec: unquote(a0.text), kind: fn.text === "require" ? "require" : "dynamic", line: call.startPosition.row + 1 });
        }
      }
    },
    py(node, ctx) {
      for (const c of node.namedChildren) {
        if (c.type === "decorated_definition") { const d = c.childForFieldName("definition"); if (d) walkers.py({ namedChildren: [d] }, ctx); continue; }
        if (c.type === "function_definition") emit(c, name(c), ctx.parent ? "method" : "function", { ...ctx, exported: !name(c)?.startsWith("_") });
        else if (c.type === "class_definition") { const n = name(c); emit(c, n, "class", { ...ctx, exported: !n?.startsWith("_") }); const b = c.childForFieldName("body"); if (b) walkers.py(b, { parent: n }); }
        else if (c.type === "expression_statement" && !ctx.parent) {
          const a = c.namedChildren[0]; const l = a?.type === "assignment" ? a.childForFieldName("left") : null;
          if (l?.type === "identifier" && /^[A-Z][A-Z0-9_]*$/.test(l.text)) emit(c, l.text, "const", { ...ctx, exported: true });
        } else if (c.type === "import_statement") {
          for (const n of c.namedChildren) imports.push({ spec: (n.type === "aliased_import" ? n.childForFieldName("name") : n).text, kind: "import", line: c.startPosition.row + 1 });
        } else if (c.type === "import_from_statement") {
          const m = c.childForFieldName("module_name"); if (m) imports.push({ spec: m.text, kind: "from", names: c.namedChildren.slice(1).map((x) => x.text).join(", ").slice(0, 200), line: c.startPosition.row + 1 });
        } else if (["if_statement", "try_statement", "with_statement"].includes(c.type) && !ctx.parent) walkers.py(c.childForFieldName("consequence") ?? c.childForFieldName("body") ?? { namedChildren: [] }, ctx);
      }
    },
    go(node, ctx) {
      for (const c of node.namedChildren) {
        if (c.type === "function_declaration") emit(c, name(c), "function", { exported: /^[A-Z]/.test(name(c) ?? "") });
        else if (c.type === "method_declaration") { const r = c.childForFieldName("receiver")?.text.replace(/[()*]|\w+\s+/g, "").trim(); emit(c, name(c), "method", { parent: r, exported: /^[A-Z]/.test(name(c) ?? "") }); }
        else if (c.type === "type_declaration") for (const s of c.namedChildren) { if (s.type === "type_spec") { const t = s.childForFieldName("type")?.type; emit(s, name(s), t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type", { exported: /^[A-Z]/.test(name(s) ?? "") }); } }
        else if (c.type === "const_declaration" || c.type === "var_declaration") for (const s of c.namedChildren) { const n = s.namedChildren.find((x) => x.type === "identifier"); if (n) emit(s, n.text, "const", { exported: /^[A-Z]/.test(n.text) }); }
        else if (c.type === "import_declaration") for (const s of c.descendantsOfType("import_spec")) imports.push({ spec: unquote(s.childForFieldName("path")?.text ?? ""), kind: "import", line: s.startPosition.row + 1 });
      }
    },
    rust(node, ctx) {
      for (const c of node.namedChildren) {
        const exp = c.namedChildren.some((x) => x.type === "visibility_modifier");
        const kinds = { function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "trait", const_item: "const", static_item: "const", type_item: "type", macro_definition: "macro", union_item: "struct" };
        if (kinds[c.type]) { const n = name(c); emit(c, n, ctx.parent && c.type === "function_item" ? "method" : kinds[c.type], { ...ctx, exported: exp }); if (c.type === "trait_item") { const b = c.childForFieldName("body"); if (b) walkers.rust(b, { parent: n }); } }
        else if (c.type === "impl_item") { const t = c.childForFieldName("type")?.text; emit(c, t, "impl", { ...ctx, exported: false }); const b = c.childForFieldName("body"); if (b) walkers.rust(b, { parent: t }); }
        else if (c.type === "mod_item") { const n = name(c); emit(c, n, "module", { ...ctx, exported: exp }); const b = c.childForFieldName("body"); if (b) walkers.rust(b, { parent: n }); }
        else if (c.type === "use_declaration") imports.push({ spec: (c.childForFieldName("argument")?.text ?? "").slice(0, 200), kind: "use", line: c.startPosition.row + 1 });
      }
    },
    java(node, ctx) {
      for (const c of node.namedChildren) {
        const mods = c.namedChildren.find((x) => x.type === "modifiers")?.text ?? ""; const exp = /\bpublic\b/.test(mods);
        const kinds = { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "record", annotation_type_declaration: "annotation" };
        if (kinds[c.type]) { const n = name(c); emit(c, n, kinds[c.type], { ...ctx, exported: exp }); const b = c.childForFieldName("body"); if (b) walkers.java(b, { parent: n }); }
        else if (c.type === "method_declaration" || c.type === "constructor_declaration") emit(c, name(c), c.type === "constructor_declaration" ? "constructor" : "method", { ...ctx, exported: exp });
        else if (c.type === "import_declaration") imports.push({ spec: c.text.replace(/^import\s+(static\s+)?|;\s*$/g, ""), kind: "import", line: c.startPosition.row + 1 });
        else if (c.type === "package_declaration") continue;
      }
    },
    cs(node, ctx) {
      for (const c of node.namedChildren) {
        const kinds = { class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", enum_declaration: "enum", record_declaration: "record", method_declaration: "method", constructor_declaration: "constructor", property_declaration: "property" };
        const mods = c.namedChildren.filter((x) => x.type === "modifier").map((x) => x.text).join(" ");
        if (kinds[c.type]) { const n = name(c); emit(c, n, kinds[c.type], { ...ctx, exported: /\bpublic\b/.test(mods) }); const b = c.childForFieldName("body"); if (b && ["class_declaration", "interface_declaration", "struct_declaration", "record_declaration"].includes(c.type)) walkers.cs(b, { parent: n }); }
        else if (c.type === "namespace_declaration" || c.type === "file_scoped_namespace_declaration") { const b = c.childForFieldName("body"); walkers.cs(b ?? c, ctx); }
        else if (c.type === "using_directive") imports.push({ spec: c.text.replace(/^using\s+|;\s*$/g, ""), kind: "using", line: c.startPosition.row + 1 });
        else if (c.type === "declaration_list") walkers.cs(c, ctx);
      }
    },
    c(node, ctx) {
      const declName = (d) => { let n = d; while (n && n.childForFieldName?.("declarator")) n = n.childForFieldName("declarator"); return n?.text; };
      for (const c of node.namedChildren) {
        if (c.type === "function_definition") emit(c, declName(c.childForFieldName("declarator")), ctx.parent ? "method" : "function", ctx);
        else if (["struct_specifier", "class_specifier", "enum_specifier", "union_specifier"].includes(c.type) && c.childForFieldName("body")) { const n = name(c); emit(c, n, c.type.split("_")[0], ctx); if (c.type === "class_specifier") walkers.c(c.childForFieldName("body"), { parent: n }); }
        else if (c.type === "type_definition") { const d = c.childForFieldName("declarator")?.text; emit(c, d, "type", ctx); }
        else if (c.type === "namespace_definition") { const b = c.childForFieldName("body"); if (b) walkers.c(b, { parent: name(c) }); }
        else if (c.type === "preproc_def" || c.type === "preproc_function_def") emit(c, name(c), "macro", ctx);
        else if (c.type === "preproc_include") imports.push({ spec: unquote(c.childForFieldName("path")?.text ?? "").replace(/[<>]/g, ""), kind: "include", line: c.startPosition.row + 1 });
        else if (c.type === "declaration_list" || c.type === "template_declaration" || c.type === "linkage_specification") walkers.c(c, ctx);
        else if (c.type === "field_declaration_list") walkers.c(c, ctx);
      }
    },
    rb(node, ctx) {
      for (const c of node.namedChildren) {
        if (c.type === "method" || c.type === "singleton_method") emit(c, name(c), ctx.parent ? "method" : "function", ctx);
        else if (c.type === "class" || c.type === "module") { const n = name(c); emit(c, n, c.type, ctx); walkers.rb(c, { parent: n }); }
        else if (c.type === "call" || c.type === "command") { /* require */ }
        else if (c.type === "body_statement") walkers.rb(c, ctx);
      }
      for (const call of node.descendantsOfType?.("call") ?? []) { const m = call.childForFieldName("method")?.text; if (/^require(_relative)?$/.test(m ?? "")) { const a = call.childForFieldName("arguments")?.namedChildren?.[0]; if (a) imports.push({ spec: unquote(a.text), kind: m, line: call.startPosition.row + 1 }); } }
    },
    php(node, ctx) {
      for (const c of node.namedChildren) {
        const kinds = { function_definition: "function", class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait", method_declaration: "method", enum_declaration: "enum" };
        if (kinds[c.type]) { const n = name(c); emit(c, n, kinds[c.type], ctx); const b = c.childForFieldName("body"); if (b && c.type !== "function_definition" && c.type !== "method_declaration") walkers.php(b, { parent: n }); }
        else if (c.type === "namespace_use_declaration") imports.push({ spec: c.text.replace(/^use\s+|;\s*$/g, ""), kind: "use", line: c.startPosition.row + 1 });
        else if (c.type === "declaration_list" || c.type === "namespace_definition") walkers.php(c, ctx);
      }
    },
    sh(node) { for (const c of node.namedChildren) if (c.type === "function_definition") emit(c, name(c), "function", {}); },
    css(node) {
      for (const c of node.namedChildren) if (c.type === "rule_set") { const sel = c.namedChildren[0]?.text; if (sel) emit(c, sel.replace(/\s+/g, " ").slice(0, 80), "rule", {}); } else if (c.type === "import_statement") imports.push({ spec: unquote(c.namedChildren.find((x) => /string/.test(x.type))?.text ?? ""), kind: "import", line: c.startPosition.row + 1 });
    },
  };
  (walkers[family] ?? (() => {}))(root, {});
  if (family === "js") { for (const s of symbols) if (s.exported && !s.parent) exports.push({ name: s.name, kind: s.kind, line: s.startLine }); }
  else if (family === "py" || family === "go" || family === "rust" || family === "java" || family === "cs") for (const s of symbols) if (s.exported && !s.parent) exports.push({ name: s.name, kind: s.kind, line: s.startLine });
  return { symbols, imports, exports: dedupeBy(exports, (e) => e.name), errors: syntaxErrors(root) };
}

const dedupeBy = (arr, f) => { const s = new Set(); return arr.filter((x) => { const k = f(x); if (s.has(k)) return false; s.add(k); return true; }); };

/** Collect ERROR / MISSING nodes (pruned by hasError so clean subtrees cost nothing). */
export function syntaxErrors(root, max = 20) {
  const out = [];
  const visit = (n) => {
    if (out.length >= max) return;
    if (n.isMissing) { out.push({ line: n.startPosition.row + 1, column: n.startPosition.column + 1, message: `missing ${n.type}`, text: "" }); return; }
    if (n.type === "ERROR") { out.push({ line: n.startPosition.row + 1, column: n.startPosition.column + 1, message: "syntax error", text: n.text.slice(0, 80) }); return; }
    if (!n.hasError) return;
    for (const c of n.children) visit(c);
  };
  if (root.hasError) visit(root);
  return out;
}

/** Syntax-check a file with its real grammar. Returns null when no grammar is available. */
export async function checkSyntax(runtime, path, text) {
  const lang = languageFor(path);
  if (!lang?.grammar || !runtime) return null;
  const r = await runtime.withTree(lang.grammar, text, (root) => syntaxErrors(root));
  return r ?? null;
}

// ---------------------------------------------------------------- scanner fallback
const SCAN = {
  js: [
    [/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function", 2, 1],
    [/^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class", 2, 1],
    [/^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface", 2, 1],
    [/^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, "type", 2, 1],
    [/^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum", 2, 1],
    [/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function", 2, 1],
    [/^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, "const", 2, 1],
  ],
  py: [[/^(\s*)(?:async\s+)?def\s+(\w+)/, "function", 2], [/^(\s*)class\s+(\w+)/, "class", 2]],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/, "function", 1], [/^type\s+(\w+)\s+(struct|interface)/, "type", 1]],
  rust: [[/^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, "function", 2, 1], [/^\s*(pub\s+)?(struct|enum|trait)\s+(\w+)/, "type", 3, 1], [/^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/, "impl", 1]],
  java: [[/^\s*(public\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+(\w+)/, "class", 2, 1]],
  c: [[/^\s*(?:[\w:*&<>]+\s+)+\**([A-Za-z_]\w*)\s*\([^;]*$/, "function", 1], [/^\s*(?:typedef\s+)?(?:struct|class|enum)\s+(\w+)/, "type", 1]],
  cs: [[/^\s*(public\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/, "class", 2, 1]],
  rb: [[/^\s*def\s+(?:self\.)?(\w+[?!=]?)/, "function", 1], [/^\s*(class|module)\s+(\w+)/, "class", 2]],
  php: [[/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)/, "function", 1], [/^\s*(?:abstract\s+)?(?:class|interface|trait)\s+(\w+)/, "class", 1]],
  sh: [[/^\s*(?:function\s+)?(\w+)\s*\(\)\s*\{?/, "function", 1]],
  css: [], markup: [], data: [], doc: [],
};
const SCAN_IMPORT = {
  js: [/^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/, /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/, /^\s*export\s+[^'"]*from\s+['"]([^'"]+)['"]/],
  py: [/^\s*import\s+([\w.]+)/, /^\s*from\s+([\w.]+)\s+import/],
  go: [/^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/],
  rust: [/^\s*use\s+([^;]+);/],
  java: [/^\s*import\s+(?:static\s+)?([\w.*]+);/],
  c: [/^\s*#\s*include\s*[<"]([^>"]+)[>"]/],
  cs: [/^\s*using\s+([\w.]+);/], rb: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/], php: [/^\s*use\s+([\w\\]+)/],
};

export function scanExtract(lang, text) {
  const lines = text.split("\n"), symbols = [], imports = [], exports = [];
  const rules = SCAN[lang.family] ?? [];
  const impRes = SCAN_IMPORT[lang.family] ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of impRes) { const m = re.exec(line); if (m) { imports.push({ spec: m[1].trim(), kind: "import", line: i + 1 }); break; } }
    for (const [re, kind, ng, eg] of rules) {
      const m = re.exec(line); if (!m || !m[ng]) continue;
      const indent = lang.indent ? (m[1] ?? "").length : /^\s*/.exec(line)[0].length;
      if (lang.family === "js" && indent > 0 && !/^\s*export\b/.test(line)) break; // skip nested locals
      const endLine = endOf(lines, i, lang);
      const exported = eg ? !!m[eg] : lang.family === "py" ? !m[ng].startsWith("_") : lang.family === "go" ? /^[A-Z]/.test(m[ng]) : false;
      symbols.push({ name: m[ng], kind, startLine: i + 1, endLine, signature: firstLine(line), exported, ...(lang.indent && indent > 0 ? { parent: nearestParent(symbols, indent, i + 1, lines) } : {}) });
      break;
    }
  }
  for (const s of symbols) if (s.exported && !s.parent) exports.push({ name: s.name, kind: s.kind, line: s.startLine });
  return { symbols, imports, exports, errors: [] };
}
function nearestParent(symbols, indent, line) {
  for (let i = symbols.length - 1; i >= 0; i--) if (symbols[i].kind === "class" && symbols[i].endLine >= line) return symbols[i].name;
  return undefined;
}
function endOf(lines, i, lang) {
  if (lang.indent) {
    const base = /^\s*/.exec(lines[i])[0].length;
    let last = i;
    for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim()) continue; if (/^\s*/.exec(lines[j])[0].length <= base) break; last = j; }
    return last + 1;
  }
  if (lang.family === "rb") { const base = /^\s*/.exec(lines[i])[0].length; for (let j = i + 1; j < lines.length; j++) if (/^\s*end\b/.test(lines[j]) && /^\s*/.exec(lines[j])[0].length === base) return j + 1; return i + 1; }
  let depth = 0, seen = false;
  for (let j = i; j < Math.min(lines.length, i + 4000); j++) {
    const s = lines[j].replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$/g, "");
    for (const ch of s) { if (ch === "{") { depth++; seen = true; } else if (ch === "}") depth--; }
    if (seen && depth <= 0) return j + 1;
    if (!seen && j > i && /;\s*$/.test(lines[j])) return j + 1;
    if (!seen && j === i && /;\s*$/.test(lines[j])) return j + 1;
  }
  return i + 1;
}
