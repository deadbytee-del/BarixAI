// Browser capability for BarixTerm: render a page in the user's own Chrome/Edge/Chromium (headless) and return a PNG.
// No bundled browser, no extra npm dependency: every Windows machine has Edge; macOS/Linux usually have Chrome/Chromium.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CANDIDATES = {
  win32: [process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"), process.env.ProgramFiles && join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"), process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"), process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe")],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"],
};
export function findBrowser() {
  if (process.env.BARIX_BROWSER && existsSync(process.env.BARIX_BROWSER)) return process.env.BARIX_BROWSER;
  for (const p of CANDIDATES[process.platform] ?? []) if (p && existsSync(p)) return p;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) { try { const { readdirSync } = require_fs(); for (const d of readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) { const p = join(process.env.PLAYWRIGHT_BROWSERS_PATH, d, "chrome-linux", "chrome"); if (/^chromium-/.test(d) && existsSync(p)) return p; } } catch { /* ignore */ } }
  return null;
}
import * as nodefs from "node:fs"; const require_fs = () => nodefs;

/** @returns {{screenshot:Function, path:string}|null} */
export function createBrowserCapability({ root } = {}) {
  const exe = findBrowser(); if (!exe) return null;
  return {
    path: exe,
    async screenshot({ target, width = 1280, height = 800 }) {
      const url = /^https?:\/\//i.test(target) ? target : pathToFileURL(resolve(root, target)).toString(); if (!/^https?:/.test(url) && !existsSync(resolve(root, target))) throw new Error(`no such page: ${target}`);
      const dir = await mkdtemp(join(tmpdir(), "barix-shot-")); const out = join(dir, "page.png");
      try {
        const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--virtual-time-budget=4000", `--window-size=${width},${height}`, `--screenshot=${out}`, "--user-data-dir=" + join(dir, "profile"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), url];
        await new Promise((res, rej) => execFile(exe, args, { timeout: 60_000, windowsHide: true }, (e) => (e && !existsSync(out) ? rej(new Error(`browser failed: ${e.message.slice(0, 200)}`)) : res())));
        return new Uint8Array(await readFile(out));
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
    },
  };
}
