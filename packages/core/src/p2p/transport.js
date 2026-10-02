// Transports carry protocol messages between two peers. Interface:
//   { send(msg), onMessage(fn), onClose(fn), close(), ready: Promise<void>, peerLabel }
// Messages above the datachannel-safe size are chunked and reassembled transparently.
import { BarixError } from "../util/misc.js";

const CHUNK = 14_000; // conservative for RTCDataChannel interop

/** In-process pair (tests, and two roles inside one app). */
export function loopbackPair({ latencyMs = 0 } = {}) {
  const mk = () => ({ handlers: [], closeHandlers: [], closed: false });
  const a = mk(), b = mk();
  const side = (self, other, label) => ({
    peerLabel: label, ready: Promise.resolve(),
    send(m) { if (self.closed) throw new BarixError("ECLOSED", "transport closed"); const s = JSON.stringify(m); setTimeout(() => { if (!other.closed) for (const h of other.handlers) h(JSON.parse(s)); }, latencyMs); },
    onMessage(fn) { self.handlers.push(fn); }, onClose(fn) { self.closeHandlers.push(fn); },
    close() { if (self.closed) return; self.closed = true; other.closed = true; for (const h of [...self.closeHandlers, ...other.closeHandlers]) h(); },
  });
  return [side(a, b, "loopback-a"), side(b, a, "loopback-b")];
}

/** Wrap an RTCDataChannel (or any object with send/onmessage/onclose/readyState) as a Barix transport. */
export function dataChannelTransport(dc, label = "webrtc-peer") {
  const handlers = [], closers = []; const partial = new Map(); let seq = 0;
  dc.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.c) { const p = partial.get(f.c) ?? partial.set(f.c, []).get(f.c); p[f.i] = f.d; if (p.filter(Boolean).length === f.n) { partial.delete(f.c); try { const m = JSON.parse(p.join("")); for (const h of handlers) h(m); } catch { /* drop corrupt */ } } }
    else for (const h of handlers) h(f);
  };
  dc.onclose = () => closers.forEach((h) => h());
  const ready = dc.readyState === "open" ? Promise.resolve() : new Promise((res, rej) => { dc.onopen = () => res(); dc.onerror = (e) => rej(new BarixError("ECONNECT", e?.message ?? "datachannel error")); });
  return {
    peerLabel: label, ready,
    send(m) {
      const s = JSON.stringify(m); if (s.length <= CHUNK) { dc.send(s); return; }
      const id = `${Date.now().toString(36)}${seq++}`, n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) dc.send(JSON.stringify({ c: id, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
    },
    onMessage: (fn) => handlers.push(fn), onClose: (fn) => closers.push(fn), close: () => dc.close(),
    get bufferedAmount() { return dc.bufferedAmount ?? 0; },
  };
}

/** Browser/Node WebSocket (client or `ws` server socket) as a Barix transport. Same wire format as WebRTC. */
export function webSocketTransport(ws, label = "websocket-peer") { return dataChannelTransport(ws, label); }
export function connectWebSocket(url, { WS = globalThis.WebSocket, label } = {}) { const ws = new WS(url); return webSocketTransport(ws, label ?? url); }
