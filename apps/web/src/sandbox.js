// Main-thread capabilities for the brain worker: run code in an isolated iframe, and rasterize HTML to PNG.
// The iframe is sandboxed WITHOUT allow-same-origin: opaque origin => no access to Barix's OPFS/IndexedDB/cookies.
const HARNESS = (id) => `
<script>
const __id = ${JSON.stringify(id)}; const logs = []; const send = (m) => parent.postMessage({ __barix: __id, ...m }, "*");
const fmt = (a) => a.map((x) => { try { return typeof x === "string" ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x); } catch { return String(x); } }).join(" ");
for (const k of ["log", "info", "warn", "error", "debug"]) { const o = console[k].bind(console); console[k] = (...a) => { if (logs.length < 200) logs.push((k === "log" ? "" : k + ": ") + fmt(a).slice(0, 500)); o(...a); }; }
class ProcessExit extends Error { constructor(c) { super("process.exit(" + c + ")"); this.code = c; } }
globalThis.process = { argv: ["node", "script"], env: {}, platform: "browser", exit(c = 0) { throw new ProcessExit(c); }, stdout: { write: (s) => console.log(String(s).replace(/\\n$/, "")) }, stderr: { write: (s) => console.error(String(s).replace(/\\n$/, "")) }, nextTick: (f, ...a) => queueMicrotask(() => f(...a)), cwd: () => "/", hrtime: Object.assign(() => [0, 0], { bigint: () => 0n }), version: "browser", versions: {}, on() {}, exitCode: 0 };
addEventListener("error", (e) => { send({ phase: "error", error: String(e.message), logs }); e.preventDefault(); });
addEventListener("unhandledrejection", (e) => { send({ phase: "error", error: String(e.reason?.message ?? e.reason), logs }); });
globalThis.__barix_done = async () => {
  const results = []; let error = null;
  for (const t of globalThis.__barix_tests ?? []) {
    if (t.skip) { results.push({ name: t.name, ok: true, skip: true }); continue; }
    const t0 = performance.now();
    try { for (const f of t.ctx.be) await f(); await Promise.race([t.fn({ name: t.name }), new Promise((_, rej) => setTimeout(() => rej(new Error("test timed out after 8s")), 8000))]); for (const f of t.ctx.ae) await f(); results.push({ name: t.name, ok: true, ms: Math.round(performance.now() - t0) }); }
    catch (e) { results.push({ name: t.name, ok: false, error: e?.message ?? String(e), stack: String(e?.stack ?? "").slice(0, 400), ms: Math.round(performance.now() - t0) }); }
  }
  send({ phase: "done", results, logs, error });
};
</script>`;
export function createSandbox() {
  return {
    run({ code, timeoutMs = 20000 }) {
      return new Promise((resolve) => {
        const id = "s" + Math.random().toString(36).slice(2); const iframe = document.createElement("iframe"); iframe.setAttribute("sandbox", "allow-scripts"); iframe.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px;border:0";
        let done = false; const finish = (r) => { if (done) return; done = true; clearTimeout(timer); removeEventListener("message", onMsg); iframe.remove(); resolve({ results: [], logs: [], ...r }); };
        const onMsg = (e) => { const m = e.data; if (!m || m.__barix !== id) return; if (m.phase === "done") finish({ results: m.results, logs: m.logs, error: m.error }); else if (m.phase === "error") finish({ error: m.error, logs: m.logs }); };
        addEventListener("message", onMsg); const timer = setTimeout(() => finish({ timedOut: true, error: "timed out" }), timeoutMs);
        // module script: the bundle runs, then we let microtasks settle and run registered tests
        const body = `${HARNESS(id)}<script type="module">try {\n${code.replace(/<\/script/gi, "<\\/script")}\n} catch (e) { if (e?.code !== undefined && String(e.message).startsWith("process.exit(")) { if (e.code !== 0) globalThis.__err = "process.exit(" + e.code + ")"; } else globalThis.__err = String(e?.stack ?? e); }\nawait new Promise((r) => setTimeout(r, 0)); if (globalThis.__err) parent.postMessage({ __barix: ${JSON.stringify(id)}, phase: "error", error: globalThis.__err, logs: [] }, "*"); else await globalThis.__barix_done();<\/script>`;
        iframe.srcdoc = `<!doctype html><html><body>${body}</body></html>`; document.body.appendChild(iframe);
      });
    },
  };
}

/** Render a self-contained HTML document to PNG: load it in a sandboxed iframe, serialize the live DOM, rasterize via SVG foreignObject. */
export async function renderHtmlToPng(html, width = 1280, height = 800, sandbox = createSandbox()) {
  const id = "r" + Math.random().toString(36).slice(2);
  const serialized = await new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe"); iframe.setAttribute("sandbox", "allow-scripts"); iframe.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px;border:0`;
    const timer = setTimeout(() => { cleanup(); reject(new Error("preview page did not load in time")); }, 15000);
    const onMsg = (e) => { const m = e.data; if (!m || m.__barixShot !== id) return; cleanup(); m.error ? reject(new Error(m.error)) : resolve(m.xml); };
    const cleanup = () => { clearTimeout(timer); removeEventListener("message", onMsg); iframe.remove(); };
    addEventListener("message", onMsg);
    const injector = `<script>addEventListener("load",()=>setTimeout(()=>{try{const d=document.documentElement,b=document.body,t=(c)=>!c||c==="rgba(0, 0, 0, 0)"||c==="transparent";const hb=getComputedStyle(d).backgroundColor,bb=b?getComputedStyle(b).backgroundColor:"";if(t(hb)&&!t(bb))d.style.backgroundColor=bb;d.style.minHeight=innerHeight+"px";d.style.display="flow-root";const x=new XMLSerializer().serializeToString(document.documentElement);parent.postMessage({__barixShot:${JSON.stringify(id)},xml:x},"*")}catch(e){parent.postMessage({__barixShot:${JSON.stringify(id)},error:String(e)},"*")}},350));<\/script>`;
    iframe.srcdoc = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, injector + "</body>") : html + injector; document.body.appendChild(iframe);
  });
  const xml = (/^<html[^>]*xmlns=/.test(serialized) ? serialized : serialized.replace(/^<html/, '<html xmlns="http://www.w3.org/1999/xhtml"')).replace(/<script[\s\S]*?<\/script>/gi, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xml.replace(/^<\?xml[^>]*>/, "")}</foreignObject></svg>`;
  const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("could not rasterize the page")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
  const canvas = new OffscreenCanvas(width, height); const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); ctx.drawImage(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" }); return new Uint8Array(await blob.arrayBuffer());
}
