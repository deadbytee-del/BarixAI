export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) { if (v == null || v === false) continue; if (k === "class") el.className = v; else if (k === "text") el.textContent = v; else if (k === "html") el.innerHTML = v; /* only ever fed by renderMarkdown(), which escapes */ else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (k === "dataset") Object.assign(el.dataset, v); else if (k in el && k !== "list") el[k] = v; else el.setAttribute(k, v === true ? "" : v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
export const fmtBytes = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
export function toast(msg, kind = "") { const t = h("div", { class: "toast " + kind, role: "status", text: msg }); Object.assign(t.style, { position: "fixed", bottom: "5rem", left: "50%", transform: "translateX(-50%)", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "10px", padding: ".5rem .9rem", boxShadow: "var(--shadow)", zIndex: 99, maxWidth: "90vw" }); document.body.append(t); setTimeout(() => t.remove(), 4200); }
export function dialog(title, body, { actions = [], onClose } = {}) {
  const d = h("dialog", {}, h("h3", { text: title }), body, h("div", { class: "actions" }, actions.map((a) => h("button", { class: a.primary ? "primary" : "secondary", type: "button", onclick: async () => { const keep = await a.run?.(d); if (keep !== false) d.close(); } }, a.label))));
  d.addEventListener("close", () => { d.remove(); onClose?.(); }); $("#dialogs").append(d); d.showModal(); return d;
}
