// Network resilience for model downloads. Node's fetch has its own certificate store and ignores the Windows proxy settings, so it can fail
// ("fetch failed") on machines where the browser works fine — antivirus HTTPS inspection, corporate proxy/VPN, system-installed root CAs.
// We (1) trust the OS certificate store and honour proxy env vars where this Node supports it, (2) report the real cause, and
// (3) if fetch still fails, download through the operating system's own tools (curl.exe — built into Windows 10+ — then PowerShell).
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import tls from "node:tls";
import http from "node:http";

export function describeError(e) {
  const parts = []; for (let x = e, i = 0; x && i < 4; x = x.cause, i++) parts.push([x.code, x.message].filter(Boolean).join(": "));
  return [...new Set(parts)].join(" ← ").slice(0, 400);
}

export function trustSystemNetwork() {
  const notes = [];
  try { if (typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function") { tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")]); notes.push("system CAs"); } } catch { /* older Node */ }
  try { if (typeof http.setGlobalProxyFromEnv === "function" && (process.env.HTTPS_PROXY || process.env.https_proxy)) { http.setGlobalProxyFromEnv(); notes.push("proxy from environment"); } } catch { /* older Node */ }
  return notes;
}

const run = (cmd, args, { stdio = "inherit" } = {}) => new Promise((resolve) => { let p; try { p = spawn(cmd, args, { stdio: ["ignore", stdio, stdio === "inherit" ? "inherit" : "pipe"], windowsHide: true }); } catch { return resolve(127); } let err = ""; p.stderr?.on("data", (d) => (err += d)); p.on("error", () => resolve(127)); p.on("close", (c) => resolve(c === 0 ? 0 : c ?? 1)); });

async function osDownload(url, dest, headers, log) {
  const win = process.platform === "win32"; const hdr = Object.entries(headers ?? {}).filter(([k]) => !/^(range|accept-encoding)$/i.test(k));
  const attempts = [
    [win ? "curl.exe" : "curl", ["-L", "--fail", "--retry", "3", "-sS", "--progress-bar", "-o", dest, ...hdr.flatMap(([k, v]) => ["-H", `${k}: ${v}`]), url]],
    ...(win ? [["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '${url.replace(/'/g, "''")}' -OutFile '${dest.replace(/'/g, "''")}' -Headers @{${hdr.map(([k, v]) => `'${k}'='${String(v).replace(/'/g, "''")}'`).join(";")}}`]]] : [["wget", ["-q", "-O", dest, ...hdr.flatMap(([k, v]) => [`--header=${k}: ${v}`]), url]]]),
  ];
  for (const [cmd, args] of attempts) { const code = await run(cmd, args); if (code === 0) return cmd; if (code !== 127) log?.(`${cmd} exited with ${code}`); }
  return null;
}

/** A fetch that falls back to OS download tools when Node's own fetch cannot connect. Remembers a working fallback for the session. */
export function resilientFetch(log = () => {}) {
  let useOs = false, warned = false;
  return async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (!useOs) {
      try { if (process.env.BARIX_FORCE_FALLBACK) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "forced for testing" } }); return await fetch(input, init); }
      catch (e) {
        if (!/^https?:/i.test(url) || e?.name === "AbortError") throw e;
        if (!warned) { warned = true; log(`Node could not reach ${new URL(url).host} (${describeError(e)}). Switching to your system's downloader…`); }
        useOs = true;
      }
    }
    const dir = await mkdtemp(path.join(tmpdir(), "barix-dl-")); const dest = path.join(dir, "f"); const tool = await osDownload(url, dest, init.headers && Object.fromEntries(new Headers(init.headers)), log);
    if (!tool) { await rm(dir, { recursive: true, force: true }); throw new Error(`could not download ${url}: Node's fetch failed and neither curl nor PowerShell could fetch it either (check your internet connection, firewall, VPN/proxy or antivirus)`); }
    const size = (await stat(dest)).size; const body = Readable.toWeb(createReadStream(dest)); const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    const res = new Response(init.method === "HEAD" ? null : body, { status: 200, headers: { "content-length": String(size), "content-type": "application/octet-stream" } }); if (init.method === "HEAD") await cleanup(); else setTimeout(cleanup, 15 * 60_000).unref();
    Object.defineProperty(res, "url", { value: url }); return res;
  };
}
