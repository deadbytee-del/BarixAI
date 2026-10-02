// Barix web app: UI thread only. All intelligence runs in brain.worker.js; the model runs in infer.worker.js.
import { RpcClient } from "./rpc.js";
import { probe, recommend } from "./hardware.js";
import { MODELS, FOUNDATION_NOTE } from "./models.js";
import { renderMarkdown } from "./markdown.js";
import { createSandbox, renderHtmlToPng } from "./sandbox.js";
import { $, $$, h, fmtTok, toast } from "./dom.js";
import * as P from "./panels.js";

const BASE = new URL("./", document.baseURI).href;
const BUILD = new URL(import.meta.url).searchParams.get("v") ?? "dev";
export const S = { base: BASE, build: BUILD, hw: null, rec: null, brain: null, infer: null, project: null, modelReady: false, loading: false, busy: false, attachments: [], ctx: null, endpoints: [], sandbox: createSandbox(), onProgress: null, chosen: null, stream: null, lastStatus: null };
window.__barix = S; // debugging / test hook (read-only use)

const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };
export { store };

// ------------------------------------------------------------------ boot
async function ensureIsolation() {
  // GitHub Pages cannot send COOP/COEP; a tiny service worker adds them so WASM threads (SharedArrayBuffer) work.
  if (self.crossOriginIsolated || !("serviceWorker" in navigator) || !isSecureContext) return;
  if (sessionStorage.getItem("barix.coi") === "1") return; // never loop
  try { const reg = await navigator.serviceWorker.register("./coi-sw.js"); sessionStorage.setItem("barix.coi", "1"); if (reg.active && !navigator.serviceWorker.controller) { location.reload(); await new Promise(() => {}); } else if (!reg.active) { await new Promise((r) => { const w = reg.installing ?? reg.waiting; w?.addEventListener("statechange", () => w.state === "activated" && r()); setTimeout(r, 4000); }); location.reload(); await new Promise(() => {}); } } catch (e) { console.warn("cross-origin isolation shim unavailable:", e.message); }
}

async function boot() {
  applyTheme(store.get("barix.theme", "auto"));
  await ensureIsolation();
  S.hw = await probe(); S.rec = recommend(S.hw); S.chosen = store.get("barix.model", null);
  S.endpoints = store.get("barix.endpoints", []).map((e) => ({ ...e, apiKey: sessionStorage.getItem("barix.key." + e.id) ?? undefined }));
  S.githubToken = sessionStorage.getItem("barix.gh") ?? (store.get("barix.ghRemember", false) ? store.get("barix.gh", "") : "");
  const projects = store.get("barix.projects", [{ id: "scratch", name: "Scratch", kind: "opfs" }]); P.renderProjectSelect(projects, store.get("barix.project", projects[0].id));
  bind(); await openProject(projects.find((p) => p.id === store.get("barix.project", projects[0].id)) ?? projects[0]);
  chips();
}

export async function openProject(project, { handle } = {}) {
  S.brain?.t.terminate?.(); S.infer?.terminate?.(); S.modelReady = false; S.project = project; store.set("barix.project", project.id);
  $("#messages").replaceChildren(); showWelcome();
  const brainW = new Worker(`${BASE}assets/brain.worker.js?v=${BUILD}`, { type: "module", name: "barix-brain" }); S.brain = new RpcClient(brainW); brainW.onerror = (e) => toast("Brain worker error: " + (e.message ?? "see console"), "bad");
  S.brain.on("agent", onAgent); S.brain.on("fs", () => P.refreshTreeSoon()); S.brain.on("cap:screenshot", onShot); S.brain.on("cap:run", onRun); S.brain.on("import-progress", (p) => toast(`Importing… ${p.done}/${p.total}`));
  const useLocal = store.get("barix.localModel", true); let port = null; const transfer = [];
  if (useLocal) {
    const cfg = modelConfig(); const ch = new MessageChannel(); port = ch.port2; transfer.push(port);
    S.infer = new Worker(`${BASE}assets/infer.worker.js?v=${BUILD}`, { type: "module", name: "barix-infer" });
    S.infer.onmessage = onInfer; S.infer.onerror = (e) => toast("Model worker error: " + (e.message ?? ""), "bad");
    S.infer.postMessage({ type: "init", config: cfg, base: BASE, port: ch.port1 }, [ch.port1]);
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("model worker did not start")), 20000); S.onReady = () => { clearTimeout(t); res(); }; }).catch((e) => toast(e.message, "bad"));
  }
  const init = await S.brain.call("init", { project: { id: project.id, kind: project.kind ?? "opfs", handle }, inferPort: port, base: BASE, githubToken: S.githubToken, endpoints: S.endpoints }, transfer).catch((e) => { toast("Could not start Barix: " + e.message, "bad"); return null; });
  if (init) { await P.refreshTree(); await refreshStatus(); }
  if (useLocal && store.get("barix.modelCached." + modelConfig().model, false)) loadModel({ silent: true });
  chips();
}

function modelConfig() {
  const rec = S.rec; const m = S.chosen ? MODELS.find((x) => x.id === S.chosen.id) ?? rec.model : rec.model; const device = S.chosen?.device ?? rec.device; const cfg = m[device] ?? m.wasm;
  return { model: m.id, dtype: cfg.dtype, device, window: m.window[device] ?? 8192, maxOutput: 2048, vision: m.vision, quality: m.quality, name: m.name, mb: cfg.mb };
}
export { modelConfig };

// ------------------------------------------------------------------ model loading
function onInfer(e) {
  const m = e.data;
  if (m.type === "ready") S.onReady?.();
  else if (m.type === "progress") { S.onProgress?.(m.p); }
  else if (m.type === "loaded") { S.modelReady = true; S.loading = false; store.set("barix.modelCached." + modelConfig().model, true); chips(); S.onLoaded?.(m); }
  else if (m.type === "error") { S.loading = false; toast("Model error: " + m.message, "bad"); console.error(m); S.onLoaded?.({ error: m.message }); chips(); }
}
export function loadModel({ silent = false } = {}) {
  if (S.modelReady) return Promise.resolve(); if (S.loading) return S.loadingP; S.loading = true; chips();
  const cfg = modelConfig(); const files = new Map(); let bar, label;
  if (!silent) { const card = h("div", { class: "msg" }, h("div", { class: "who", text: "Barix" }), h("div", { class: "bubble" }, h("p", { text: `Preparing Barix on this device — downloading the ${cfg.name} weights (~${cfg.mb} MB, once; cached for next time)…` }), (label = h("div", { class: "note", text: "starting…" })), h("div", { class: "progress" }, (bar = h("i"))))); $("#messages").append(card); card.scrollIntoView({ block: "end" }); S.progressCard = card; }
  S.onProgress = (p) => { if (p.status === "progress" && p.file) { files.set(p.file, { l: p.loaded ?? 0, t: p.total ?? 0 }); const l = [...files.values()].reduce((a, f) => a + f.l, 0), t = [...files.values()].reduce((a, f) => a + f.t, 0); if (bar && t) { bar.style.width = (100 * l / t).toFixed(1) + "%"; label.textContent = `${(l / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB`; } } else if (p.status === "ready" && label) label.textContent = "initializing runtime…"; };
  S.loadingP = new Promise((res, rej) => { S.onLoaded = (m) => { S.progressCard?.remove(); m.error ? rej(new Error(m.error)) : res(m); }; });
  S.infer.postMessage({ type: "load" }); return S.loadingP;
}

// ------------------------------------------------------------------ chat
const msgs = () => $("#messages");
function scrollDown() { const m = msgs(); if (m.scrollHeight - m.scrollTop - m.clientHeight < 240) m.scrollTop = m.scrollHeight; }
function userBubble(text, images) { const b = h("div", { class: "bubble" }, images.map((i) => h("img", { src: i.url, alt: i.name, style: "max-height:120px;border-radius:8px;margin:0 .4rem .4rem 0" })), h("div", { html: renderMarkdown(text) })); msgs().append(h("div", { class: "msg user" }, h("div", { class: "who", text: "You" }), b)); scrollDown(); }
function newAssistant() {
  const steps = h("div", { class: "steps" }); const body = h("div", { class: "text" }); const status = h("div", { class: "thinking" }, h("span", { class: "dots", text: "Barix is working" }));
  const root = h("div", { class: "msg assistant" }, h("div", { class: "who", text: "Barix" }), h("div", { class: "bubble" }, steps, body, status));
  msgs().append(root); scrollDown(); return { root, steps, body, status, buf: "", segs: [], cur: null, raf: 0, stepEls: new Map() };
}
function flushText(a) { a.raf = 0; if (a.cur) { a.cur.el.innerHTML = renderMarkdown(a.cur.text); } scrollDown(); }
function onAgent(e) {
  const a = S.stream; if (!a || e.id !== a.askId) return;
  switch (e.type) {
    case "plan": a.steps.append(stepEl("run", "Understood", e.plan.explain)); break;
    case "tools": break;
    case "route": a.status.firstChild.textContent = `Barix is working · ${e.provider}`; break;
    case "context": a.step = e.step; a.cur = null; P.onContext(e.report); break;
    case "token": if (!a.cur) { const el = h("div"); a.body.append(el); a.cur = { el, text: "" }; a.segs.push(a.cur); } a.cur.text += e.text; if (!a.raf) a.raf = requestAnimationFrame(() => flushText(a)); break;
    case "tool-start": a.stepEls.set(e.tool, stepEl("run", e.tool, "running…")); a.steps.append(a.stepEls.get(e.tool)); break;
    case "tool": { const el = a.stepEls.get(e.tool); const fresh = stepEl(e.ok ? "ok" : "fail", e.tool + (e.args?.path ? ` ${e.args.path}` : ""), e.summary); if (el) el.replaceWith(fresh); else a.steps.append(fresh); a.stepEls.delete(e.tool); a.cur = null; break; }
    case "gate": a.steps.append(stepEl("run", "Barix verifies", e.action)); break;
    case "failover": a.steps.append(stepEl("fail", "Provider failover", `${e.from}: ${e.reason}`)); break;
    case "memory": a.steps.append(stepEl("ok", "Remembered", e.stored)); break;
    case "vision": a.steps.append(stepEl("ok", "Image understood", e.summary)); break;
    case "continuing": a.steps.append(stepEl("run", "Continuing", "output exceeded one model call; resuming without repeating text")); break;
    case "note": a.steps.append(stepEl("run", "Note", e.text)); break;
    case "thinking": break;
  }
}
const stepEl = (kind, title, detail) => h("div", { class: `step ${kind}` }, h("b", { text: title }), detail ? h("span", { text: " — " + String(detail).slice(0, 220) }) : null);

function verifyBox(r) {
  const v = r.verification; const lines = []; const files = r.changedFiles ?? [];
  for (const f of files) lines.push(h("div", { class: "v-ok", text: `✓ changed ${f} (verified on disk)` }));
  for (const u of v.unverified) lines.push(h("div", { class: "v-no", text: `? ${u.type}${u.path ? " " + u.path : ""} — not verified: ${u.reason}` }));
  for (const u of v.contradicted) lines.push(h("div", { class: "v-bad", text: `✗ ${u.type}${u.path ? " " + u.path : ""} — ${u.reason}` }));
  const foot = (r.text.split("**Verification**")[1] ?? "").split("\n").filter((l) => /^[✓?✗!]/.test(l.trim()));
  for (const l of foot) if (!lines.some((x) => x.textContent.includes(l.slice(2, 30)))) lines.push(h("div", { class: l.startsWith("✓") ? "v-ok" : l.startsWith("✗") ? "v-bad" : "v-no", text: l }));
  if (!lines.length) return null; return h("div", { class: "verify" + (v.ok ? "" : " bad") }, h("h4", { text: "Verification — checked by Barix against recorded tool results" }), lines);
}

async function send(text) {
  text = text.trim(); if (!text && !S.attachments.length) return; if (S.busy) return;
  if (text.startsWith("/") && !S.attachments.length) return slash(text);
  $(".welcome")?.remove();
  const images = S.attachments.splice(0); P.renderAttachments();
  const hasRemote = S.endpoints.length > 0 || (S.workers ?? 0) > 0;
  userBubble(text, images); $("#input").value = ""; autosize(); S.busy = true; toggleBusy();
  try { if (!S.modelReady && store.get("barix.localModel", true) && !hasRemote) await loadModel(); else if (!S.modelReady && store.get("barix.localModel", true)) loadModel({ silent: true }).catch(() => {}); } catch (e) { toast("Could not load the model: " + e.message, "bad"); S.busy = false; toggleBusy(); return; }
  const a = newAssistant(); S.stream = a;
  try {
    a.askId = S.nextAsk = (S.nextAsk ?? 0) + 1;
    const r = S.lastResult = await S.brain.call("ask", { id: a.askId, text, images: images.map((i) => ({ bytes: i.bytes.slice(0), name: i.name })) }); a.status.remove(); if (a.raf) cancelAnimationFrame(a.raf);
    if (r.aborted) { a.body.append(h("p", { class: "note", text: "Stopped." })); return; }
    // final: keep tool steps, replace streamed prose with the clean final answer
    a.body.replaceChildren(h("div", { html: renderMarkdown(r.answer) })); const vb = verifyBox(r); if (vb) a.root.querySelector(".bubble").append(vb);
    a.root.querySelector(".bubble").append(h("div", { class: "note", style: "margin-top:.4rem", text: `${r.steps} step(s) · ${r.usage.promptTokens}+${r.usage.completionTokens} tokens · ${(r.ms / 1000).toFixed(1)}s · ${r.routes.join(", ")}` }));
    await refreshStatus();
  } catch (err) { a.status.remove(); a.body.append(h("p", { class: "v-bad", text: `✗ ${err.code ?? "Error"}: ${err.message}` })); if (/ECAPACITY|provider/.test(String(err.code) + err.message)) a.body.append(h("p", { class: "note", text: "No compute is available. Open the Inside Barix → Compute tab to download a model or connect a server/worker." })); }
  finally { S.busy = false; S.stream = null; toggleBusy(); scrollDown(); }
}
function toggleBusy() { $("#btn-send").hidden = S.busy; $("#btn-stop").hidden = !S.busy; $("#input").disabled = false; }

async function slash(line) {
  const [c] = line.slice(1).split(/\s+/); const note = (t) => { msgs().append(h("div", { class: "msg" }, h("div", { class: "who", text: "Barix" }), h("div", { class: "bubble", html: renderMarkdown(t) }))); scrollDown(); }; $("#input").value = ""; autosize();
  if (c === "help") note("**Commands:** `/status` · `/compact` · `/files` · `/clear`\n\nAttach, paste or drop screenshots to have Barix analyze them. Everything runs in your browser; open **Inside Barix** to see exactly what context, memory and tools it used.");
  else if (c === "status") { const s = await refreshStatus(); note(`Context: **${fmtTok(s.store.retrievable)}** tokens retrievable (cap ${fmtTok(S.brainCap ?? 1250000)}), ${s.store.live} live, ${s.store.summaries} summaries.\n\nIndex: ${s.health.files} files, ${s.health.symbols} symbols, ${s.health.chunks} chunks.\n\nCompute: ${s.providers.map((p) => `${p.id} (${p.model})`).join(", ") || "none yet"}`); }
  else if (c === "compact") { const r = await S.brain.call("context.compact"); note("Compaction: `" + JSON.stringify(r) + "`"); await refreshStatus(); }
  else if (c === "files") S.toggleFiles?.();
  else if (c === "clear") msgs().replaceChildren();
  else note(`Unknown command /${c}. Try /help.`);
}

// ------------------------------------------------------------------ capabilities requested by the brain
async function onShot({ id, html, width, height }) { try { const png = await renderHtmlToPng(html, width, height, S.sandbox); S.brain.call("cap.result", { id, bytes: png.buffer }, [png.buffer]); } catch (e) { S.brain.call("cap.result", { id, error: e.message }); } }
async function onRun({ id, code, timeoutMs }) { try { S.brain.call("cap.result", { id, result: await S.sandbox.run({ code, timeoutMs }) }); } catch (e) { S.brain.call("cap.result", { id, error: e.message }); } }

// ------------------------------------------------------------------ status / chips
export async function refreshStatus() { try { S.lastStatus = await S.brain.call("status"); P.onStatus(S.lastStatus); chips(); return S.lastStatus; } catch { return S.lastStatus; } }
export function chips() {
  const el = $("#chips"); if (!el) return; const st = S.lastStatus; el.replaceChildren();
  const add = (t, c = "") => el.append(h("span", { class: "chip " + c, text: t }));
  const cfg = S.rec ? modelConfig() : null;
  if (store.get("barix.localModel", true) && cfg) add(S.modelReady ? `${cfg.name} · ${cfg.device}` : S.loading ? "loading model…" : "model not loaded", S.modelReady ? "ok" : "warn");
  for (const p of (st?.providers ?? []).filter((x) => x.id !== "browser-local")) add(p.id.replace(/^(local|worker):/, "").slice(0, 22), p.circuitOpen ? "bad" : "ok");
  if (st) add(`${fmtTok(st.store.retrievable)} ctx`);
  if (S.hw && !S.hw.isolated) add("single-thread", "warn");
}

// ------------------------------------------------------------------ welcome
function showWelcome() {
  const rec = S.rec; if (!rec) return; const cfg = modelConfig(); const hasRemote = S.endpoints.length > 0;
  const starters = ["Build a to-do app in plain HTML, CSS and JS", "Explain how a binary search works, briefly", "Review the files I upload for bugs"];
  const dev = (m) => (m === rec.model ? rec.device : (S.hw.webgpu && S.hw.f16 ? "webgpu" : "wasm"));
  const tier = (m) => { const d = dev(m), c = m[d] ?? m.wasm, isRec = m === rec.model; return h("div", { class: "tier" + (isRec ? " rec" : "") }, h("div", { class: "grow" }, h("strong", { text: m.name }), isRec ? h("span", { class: "chip ok", style: "margin-left:.5rem", text: "recommended" }) : null, h("div", { class: "note", text: `${m.note} ~${c.mb} MB · ${d === "webgpu" ? "WebGPU" : "CPU (WebAssembly)"} · ${Math.round(m.window[d] / 1024)}k window` })), h("button", { class: isRec ? "primary" : "secondary", onclick: () => { S.chosen = { id: m.id, device: d }; store.set("barix.model", S.chosen); openProject(S.project).then(() => loadModel()); } }, isRec ? "Download & start" : "Use this"));
  };
  const w = h("div", { class: "welcome" },
    h("div", { class: "hero" }, h("h1", { text: "What can Barix build for you?" }), h("p", { class: "lead", text: "Your own AI engineer with real memory, code understanding and verified results — running privately in this browser. No account, no server." })),
    h("div", { class: "starters" }, starters.map((t) => h("button", { class: "starter", type: "button", onclick: () => { const i = $("#input"); i.value = t; i.focus(); autosize(); } }, t))),
    h("div", { class: "card model-card" }, h("div", { class: "kv" }, h("span", { text: "Model" }), h("span", { text: hasRemote ? "your connected server (see Inside Barix → Compute)" : S.modelReady ? cfg.name + " · ready" : cfg.name + " · not downloaded yet" }), h("span", { text: "Runs on" }), h("span", { text: rec.reason }), h("span", { text: "Your files" }), h("span", { text: S.hw.opfs ? "stay in this browser (OPFS)" + (S.hw.fsAccess ? " · or open a local folder" : "") : "OPFS unavailable — projects will not persist" })),
      hasRemote ? null : tier(rec.model)),
    h("details", { class: "more" }, h("summary", { text: "Other model sizes & compute options" }), h("div", { class: "tiers" }, rec.alternatives.map(tier)), h("p", { class: "note", text: "Prefer your own server or volunteer workers? Open Inside Barix → Compute. " + FOUNDATION_NOTE })),
    h("p", { class: "note center", text: "Barix reports only what it verified: file changes are re-read from disk and builds/tests must actually run." }));
  msgs().append(w);
}

// ------------------------------------------------------------------ input handling
function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }
export function applyTheme(t) { document.documentElement.dataset.theme = t === "auto" ? "" : t; if (t === "auto") document.documentElement.removeAttribute("data-theme"); }
async function addImages(files) { for (const f of files) { if (!f.type.startsWith("image/")) continue; if (f.size > 12 * 1048576) { toast(`${f.name} is larger than 12 MB`, "warn"); continue; } S.attachments.push({ name: f.name || "pasted-image.png", bytes: await f.arrayBuffer(), url: URL.createObjectURL(f) }); } P.renderAttachments(); }
export { addImages };
function bind() {
  const app = $("#app"); S.toggleFiles = () => (app.dataset.files = app.dataset.files === "open" ? "closed" : "open"); S.toggleInside = () => { app.dataset.inside = app.dataset.inside === "open" ? "closed" : "open"; if (app.dataset.inside === "open") P.renderTab(); };
  if (matchMedia("(max-width:860px)").matches) app.dataset.files = "closed";
  $("#btn-files").onclick = S.toggleFiles; $("#btn-inside").onclick = S.toggleInside; $("#btn-settings").onclick = () => P.openSettings();
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send($("#input").value); });
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($("#input").value); } }); $("#input").addEventListener("input", autosize);
  $("#btn-stop").onclick = () => S.brain.call("cancel");
  $("#btn-attach").onclick = () => $("#img-input").click(); $("#img-input").onchange = (e) => { addImages([...e.target.files]); e.target.value = ""; };
  document.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addImages(fs); } });
  const dz = $("#dropzone"); let depth = 0;
  addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { depth++; dz.hidden = false; } }); addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; dz.hidden = true; } }); addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", async (e) => { e.preventDefault(); depth = 0; dz.hidden = true; const files = [...(e.dataTransfer?.files ?? [])]; const imgs = files.filter((f) => f.type.startsWith("image/")); const others = files.filter((f) => !f.type.startsWith("image/")); if (imgs.length) addImages(imgs); if (others.length || e.dataTransfer.items?.[0]?.webkitGetAsEntry?.()?.isDirectory) P.importDataTransfer(e.dataTransfer); });
  $$(".tabs button").forEach((b) => (b.onclick = () => { $$(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b)); P.renderTab(b.dataset.tab); }));
  $("#messages").addEventListener("click", (e) => { const b = e.target.closest?.(".copy"); if (b) { navigator.clipboard?.writeText(b.parentElement.querySelector("code").textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); } });
  P.bindFiles();
}

boot().catch((e) => { console.error(e); toast("Barix failed to start: " + e.message, "bad"); });
