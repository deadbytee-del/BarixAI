// Manages model weights cached on this device (Transformers.js stores them in the browser Cache Storage).
// Everything here is local: listing and deleting never touches the network.
import { MODELS } from "./models.js";

async function openCaches() { if (!("caches" in self)) return []; const out = []; for (const k of await caches.keys()) out.push(await caches.open(k)); return out; }
const modelOf = (url) => MODELS.find((m) => url.includes(`/${m.id}/`));

/** → [{ id, name, bytes, files }] for every Barix model that has files cached on this device. */
export async function listCachedModels() {
  const found = new Map();
  for (const c of await openCaches()) for (const req of await c.keys()) {
    const m = modelOf(req.url); if (!m) continue; const res = await c.match(req); let n = +(res?.headers.get("content-length") ?? 0);
    if (!n && res) n = (await res.clone().blob()).size;
    const e = found.get(m.id) ?? { id: m.id, name: m.name, bytes: 0, files: 0 }; e.bytes += n; e.files++; found.set(m.id, e);
  }
  return [...found.values()];
}

/** Remove every cached file of one model from this device. Returns how many files were deleted. */
export async function deleteCachedModel(id) {
  let n = 0;
  for (const c of await openCaches()) for (const req of await c.keys()) if (req.url.includes(`/${id}/`)) { await c.delete(req); n++; }
  try { localStorage.removeItem("barix.modelCached." + id); } catch { /* storage blocked */ }
  return n;
}
