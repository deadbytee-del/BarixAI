// Tiny promise RPC + event channel over postMessage (Worker <-> page, or MessagePort).
export class RpcClient {
  constructor(target) { this.t = target; this.id = 0; this.pending = new Map(); this.handlers = new Map(); target.onmessage = (e) => this.#msg(e.data); }
  #msg(m) {
    if (m?.t === "result") { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(Object.assign(new Error(m.error.message), m.error)); }
    else if (m?.t === "event") for (const fn of this.handlers.get(m.name) ?? []) fn(m.data);
    else if (m?.t === "event" || m?.type) for (const fn of this.handlers.get("*") ?? []) fn(m);
  }
  call(method, params, transfer = []) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.t.postMessage({ t: "call", id, method, params }, transfer); }); }
  on(name, fn) { (this.handlers.get(name) ?? this.handlers.set(name, new Set()).get(name)).add(fn); return () => this.handlers.get(name).delete(fn); }
}
/** Serve handlers: handlers[method](params, ctx) -> result. ctx.emit(name, data) sends an event to the caller. */
export function serve(scope, handlers, { onError } = {}) {
  const emit = (name, data) => scope.postMessage({ t: "event", name, data });
  scope.addEventListener("message", async (e) => {
    const m = e.data; if (m?.t !== "call") return;
    try { const fn = handlers[m.method]; if (!fn) throw Object.assign(new Error(`unknown method ${m.method}`), { code: "ENOMETHOD" }); const result = await fn(m.params ?? {}, { emit }); scope.postMessage({ t: "result", id: m.id, ok: true, result }); }
    catch (err) { onError?.(err); scope.postMessage({ t: "result", id: m.id, ok: false, error: { message: err.message, code: err.code, name: err.name } }); }
  });
  return { emit };
}
