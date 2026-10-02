// Tree-sitter runtime wrapper. The loader is injected so the same code works in Node
// (read from node_modules) and in the browser (fetch bundled .wasm assets).
//
//   const ts = new TreeSitterRuntime({ loadModule, loadGrammar })
//   loadModule()          -> the web-tree-sitter module ({Parser, Language})
//   loadGrammar(name)     -> Uint8Array | ArrayBuffer | URL string for tree-sitter-<name>.wasm
//   locateFile(file)      -> where the core tree-sitter.wasm lives
//
// Parse trees live in WASM memory and must be freed: `withTree` guarantees `.delete()`.
export class TreeSitterRuntime {
  constructor({ loadModule, loadGrammar, locateFile }) {
    this.loadModule = loadModule; this.loadGrammar = loadGrammar; this.locateFile = locateFile;
    this.mod = null; this.parsers = new Map(); this.failed = new Set(); this._init = null;
  }
  async #boot() {
    if (!this._init) this._init = (async () => {
      let m = await this.loadModule(); m = m.default ?? m;
      await m.Parser.init(this.locateFile ? { locateFile: this.locateFile } : undefined);
      this.mod = m;
    })();
    return this._init;
  }
  /** Returns a ready parser for a grammar name, or null if unavailable (callers fall back to the scanner). */
  async parserFor(grammar) {
    if (!grammar || this.failed.has(grammar)) return null;
    if (this.parsers.has(grammar)) return this.parsers.get(grammar);
    try {
      await this.#boot();
      const lang = await this.mod.Language.load(await this.loadGrammar(grammar));
      const p = new this.mod.Parser(); p.setLanguage(lang);
      this.parsers.set(grammar, p); return p;
    } catch (e) { this.failed.add(grammar); this.lastError = e; return null; }
  }
  /** Parse `text`, run `fn(rootNode)`, always free the tree. Returns undefined if no grammar. */
  async withTree(grammar, text, fn) {
    const p = await this.parserFor(grammar); if (!p) return undefined;
    const tree = p.parse(text);
    try { return fn(tree.rootNode); } finally { tree.delete(); }
  }
}

/** Node loader: uses the grammars bundled with @vscode/tree-sitter-wasm. */
export async function nodeTreeSitter() {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@vscode/tree-sitter-wasm");
  const dir = dirname(entry);
  return new TreeSitterRuntime({
    loadModule: () => require(entry),
    locateFile: (f) => join(dir, f),
    loadGrammar: (n) => readFile(join(dir, `tree-sitter-${n}.wasm`)),
  });
}
