// Barix Worker Protocol v1. A worker is a volunteer's machine (browser tab or BarixTerm) offering
// compute for Barix: model inference, embeddings, repository indexing, and public-asset caching.
// Everything is opt-in on the worker side, authorized per peer, size-bounded and cancellable.
import { BarixError } from "../util/misc.js";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1_000_000;          // larger payloads are chunked by the transport
export const SERVICES = Object.freeze(["inference", "embeddings", "index", "cache"]);

/**
 * @typedef {{v:1, workerId:string, name:string, services:string[],
 *   models:{id:string, family:string, quant?:string, window:number, maxOutput:number, vision:boolean, tps?:number}[],
 *   embedder:{id:string, dim:number}|null, hardware:{kind:"webgpu"|"wasm"|"cpu"|"gpu", cores?:number, memGB?:number, label?:string},
 *   load:number, active:number, maxConcurrent:number, availability:"idle"|"busy"|"draining", cache?:{assets:number, bytes:number}, ts:number}} Advert
 */
export function makeAdvert({ workerId, name = "Barix worker", provider, embedder = null, hardware, maxConcurrent = 1, active = 0, availability = "idle", services, cache }) {
  const svc = services ?? [provider && "inference", embedder && "embeddings", embedder && "index", cache && "cache"].filter(Boolean);
  return {
    v: PROTOCOL_VERSION, workerId, name, services: svc,
    models: provider ? [{ id: provider.caps.model, family: provider.caps.family, quant: provider.caps.quant, window: provider.caps.window, maxOutput: provider.caps.maxOutput, vision: !!provider.caps.vision, tps: provider.caps.tps }] : [],
    embedder: embedder ? { id: embedder.id, dim: embedder.dim } : null, hardware: hardware ?? { kind: "cpu" },
    load: Math.min(1, active / Math.max(1, maxConcurrent)), active, maxConcurrent, availability, ...(cache ? { cache } : {}), ts: Date.now(),
  };
}

const T = { hello: 1, advert: 1, request: 1, event: 1, cancel: 1, ping: 1, pong: 1, bye: 1, error: 1, "asset-get": 1, "asset-data": 1 };
/** Validate an incoming message from an untrusted peer. Throws BarixError(EPROTO) with a precise reason. */
export function validateMessage(m) {
  if (!m || typeof m !== "object") throw new BarixError("EPROTO", "message is not an object");
  if (m.v !== PROTOCOL_VERSION) throw new BarixError("EPROTO", `unsupported protocol version ${m.v}`);
  if (!T[m.t]) throw new BarixError("EPROTO", `unknown message type ${m.t}`);
  if (["request", "event", "cancel", "error", "asset-get", "asset-data"].includes(m.t) && typeof m.id !== "string") throw new BarixError("EPROTO", `${m.t} requires an id`);
  if (m.t === "request") {
    if (!SERVICES.includes(m.service)) throw new BarixError("EPROTO", `unknown service ${m.service}`);
    if (m.service === "inference") {
      if (!Array.isArray(m.payload?.messages) || m.payload.messages.length > 5000) throw new BarixError("EPROTO", "inference needs a messages array");
      for (const x of m.payload.messages) if (typeof x.role !== "string" || typeof x.content !== "string") throw new BarixError("EPROTO", "bad message shape");
    }
    if (m.service === "embeddings" && (!Array.isArray(m.payload?.texts) || m.payload.texts.some((t) => typeof t !== "string"))) throw new BarixError("EPROTO", "embeddings needs texts[]");
  }
  return m;
}
export const msg = (t, extra = {}) => ({ v: PROTOCOL_VERSION, t, ...extra });
