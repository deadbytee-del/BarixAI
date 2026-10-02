// End-to-end with a REAL foundation model: Barix fixes a bug in a tiny project, verified by real test execution.
// usage: node scripts/real-agent-demo.mjs [modelId=onnx-community/Qwen3.5-0.8B-ONNX] [dtype=q4] [window=8192]
import { createBarix, TransformersProvider, nodeTransformers, nodeTreeSitter, MemoryBackend } from "../packages/core/src/index.js";
import { runTestsTool } from "../packages/core/test/helpers.js";
const [model = "onnx-community/Qwen3.5-0.8B-ONNX", dtype = "q4", window = "8192"] = process.argv.slice(2);
const tf = await nodeTransformers({ cacheDir: new URL("../.cache/hf", import.meta.url).pathname });
const provider = new TransformersProvider({ loadTransformers: async () => tf, model, dtype, device: "cpu", window: +window, maxOutput: 700, quality: 0.5 });
const t0 = Date.now(); await provider.load(); console.log(`model loaded in ${Date.now() - t0}ms`);
const b = await createBarix({ backend: new MemoryBackend(), runtime: await nodeTreeSitter(), providers: [provider], tools: [runTestsTool()], capabilities: { exec: true }, persist: false, exactTokens: await provider.exactCounter() });
await b.fs.writeFile("package.json", JSON.stringify({ name: "calc", scripts: { test: "node test.js" } }));
await b.fs.writeFile("src/calc.js", "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n");
await b.fs.writeFile("test.js", "import { add, mul } from './src/calc.js';\nif (add(2, 3) !== 5) { console.error('FAIL add(2,3) =', add(2, 3)); process.exit(1); }\nif (mul(2, 3) !== 6) process.exit(1);\nconsole.log('ok: 2 tests passed');\n");
await b.intel.sync();
const request = process.env.REQ ?? "The add function in src/calc.js is wrong: add(2, 3) should return 5. Fix it and run the tests.";
console.log("USER:", request); let tok = 0;
const r = await b.ask(request, { onEvent: (e) => {
  if (e.type === "plan") console.log("PLAN:", e.plan.explain);
  else if (e.type === "tools") console.log("TOOLS:", e.tools.join(", "));
  else if (e.type === "context") console.log(`CONTEXT step ${e.step}: ${e.report.promptTokens}/${e.report.window} tokens`, JSON.stringify(e.report.sections));
  else if (e.type === "tool") console.log(`TOOL ${e.tool} ${JSON.stringify(e.args).slice(0, 120)} → ${e.ok ? "ok" : "FAIL"} ${e.ms | 0}ms: ${String(e.summary).slice(0, 100)}`);
  else if (e.type === "gate") console.log("GATE:", e.action);
  else if (e.type === "verification") console.log("VERIFY:", JSON.stringify(e.result));
  else if (e.type === "token") tok++;
} });
console.log("\n=== BARIX ANSWER ===\n" + r.text + "\n====================");
console.log(JSON.stringify({ ok: r.ok, steps: r.steps, corrections: r.corrections, usage: r.usage, changedFiles: r.changedFiles, seconds: r.ms / 1000 }, null, 1));
console.log("src/calc.js on disk now:\n" + await b.fs.readFile("src/calc.js"));
