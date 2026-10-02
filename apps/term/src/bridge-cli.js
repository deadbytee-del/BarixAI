// `barixterm bridge`: start the local Barix Bridge for the browser app.
import { createBridge, loadOrCreateToken, DEFAULT_PORT, DEFAULT_ORIGINS } from "./bridge.js";
import { githubToken, detectLocalServers } from "./providers-setup.js";
import { trustSystemNetwork } from "./net.js";
import * as UI from "./ui.js";

export async function bridgeCommand({ f, out, VERSION }) {
  trustSystemNetwork();
  const token = f.token && String(f.token).length >= 12 ? String(f.token) : await loadOrCreateToken(); const port = f.port ? +f.port : DEFAULT_PORT;
  const origins = [...DEFAULT_ORIGINS, ...(f.origin ? [].concat(f.origin).map(String) : [])];
  let gt; try { gt = await githubToken(); } catch { /* none */ }
  let llm = null; // a local model server (much bigger than what fits in a browser tab) the web app can use through the bridge
  if (!f["no-llm"]) { if (f.llm) llm = { name: "custom", baseUrl: String(f.llm), model: String(f["llm-model"] ?? ""), window: +(f["llm-window"] ?? 8192) }; else { const s = (await detectLocalServers())[0]; if (s) llm = { name: s.name, baseUrl: s.baseUrl, model: s.model, window: s.window ?? +(f["llm-window"] ?? 8192) }; } }
  const b = createBridge({ token, port, origins, llm, githubToken: () => gt, version: VERSION, log: (m) => out(UI.hint(m)) });
  let actual; try { actual = await b.listen(); } catch (e) { return out(`✗ could not start the bridge on port ${port}: ${e.message}${e.code === "EADDRINUSE" ? " (is it already running? try --port 8800)" : ""}`); }
  const url = `http://127.0.0.1:${actual}`;
  out(UI.banner(VERSION));
  out(UI.box("Barix Bridge", [
    UI.kv("address", UI.paint(UI.S.white, url)), UI.kv("pairing", UI.paint(UI.S.white, token)),
    UI.kv("internet", "web search + page reading (public sites only)"), UI.kv("github", gt ? "your GitHub login is available (read-only; the token never leaves this PC)" : UI.paint(UI.S.warn, "no GitHub login found — run `gh auth login` or set GITHUB_TOKEN for private repos")),
    UI.kv("model", llm ? `${llm.name}: ${llm.model} (window ${llm.window}) — the web app will use it` : UI.paint(UI.S.mute, "no local server found (start Ollama / llama.cpp / LM Studio for a much smarter web chat)")),
    UI.kv("allowed", origins.join(", ")),
  ]));
  out(`\n${UI.hint("In the Barix web app: Settings → Barix Bridge → paste the address and pairing code → Connect. Keep this window open. Ctrl-C stops it.")}`);
  await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  await b.close(); out("\nBridge stopped.");
}
