// Shared harness for browser tests: build output served under a Pages-style subpath + a fake OpenAI-compatible endpoint.
import { chromium } from "playwright-core";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../../scripts/serve.mjs";
import { existsSync, readdirSync } from "node:fs";

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
export function chromePath() {
  if (process.env.BARIX_BROWSER && existsSync(process.env.BARIX_BROWSER)) return process.env.BARIX_BROWSER;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try { for (const d of readdirSync(root)) if (/^chromium-/.test(d)) { const p = path.join(root, d, "chrome-linux", "chrome"); if (existsSync(p)) return p; } } catch {}
  return null;
}
export async function launch(extraArgs = []) {
  return chromium.launch({ ...(chromePath() ? { executablePath: chromePath() } : {}), headless: true, args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", ...extraArgs] });
}
export const site = (base = "/BarixAI/") => serve({ dir: DIST, base });

/** Fake OpenAI-compatible server. `replies`: array of strings or fn(body)=>string, consumed per request. */
export async function fakeEndpoint(replies, { window = 32768 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (req.url.endsWith("/models")) { res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "qwen3.5-4b" }] })); }
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = JSON.parse(body); calls.push(j); const next = replies.shift(); const text = typeof next === "function" ? next(j) : next ?? "(no more scripted replies)";
      res.writeHead(200, { ...cors, "content-type": "text/event-stream" });
      for (let i = 0; i < text.length; i += 24) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 24) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`); res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: Math.ceil(text.length / 4) } })}\n\ndata: [DONE]\n\n`); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/v1`, calls, replies, window, close: () => new Promise((c) => server.close(c)) };
}
/** Open Barix with a scripted endpoint pre-configured and no local model. */
export async function openBarix(browser, siteUrl, endpoint, { project = "t" + Math.random().toString(36).slice(2, 7), storageState } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, storageState }); const page = await ctx.newPage(); const errors = []; const logs = [];
  page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); else logs.push(m.text()); });
  await page.addInitScript(({ ep, project }) => { if (window.top !== window) return; if (!localStorage.getItem("barix.__seeded")) { localStorage.setItem("barix.__seeded", "1"); localStorage.setItem("barix.localModel", "false"); localStorage.setItem("barix.projects", JSON.stringify([{ id: project, name: "Test", kind: "opfs" }])); localStorage.setItem("barix.project", project); if (ep) localStorage.setItem("barix.endpoints", JSON.stringify([{ id: "local:fake", baseUrl: ep.url, model: "qwen3.5-4b", window: ep.window, local: true, vision: true }])); } }, { ep: endpoint, project });
  await page.goto(siteUrl); await page.waitForFunction(() => window.__barix?.brain && window.__barix.lastStatus, null, { timeout: 30000 });
  return { ctx, page, errors, logs };
}
export const call = (tool, args) => `<barix:call tool="${tool}">${JSON.stringify(args)}</barix:call>`;
export async function sendAndWait(page, text, { timeout = 60000 } = {}) {
  await page.fill("#input", text); await page.click("#btn-send"); await page.waitForSelector("#btn-send:not([hidden])", { timeout, state: "attached" }); await page.waitForFunction(() => !window.__barix.busy, null, { timeout });
}
