export class Emitter {
  #l = new Map();
  on(type, fn) { (this.#l.get(type) ?? this.#l.set(type, new Set()).get(type)).add(fn); return () => this.off(type, fn); }
  off(type, fn) { this.#l.get(type)?.delete(fn); }
  emit(type, payload) { for (const fn of [...(this.#l.get(type) ?? []), ...(this.#l.get("*") ?? [])]) { try { fn(payload, type); } catch (e) { queueMicrotask(() => { throw e; }); } } }
}
