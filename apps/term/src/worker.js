// `barixterm worker`: share this machine's model with Barix clients as an OPT-IN worker.
//  - never starts without the owner typing "yes" (or passing --consent)
//  - listens on 127.0.0.1 unless --host is given; peers must present the pairing code
//  - every request is printed; Ctrl+C stops sharing immediately
import readline from "node:readline";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { WorkerHost, webSocketTransport, HashEmbedder, AssetCache } from "@barix/core";
import os from "node:os";
import path from "node:path";
import { setupProviders, systemInfo } from "./providers-setup.js";

export async function runWorker(f, out) {
  const providers = await setupProviders({ endpoint: f.endpoint, endpointModel: f["endpoint-model"], window: f.window ? +f.window : undefined, model: f.model, cacheDir: path.join(os.homedir(), ".barix", "models") }, (s) => out(s));
  const provider = providers[0]; if (!provider) return out("No model available to share.");
  const code = String(crypto.randomInt(100000, 999999)); const port = +(f.port ?? 8787); const host = f.host ?? "127.0.0.1"; const sys = systemInfo();
  out(`\nThis will let Barix clients that know the pairing code use this machine's ${provider.caps.model} (up to ${f["max-concurrent"] ?? 1} request(s) at a time).`);
  out(`Prompts from those clients are processed here and can be read by you; share the code only with people you trust. Listening on ${host}:${port}.`);
  if (!f.consent) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await new Promise((r) => rl.question('Type "yes" to start sharing: ', r)); rl.close(); if (a.trim().toLowerCase() !== "yes") return out("Not started."); }
  const wh = new WorkerHost({ name: `${os.hostname()} (BarixTerm)`, provider, embedder: new HashEmbedder(), assets: new AssetCache(), hardware: { kind: "cpu", cores: sys.cores, memGB: sys.ramGB }, maxConcurrent: +(f["max-concurrent"] ?? 1), authorize: ({ token }) => token === code, onActivity: (e) => out(`[worker] ${e.type}${e.peer ? " " + e.peer : ""}${e.service ? " " + e.service : ""}`) });
  wh.start({ consent: true });
  const wss = new WebSocketServer({ host, port, maxPayload: 4 * 1024 * 1024 });
  wss.on("connection", (ws) => { ws.readyState; wh.accept(webSocketTransport(ws, "ws-client")); });
  out(`\nWorker ready. Pairing code: ${code}\nConnect from a Barix client with ws://${host === "0.0.0.0" ? "<this-machine-ip>" : host}:${port} and that code. Press Ctrl+C to stop.`);
  await new Promise((res) => process.on("SIGINT", () => { wh.stop(); wss.close(); res(); }));
}
