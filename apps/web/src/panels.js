// Panels: file tree & editor, "Inside Barix" tabs (context, memory, compute, evidence), settings, compute dialogs.
import { S, store, openProject, refreshStatus, chips, applyTheme, loadModel, modelConfig, addImages, bridgeConfig } from "./main.js";
import { bridgeStatus } from "./web-access.js";
import { $, $$, h, fmtTok, fmtBytes, toast, dialog } from "./dom.js";
import { MODELS } from "./models.js";
import { icon } from "./icons.js";
import { listCachedModels, deleteCachedModel } from "./model-store.js";
import { zipFiles } from "./zip.js";
import { createInvite, acceptInvite, connectBroadcast } from "@barix/core";

// ---------------------------------------------------------------- projects
export function renderProjectSelect(projects, current) {
  const sel = $("#project-select"); sel.replaceChildren(...projects.map((p) => h("option", { value: p.id, text: p.name, selected: p.id === current })), h("option", { value: "__new", text: "＋ New project…" }), h("option", { value: "__folder", text: "Open local folder…" }));
  sel.onchange = async () => {
    const v = sel.value; const list = store.get("barix.projects", projects);
    if (v === "__new") { const name = prompt("Project name"); if (!name) return renderProjectSelect(list, S.project.id); const p = { id: "p" + Date.now().toString(36), name: name.slice(0, 40), kind: "opfs" }; list.push(p); store.set("barix.projects", list); renderProjectSelect(list, p.id); return openProject(p); }
    if (v === "__folder") { try { const handle = await showDirectoryPicker({ mode: "readwrite" }); const p = { id: "f" + Date.now().toString(36), name: handle.name, kind: "handle" }; list.push(p); store.set("barix.projects", list); await saveHandle(p.id, handle); renderProjectSelect(list, p.id); return openProject(p, { handle }); } catch (e) { toast(e.name === "AbortError" ? "Cancelled" : "Could not open the folder: " + e.message, "warn"); return renderProjectSelect(list, S.project.id); } }
    const p = list.find((x) => x.id === v); if (p.kind === "handle") { const handle = await loadHandle(p.id); if (!handle || (await handle.requestPermission({ mode: "readwrite" })) !== "granted") { toast("Permission to the folder was not granted", "warn"); return renderProjectSelect(list, S.project.id); } return openProject(p, { handle }); } openProject(p);
  };
}
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("barix-handles", 1); r.onupgradeneeded = () => r.result.createObjectStore("h"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function saveHandle(id, handle) { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction("h", "readwrite"); t.objectStore("h").put(handle, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function loadHandle(id) { const db = await idb(); return new Promise((res) => { const r = db.transaction("h").objectStore("h").get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); }

// ---------------------------------------------------------------- files
const open = new Set(); let treeTimer = 0;
export function refreshTreeSoon() { clearTimeout(treeTimer); treeTimer = setTimeout(refreshTree, 120); }
export async function refreshTree() {
  if (!S.brain) return; const entries = await S.brain.call("fs.tree").catch(() => []); const root = $("#tree"); root.replaceChildren(); $("#tree-empty").hidden = entries.length > 0;
  const byDir = new Map(); for (const e of entries) { const d = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ""; (byDir.get(d) ?? byDir.set(d, []).get(d)).push(e); }
  const draw = (dir, depth) => { for (const e of (byDir.get(dir) ?? []).sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1))) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1); const row = h("div", { class: "row " + e.type, role: "treeitem", tabindex: "0", style: `padding-left:${0.4 + depth * 0.9}rem`, title: e.path }, e.type === "dir" ? icon(open.has(e.path) ? "ChevronDown" : "ChevronRight", 14) : icon("File", 14), h("span", { text: name }), e.type === "file" ? h("span", { class: "size", text: fmtBytes(e.size) }) : null);
    row.onclick = () => (e.type === "dir" ? (open.has(e.path) ? open.delete(e.path) : open.add(e.path), refreshTree()) : openFile(e.path)); row.onkeydown = (ev) => ev.key === "Enter" && row.onclick(); root.append(row); if (e.type === "dir" && open.has(e.path)) draw(e.path, depth + 1); } };
  draw("", 0);
}
async function openFile(path) {
  const f = await S.brain.call("fs.read", { path }); const hist = await S.brain.call("fs.history", { path }).catch(() => []);
  if (f.binary) { const url = URL.createObjectURL(new Blob([f.bytes])); const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(path); return dialog(path, h("div", {}, isImg ? h("img", { src: url, style: "max-width:100%;border-radius:8px" }) : h("p", { text: `Binary file, ${fmtBytes(f.size)}` })), { actions: [{ label: "Close" }] }); }
  const ta = h("textarea", { style: "width:100%;min-height:50vh;font:13px/1.45 ui-monospace,Consolas,monospace", spellcheck: false }); ta.value = f.text;
  const vsel = h("select", {}, h("option", { value: "", text: `History (${hist.length})` }), hist.map((v) => h("option", { value: v.n, text: `v${v.n} · ${new Date(v.ts).toLocaleString()} · ${v.op}` })));
  dialog(path, h("div", {}, ta, h("div", { class: "field" }, vsel)), { actions: [
    { label: "Restore selected version", run: async () => { if (!vsel.value) { toast("Pick a version first", "warn"); return false; } await S.brain.call("fs.restore", { path, version: +vsel.value }); toast("Restored"); refreshTree(); } },
    { label: "Delete", run: async () => { if (!confirm(`Delete ${path}? (recoverable from history)`)) return false; await S.brain.call("fs.delete", { path }); refreshTree(); } },
    { label: "Save", primary: true, run: async () => { await S.brain.call("fs.write", { path, text: ta.value }); toast("Saved"); refreshTree(); } }, { label: "Close" }] });
}
export function bindFiles() {
  $("#f-new").onclick = () => { const p = prompt("New file path (e.g. src/app.js)"); if (p) S.brain.call("fs.write", { path: p.trim(), text: "" }).then(() => { refreshTree(); openFile(p.trim()); }); };
  $("#f-upload").onclick = () => $("#file-input").click(); $("#file-input").onchange = (e) => { importFiles([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; }; $("#dir-input").onchange = (e) => { importFiles([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath.split("/").slice(1).join("/") || f.name }))); e.target.value = ""; };
  $("#f-more").onclick = () => { dialog("Project", h("div", {}, h("p", { class: "note", text: "Files live in your browser (OPFS) or in a local folder you opened. Barix's project tree is exactly this list." }), h("div", { class: "actions", style: "justify-content:flex-start;flex-wrap:wrap" },
    h("button", { class: "secondary", onclick: () => $("#dir-input").click() }, "Upload a folder"), h("button", { class: "secondary", onclick: importGitHub }, "Import from GitHub…"), h("button", { class: "secondary", onclick: exportZip }, "Download .zip"), h("button", { class: "secondary", onclick: scanSecrets }, "Scan for secrets"), h("button", { class: "secondary", onclick: auditFs }, "Verify tree vs storage"))), { actions: [{ label: "Close" }] }); };
}
const SKIP = /(^|\/)(node_modules|\.git|dist|\.barix|__pycache__|\.DS_Store)(\/|$)/;
async function importFiles(items) {
  items = items.filter((i) => i.path && !SKIP.test(i.path) && i.file.size <= 8 * 1048576); if (!items.length) return toast("Nothing to import", "warn");
  const files = []; for (const i of items) files.push({ path: i.path, bytes: await i.file.arrayBuffer() }); const r = await S.brain.call("fs.import", { files }, []); toast(`Imported ${r.imported} file(s). ${r.summary ?? ""}`); refreshTree(); refreshStatus();
}
export async function importDataTransfer(dt) {
  const items = []; const walk = async (entry, prefix) => { if (entry.isFile) await new Promise((res) => entry.file((f) => { items.push({ file: f, path: prefix + f.name }); res(); })); else if (entry.isDirectory) { const rd = entry.createReader(); for (;;) { const batch = await new Promise((r) => rd.readEntries(r)); if (!batch.length) break; for (const e of batch) await walk(e, prefix + entry.name + "/"); } } };
  for (const it of [...(dt.items ?? [])]) { const e = it.webkitGetAsEntry?.(); if (e) await walk(e, e.isDirectory ? "" : ""); }
  const roots = new Set(items.map((i) => i.path.split("/")[0])); if (roots.size === 1 && items.some((i) => i.path.includes("/"))) for (const i of items) i.path = i.path.split("/").slice(1).join("/"); importFiles(items.filter((i) => !(dt.files?.length && [...dt.files].every((f) => f.type.startsWith("image/")))));
}
function importGitHub() {
  const url = h("input", { placeholder: "https://github.com/owner/repo  (or …/tree/branch/sub/path)", style: "width:100%" }); const tok = S.githubToken ? "using your token (private repos OK)" : "public repositories only — add a token in Settings for private ones";
  dialog("Import from GitHub", h("div", {}, h("div", { class: "field" }, h("label", { text: "Repository URL" }), url), h("p", { class: "note", text: `Files are fetched via raw.githubusercontent.com (no API rate limit for public repos); ${tok}. Binary, vendored and very large files are skipped; skips are reported.` })), { actions: [{ label: "Cancel" }, { label: "Import", primary: true, run: async () => { try { toast("Importing…"); const r = await S.brain.call("github.import", { repo: url.value }); toast(`Imported ${r.imported} files from ${r.ref} (${r.skipped} skipped${r.truncatedTree ? ", tree truncated" : ""})`); refreshTree(); refreshStatus(); } catch (e) { toast(e.message, "bad"); } } }] });
}
async function exportZip() { const { files } = await S.brain.call("fs.export"); const blob = zipFiles(files.map((f) => ({ path: f.path, bytes: new Uint8Array(f.bytes) }))); const a = h("a", { href: URL.createObjectURL(blob), download: `${S.project.name.replace(/\W+/g, "-")}.zip` }); document.body.append(a); a.click(); a.remove(); }
async function scanSecrets() { const hits = await S.brain.call("project.secrets"); dialog("Secret scan", h("div", {}, hits.length ? h("div", {}, h("p", { class: "v-no", text: `${hits.length} possible secret(s) found — do not publish these files.` }), hits.slice(0, 40).map((x) => h("div", { class: "note", text: `${x.path}:${x.line} — ${x.type} (${x.preview})` }))) : h("p", { class: "v-ok", text: "No secrets detected by Barix's scanner." })), { actions: [{ label: "Close" }] }); }
async function auditFs() { const a = await S.brain.call("fs.audit"); dialog("Project tree vs storage", h("div", {}, h("p", { class: a.ok ? "v-ok" : "v-bad", text: a.ok ? "✓ Barix's in-memory project tree exactly matches what is stored." : "✗ The tree differs from storage:" }), a.ok ? null : h("pre", { text: JSON.stringify(a, null, 1) })), { actions: [{ label: "Close" }] }); }

// ---------------------------------------------------------------- attachments
export function renderAttachments() { const el = $("#attachments"); el.replaceChildren(...S.attachments.map((a, i) => h("div", { class: "att" }, h("img", { src: a.url, alt: a.name }), h("button", { type: "button", "aria-label": "Remove", onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }, "×")))); }

// ---------------------------------------------------------------- inside barix
let tab = "context", lastReport = null;
export function renderTab(t) { if (t) tab = t; const b = $("#tab-body"); if (!b) return; b.replaceChildren(); ({ context: tabContext, memory: tabMemory, compute: tabCompute, evidence: tabEvidence })[tab](b); }
export function onContext(report) { lastReport = report; const m = $("#meter"); if (m) { const used = report.promptTokens, w = report.window; m.replaceChildren(h("i", { style: `width:${Math.min(100, used / w * 100)}%;background:#fff`, title: `prompt ${used}/${w} tokens` })); } if (tab === "context" && $("#app").dataset.inside === "open") renderTab(); }
export function onStatus() { if ($("#app").dataset.inside === "open") renderTab(); }
const COLORS = { system: "#ffffff", task: "#d3d5d9", remembered: "#b3b6bc", summaries: "#92959d", recalled: "#73767e", code: "#575a62", recent: "#3f4249" };
function tabContext(b) {
  const st = S.lastStatus; const r = lastReport;
  b.append(h("div", { class: "card" }, h("h4", { text: "Last prompt Barix built" }), r ? [h("div", { class: "bar" }, Object.entries(r.sections).map(([k, v]) => h("i", { title: `${k}: ${v}`, style: `width:${v / r.window * 100}%;background:${COLORS[k] ?? "#999"}` }))), h("div", { class: "legend" }, Object.entries(r.sections).filter(([, v]) => v).map(([k, v]) => h("span", {}, h("b", { style: `background:${COLORS[k]}` }), `${k} ${fmtTok(v)}`))), h("div", { class: "kv", style: "margin-top:.5rem" }, h("span", { text: "Prompt / window" }), h("span", { text: `${fmtTok(r.promptTokens)} / ${fmtTok(r.window)}` }), h("span", { text: "Build time" }), h("span", { text: `${r.buildMs} ms` }), h("span", { text: "Prefix reuse" }), h("span", { text: `${Math.round((r.prefixReuse ?? 0) * 100)}% of prompt unchanged since last step` }), r.compaction?.compacted ? [h("span", { text: "Compacted" }), h("span", { text: `${r.compaction.compacted} items (×${r.compaction.ratio})` })] : null)] : h("p", { class: "note", text: "Send a message to see exactly which context Barix selected." })));
  if (r?.retrieved?.code?.length) b.append(h("div", { class: "card" }, h("h4", { text: "Code retrieved for this step" }), r.retrieved.code.map((c) => h("div", { class: "note", text: c }))));
  if (r?.retrieved?.history?.length) b.append(h("div", { class: "card" }, h("h4", { text: "Recalled from earlier history" }), h("div", { class: "note", text: r.retrieved.history.join(", ") })));
  if (st) b.append(h("div", { class: "card" }, h("h4", { text: "Conversation store" }), h("div", { class: "kv" }, h("span", { text: "Retrievable" }), h("span", { text: `${fmtTok(st.store.retrievable)} tokens` }), h("span", { text: "Live / archived" }), h("span", { text: `${fmtTok(st.store.live)} / ${fmtTok(st.store.archived)}` }), h("span", { text: "Summaries" }), h("span", { text: st.store.summaries }), h("span", { text: "Evicted raw" }), h("span", { text: fmtTok(st.store.evicted) }), h("span", { text: "Target (browser coding)" }), h("span", { text: "1,250,000 tokens" })), h("div", { style: "margin-top:.5rem" }, h("button", { class: "mini", onclick: async () => { toast("Compacting…"); await S.brain.call("context.compact"); refreshStatus(); } }, "Compact now"))),
    h("div", { class: "card" }, h("h4", { text: "Code index" }), h("div", { class: "kv" }, h("span", { text: "Files / symbols" }), h("span", { text: `${st.health.files} / ${st.health.symbols}` }), h("span", { text: "Parsers" }), h("span", { text: `${st.health.treeSitterFiles} tree-sitter · ${st.health.scannerFiles} fallback` }), h("span", { text: "Chunks" }), h("span", { text: st.health.chunks }), h("span", { text: "Re-parses avoided" }), h("span", { text: st.health.skipped }))));
}
async function tabMemory(b) {
  const m = await S.brain.call("memory.list"); const t = m.task;
  b.append(h("div", { class: "card" }, h("h4", { text: "Task memory" }), t.objective ? h("div", {}, h("div", { text: t.objective }), h("div", { class: "note", text: `status ${t.status} · files ${t.files.join(", ") || "—"}` }), t.errors.filter((e) => !e.resolved).map((e) => h("div", { class: "v-no", text: e.text }))) : h("p", { class: "note", text: "No active task." })));
  b.append(h("div", { class: "card" }, h("h4", { text: "Project memory" }), m.project.length ? m.project.map((x) => memRow(x)) : h("p", { class: "note", text: "Barix keeps architecture notes and conventions here." })));
  const inp = h("input", { placeholder: "Ask Barix to remember… (e.g. I prefer TypeScript)", style: "width:100%" });
  b.append(h("div", { class: "card" }, h("h4", { text: "Long-term memory (only what should persist)" }), m.longTerm.length ? m.longTerm.map((x) => memRow(x)) : h("p", { class: "note", text: "Nothing stored. Barix saves a preference only when you ask, never secrets." }), inp, h("button", { class: "mini", style: "margin-top:.4rem", onclick: async () => { const r = await S.brain.call("memory.remember", { text: inp.value }); toast(r.stored ? "Remembered" : "Not stored: " + r.reason, r.stored ? "" : "warn"); renderTab(); } }, "Remember")));
}
const memRow = (x) => h("div", { class: "note", style: "display:flex;gap:.4rem;align-items:flex-start" }, h("span", { style: "flex:1", text: x.text }), h("button", { class: "mini", "aria-label": "Forget", onclick: async () => { await S.brain.call("memory.forget", { id: x.id }); renderTab(); } }, "forget"));
async function tabCompute(b) {
  const st = await refreshStatus(); const cap = st.capacity; b.append(modelsCard());
  b.append(h("div", { class: "card" }, h("h4", { text: "Compute Barix can use" }), st.providers.length ? st.providers.map((p) => h("div", { style: "margin-bottom:.4rem" }, h("div", {}, h("b", { text: p.id }), " ", h("span", { class: "chip " + (p.circuitOpen ? "bad" : "ok"), text: p.circuitOpen ? "paused" : p.kind })), h("div", { class: "note", text: `${p.model} · window ${fmtTok(p.window)}${p.tps ? ` · ${p.tps} tok/s` : ""} · served ${p.served}${p.failures ? ` · ${p.failures} failures` : ""}` }), p.id === "browser-local" ? null : h("button", { class: "mini", onclick: async () => { await S.brain.call("provider.remove", { id: p.id }); renderTab(); } }, "remove"))) : h("p", { class: "note", text: "No compute yet. Download a model (welcome screen), add a server, or connect a worker." }), h("div", { class: "note", text: "Barix routes each request to the best available option, fails over automatically, and never bypasses a provider's limits." })));
  b.append(h("div", { class: "card" }, h("h4", { text: "Capacity this month" }), h("div", { class: "kv" }, h("span", { text: "Used" }), h("span", { text: `${fmtTok(cap.usedThisMonth)} tokens` }), h("span", { text: "Target" }), h("span", { text: "500M tokens/month" }), h("span", { text: "Progress" }), h("span", { text: `${cap.percentOfTarget}%` })), h("p", { class: "note", text: cap.note })));
  b.append(h("div", { class: "card" }, h("h4", { text: "Add compute" }), h("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap" }, h("button", { class: "mini", onclick: addEndpointDialog }, "Server / endpoint…"), h("button", { class: "mini", onclick: connectPeerDialog }, "Connect to a worker…"), h("button", { class: "mini", onclick: shareDialog }, "Share this browser…")), h("div", { class: "field" }, h("label", { text: "Routing preference" }), (() => { const s = h("select", { onchange: () => S.brain.call("router.setStrategy", { strategy: s.value }) }, ["privacy", "quality", "speed"].map((x) => h("option", { value: x, text: { privacy: "Privacy (local first)", quality: "Quality", speed: "Speed" }[x] }))); return s; })())));
  b.append(h("div", { class: "card" }, h("h4", { text: "Device" }), h("div", { class: "kv" }, h("span", { text: "WebGPU" }), h("span", { text: S.hw.webgpu ? `yes${S.hw.f16 ? " (f16)" : ""} · ${S.hw.adapter}` : "no" }), h("span", { text: "Threads" }), h("span", { text: S.hw.isolated ? "multi-threaded WASM available" : "single-threaded (not cross-origin isolated)" }), h("span", { text: "Storage" }), h("span", { text: S.hw.storage ? `${S.hw.storage.usedGB} / ${S.hw.storage.quotaGB} GB` : "?" }))));
}
function tabEvidence(b) {
  const ev = S.lastStatus?.evidence ?? []; b.append(h("div", { class: "card" }, h("h4", { text: "Verification ledger (this task)" }), ev.length ? ev.slice().reverse().map((e) => h("div", { class: "note" }, h("span", { class: e.ok ? "v-ok" : "v-bad", text: e.ok ? "✓ " : "✗ " }), `${e.kind} · ${e.tool}${e.data?.path ? " " + e.data.path : ""}${e.data?.summary ? " — " + String(e.data.summary).slice(0, 80) : ""}`)) : h("p", { class: "note", text: "Every file write, build, test and publish Barix performs is recorded here. Barix may only claim what this ledger can prove." })));
}

// ---------------------------------------------------------------- compute dialogs
function addEndpointDialog() {
  const f = { url: h("input", { placeholder: "http://localhost:8080/v1  (llama.cpp / Ollama / LM Studio / vLLM)" }), model: h("input", { placeholder: "model id, e.g. qwen3.5-4b" }), win: h("input", { type: "number", value: 32768 }), key: h("input", { type: "password", placeholder: "optional API key (kept for this tab only)" }), local: h("input", { type: "checkbox", checked: true }), vision: h("input", { type: "checkbox" }) };
  dialog("Add an OpenAI-compatible server", h("div", {}, ...[["Base URL", f.url], ["Model", f.model], ["Context window (tokens the server really supports)", f.win], ["API key", f.key]].map(([l, e]) => h("div", { class: "field" }, h("label", { text: l }), e)), h("label", { class: "note" }, f.local, " this is my own machine/LAN (counts as local & private)"), h("br"), h("label", { class: "note" }, f.vision, " the model accepts images (vision)"), h("p", { class: "note", text: "Only open-weight models are accepted — Barix is its own system and will not proxy a proprietary chatbot. The server must allow CORS for this page. Keys are never stored on disk." })), { actions: [{ label: "Cancel" }, { label: "Add", primary: true, run: async () => {
    const e = { id: `${f.local.checked ? "local" : "public"}:${new URL(f.url.value).host}:${f.model.value}`, baseUrl: f.url.value, model: f.model.value, window: +f.win.value, local: f.local.checked, vision: f.vision.checked }; try { await S.brain.call("provider.addEndpoint", { ...e, apiKey: f.key.value || undefined }); } catch (err) { toast(err.message, "bad"); return false; }
    const list = store.get("barix.endpoints", []).filter((x) => x.id !== e.id); list.push(e); store.set("barix.endpoints", list); if (f.key.value) sessionStorage.setItem("barix.key." + e.id, f.key.value); S.endpoints.push({ ...e, apiKey: f.key.value || undefined }); toast("Added " + e.id); renderTab(); chips(); } }] });
}
function bridge(transport, port) { transport.onMessage((m) => port.postMessage(m)); port.onmessage = (e) => { try { transport.send(e.data); } catch { /* closed */ } }; transport.onClose(() => { try { port.postMessage({ __barixClose: true }); } catch {} }); }
function connectPeerDialog() {
  const token = h("input", { placeholder: "pairing code from the worker's owner" }); const invite = h("textarea", { rows: 4, placeholder: "Paste the worker's invite here" }); const answer = h("textarea", { rows: 4, readOnly: true, placeholder: "Your answer will appear here" }); const ws = h("input", { placeholder: "ws://localhost:8787  (BarixTerm worker)" });
  dialog("Connect to a Barix worker", h("div", {}, h("p", { class: "note", text: "Workers are volunteers' machines. Your prompts are processed on THEIR device and can be read by them — use only workers you trust. Nothing is sent unless you connect." }), h("div", { class: "field" }, h("label", { text: "Pairing code" }), token),
    h("h4", { text: "Option A — WebRTC (browser ↔ browser, no server)" }), h("div", { class: "field" }, h("label", { text: "1. Paste invite" }), invite), h("button", { class: "secondary", onclick: async () => { try { const g = await acceptInvite(invite.value); answer.value = g.answer; toast("Send the answer back to the worker's owner, then wait…"); const transport = await g.transport; const ch = new MessageChannel(); bridge(transport, ch.port1); const r = await S.brain.call("peer.attach", { port: ch.port2, token: token.value || undefined }, [ch.port2]); S.workers = (S.workers ?? 0) + 1; toast("Connected to " + r.advert.name); renderTab(); chips(); } catch (e) { toast(e.message, "bad"); } } }, "2. Create answer & connect"), h("div", { class: "field" }, h("label", { text: "Your answer (send to the owner)" }), answer),
    h("h4", { text: "Option B — BarixTerm worker (WebSocket)" }), h("div", { class: "field" }, ws), h("button", { class: "secondary", onclick: async () => { try { const r = await S.brain.call("peer.connectWebSocket", { url: ws.value, token: token.value || undefined }); S.workers = (S.workers ?? 0) + 1; toast("Connected to " + r.advert.name); renderTab(); chips(); } catch (e) { toast(e.message, "bad"); } } }, "Connect")), { actions: [{ label: "Close" }] });
}
let sharing = null;
function shareDialog() {
  const cfg = modelConfig(); const code = String(Math.floor(100000 + Math.random() * 900000)); const out = h("textarea", { rows: 4, readOnly: true }); const answer = h("textarea", { rows: 4, placeholder: "Paste the guest's answer here" }); const log = h("div", { class: "note" });
  const start = async () => {
    if (!S.modelReady) { toast("Load your model first (send a message), then share.", "warn"); return false; }
    S.infer.postMessage({ type: "share-start", code }); const inv = await createInvite({ label: "guest" }); out.value = inv.invite; sharing = inv;
    log.textContent = `Sharing is ON. Pairing code: ${code}. Give the guest the invite and the code; paste their answer below.`;
    return false;
  };
  const accept = async () => { try { const t = await sharing.accept(answer.value); const ch = new MessageChannel(); bridge(t, ch.port1); S.infer.postMessage({ type: "share-accept", port: ch.port2 }, [ch.port2]); log.textContent += " Guest connected."; } catch (e) { toast(e.message, "bad"); } };
  dialog("Share this browser as a Barix worker", h("div", {}, h("p", { text: `Let a friend's Barix use your ${cfg.name} (one request at a time).` }), h("p", { class: "note", text: "This is opt-in and visible: their prompts are processed on your device and you can read them in the browser's devtools. Share only with people you trust. Closing this tab stops sharing." }), h("div", { class: "field" }, h("label", { text: "Invite (send to the guest)" }), out), h("button", { class: "primary", onclick: start }, "Start sharing & create invite"), h("div", { class: "field" }, h("label", { text: "Guest's answer" }), answer), h("button", { class: "secondary", onclick: accept }, "Connect guest"), log), { actions: [{ label: "Stop sharing", run: () => { S.infer.postMessage({ type: "share-stop" }); sharing = null; } }, { label: "Close" }] });
}

// ---------------------------------------------------------------- settings
export function openSettings() {
  const gh = h("input", { type: "password", placeholder: "GitHub token (fine-grained, read-only is enough for private repos)", value: S.githubToken ?? "" }); const remember = h("input", { type: "checkbox", checked: store.get("barix.ghRemember", false) });
  const local = h("input", { type: "checkbox", checked: store.get("barix.localModel", true) });
  const reasoning = h("select", {}, [["auto", "Auto — think only on hard problems (fastest)"], ["on", "On — always think before answering (slower, smarter)"], ["off", "Off — never think (fastest)"]].map(([v, t]) => h("option", { value: v, text: t, selected: store.get("barix.reasoning", "auto") === v })));
  const model = h("select", {}, MODELS.map((m) => h("option", { value: m.id, text: `${m.name} — ~${(m[S.hw.webgpu && S.hw.f16 ? "webgpu" : "wasm"] ?? m.wasm).mb} MB`, selected: modelConfig().model === m.id })));
  dialog("Settings", h("div", {},
    h("div", { class: "field" }, h("label", { text: "Foundation model on this device" }), model, h("label", { class: "note" }, local, " run a model locally in this browser")),
    h("div", { class: "field" }, h("label", { text: "Reasoning" }), reasoning),
    h("div", { class: "field" }, h("label", { text: "GitHub token (for private repositories)" }), gh, h("label", { class: "note" }, remember, " remember on this device (stored unencrypted in this browser — leave off on shared computers)")),
    modelsCard(), bridgeCard(),
    h("p", { class: "note", text: `Targets: browser chat output up to 1,650,000 tokens/message and browser-coding context up to 1,250,000 tokens — budgets, bounded by the model's real window (${fmtTok(modelConfig().window)} here); Barix continues and retrieves to bridge the gap.` }),
    h("div", { class: "actions", style: "justify-content:flex-start;flex-wrap:wrap" }, h("button", { class: "secondary", onclick: async () => { if (!confirm("Delete ALL Barix projects and data stored in this browser?")) return; const root = await navigator.storage.getDirectory(); for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true }); localStorage.clear(); sessionStorage.clear(); location.reload(); } }, "Erase all local data"))),
    { actions: [{ label: "Cancel" }, { label: "Save", primary: true, run: async () => {
      store.set("barix.localModel", local.checked); store.set("barix.reasoning", reasoning.value); store.set("barix.ghRemember", remember.checked);
      S.githubToken = gh.value; sessionStorage.setItem("barix.gh", gh.value); if (remember.checked) store.set("barix.gh", gh.value); else localStorage.removeItem("barix.gh"); await S.brain.call("github.token", { token: gh.value });
      const changed = model.value !== modelConfig().model; if (changed) { const m = MODELS.find((x) => x.id === model.value); S.chosen = { id: m.id, device: S.hw.webgpu && S.hw.f16 ? "webgpu" : "wasm" }; store.set("barix.model", S.chosen); await openProject(S.project); } toast("Saved"); } }] });
}

// ---------------------------------------------------------------- models on this device (listing + deletion)
function modelsCard() {
  const list = h("div", { class: "models-list" }, h("div", { class: "note", text: "Checking this device…" })); const card = h("div", { class: "card" }, h("h4", { text: "Models on this device" }), list);
  const draw = async () => {
    const items = await listCachedModels().catch(() => []); const active = modelConfig().model;
    list.replaceChildren(...(items.length ? items.map((m) => h("div", { class: "model-row" }, icon("HardDrive", 16), h("div", { class: "grow" }, h("div", { text: m.name }), h("div", { class: "note", text: `${fmtBytes(m.bytes)} · ${m.files} file(s)${m.id === active && S.modelReady ? " · in use" : ""}` })),
      h("button", { class: "mini danger", type: "button", title: "Delete from this device", "aria-label": `Delete ${m.name}`, onclick: async () => {
        if (!confirm(`Delete ${m.name} (${fmtBytes(m.bytes)}) from this device? You can download it again later.`)) return;
        const wasLoaded = m.id === active && (S.modelReady || S.loading); if (wasLoaded) { S.infer?.terminate?.(); S.modelReady = false; S.loading = false; }
        const n = await deleteCachedModel(m.id); toast(`Deleted ${m.name} (${n} file(s), ${fmtBytes(m.bytes)} freed)`); if (wasLoaded) await openProject(S.project); chips(); draw();
      } }, icon("Trash2", 14), "Delete"))) : [h("div", { class: "note", text: "No models are stored on this device. Barix downloads one only when you start a chat." })]));
  };
  draw(); return card;
}

// ---------------------------------------------------------------- Barix Bridge (internet + your GitHub through a local Node helper)
export async function checkBridge() {
  const c = bridgeConfig(); if (!c) { S.bridge = null; return null; }
  try { const st = await bridgeStatus(c); S.bridge = { ok: true, login: st.github?.login ?? null, github: !!st.github?.available, llm: st.llm ?? null }; } catch (e) { S.bridge = { ok: false, error: e.message }; }
  await syncBridgeModel(); return S.bridge;
}
/** If the bridge exposes a local model server (Ollama / llama.cpp / LM Studio), add it as compute — typically far stronger than an in-browser model. */
export async function syncBridgeModel() {
  const c = bridgeConfig(); const want = S.bridge?.ok && S.bridge.llm && c ? S.bridge.llm : null; const id = want ? `bridge-llm:${want.model}` : null;
  if (S.bridgeLlmId && S.bridgeLlmId !== id) { await S.brain?.call("provider.remove", { id: S.bridgeLlmId }).catch(() => {}); S.bridgeLlmId = null; }
  if (want && S.bridgeLlmId !== id) { try { await S.brain.call("provider.addEndpoint", { id, baseUrl: `${c.url.replace(/\/$/, "")}/v1/llm`, model: want.model, window: want.window || 8192, local: true, quality: 0.75, apiKey: c.token }); S.bridgeLlmId = id; } catch (e) { toast("Bridge model unavailable: " + e.message, "warn"); } }
  chips();
}
function bridgeCard() {
  const cur = bridgeConfig(); const url = h("input", { value: store.get("barix.bridge.url", "http://127.0.0.1:8799"), placeholder: "http://127.0.0.1:8799", "aria-label": "Bridge address" });
  const code = h("input", { type: "password", value: cur?.token ?? "", placeholder: "pairing code shown by the bridge", "aria-label": "Pairing code", autocomplete: "off" }); const remember = h("input", { type: "checkbox", checked: store.get("barix.bridge.remember", false) });
  const out = h("div", { class: "note", role: "status", text: S.bridge?.ok ? `Connected${S.bridge.login ? " as " + S.bridge.login : ""}.` : "Not connected. Without it the model can only use Wikipedia and your own browser." });
  const connect = h("button", { class: "mini", type: "button", onclick: async () => {
    const c = { url: url.value.trim().replace(/\/$/, ""), token: code.value.trim() }; if (!c.url || !c.token) { out.textContent = "Enter the bridge address and pairing code."; return; }
    out.textContent = "Connecting…";
    try { const st = await bridgeStatus(c); store.set("barix.bridge.url", c.url); store.set("barix.bridge.remember", remember.checked); try { sessionStorage.setItem("barix.bridge.token", c.token); } catch {} if (remember.checked) store.set("barix.bridge.token", c.token); else store.set("barix.bridge.token", "");
      S.bridge = { ok: true, login: st.github?.login ?? null, github: !!st.github?.available, llm: st.llm ?? null }; await S.brain.call("bridge.set", c); await syncBridgeModel(); out.textContent = `Connected${st.github?.login ? " as " + st.github.login : ""} — internet ${st.web ? "on" : "off"}, GitHub ${st.github?.available ? "on (read-only)" : "not signed in on that PC"}, local model ${st.llm ? st.llm.model + " (in use)" : "none found"}.`; chips(); }
    catch (e) { S.bridge = { ok: false, error: e.message }; out.textContent = `Could not connect: ${e.message}. Is BarixTerm.bat bridge running? (Safari blocks this; use Chrome, Edge or Firefox.)`; }
  } }, icon("Check", 14), "Connect");
  const off = h("button", { class: "mini", type: "button", onclick: async () => { try { sessionStorage.removeItem("barix.bridge.token"); } catch {} store.set("barix.bridge.token", ""); S.bridge = null; await S.brain.call("bridge.set", null); await syncBridgeModel(); code.value = ""; out.textContent = "Disconnected."; chips(); } }, icon("X", 14), "Disconnect");
  return h("div", { class: "card" }, h("h4", { text: "Barix Bridge — internet + your GitHub" }),
    h("p", { class: "note", text: "A browser page cannot read arbitrary websites or keep your GitHub login. Run BarixTerm.bat bridge on this PC and connect it here: the model can then search the web, read pages and list/read your GitHub repos (including private ones, read-only). Your GitHub token never leaves your PC." }),
    h("div", { class: "field" }, h("label", { text: "Bridge address" }), url), h("div", { class: "field" }, h("label", { text: "Pairing code" }), code),
    h("label", { class: "note" }, remember, " remember the pairing code on this device"), h("div", { style: "display:flex;gap:.4rem;margin:.5rem 0" }, connect, off), out);
}
