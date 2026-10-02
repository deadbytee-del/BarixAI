// Serverless WebRTC connection setup (GitHub Pages has no backend). Two options ship by default:
//   ManualSignaling     copy/paste an "invite" and an "answer" between two people/devices (no server at all)
//   BroadcastSignaling  same-browser tabs via BroadcastChannel (testing, or your own devices' tabs)
// A relay signaller (WebSocket/Nostr/etc.) can implement the same { publish, subscribe } interface later;
// signalling carries only SDP/ICE, never prompts.
import { BarixError } from "../util/misc.js";
import { dataChannelTransport } from "./transport.js";

export const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }]; // public STUN only helps NAT discovery; override freely

const encode = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const decode = (s) => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
const waitIce = (pc, ms = 4000) => new Promise((res) => { if (pc.iceGatheringState === "complete") return res(); const t = setTimeout(res, ms); pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } }); });

/** Host side: returns { invite, accept(answer) -> Promise<transport> }. */
export async function createInvite({ RTC = globalThis.RTCPeerConnection, iceServers = DEFAULT_ICE, label = "peer" } = {}) {
  if (!RTC) throw new BarixError("EUNSUPPORTED", "WebRTC is not available in this environment");
  const pc = new RTC({ iceServers }); const dc = pc.createDataChannel("barix", { ordered: true });
  await pc.setLocalDescription(await pc.createOffer()); await waitIce(pc);
  const transport = dataChannelTransport(dc, label);
  return { invite: encode({ t: "offer", sdp: pc.localDescription }), transport, pc, async accept(answer) { const a = decode(answer); if (a.t !== "answer") throw new BarixError("ESIGNAL", "not an answer"); await pc.setRemoteDescription(a.sdp); await transport.ready; return transport; } };
}
/** Guest side: consumes an invite, returns { answer, transport }. */
export async function acceptInvite(invite, { RTC = globalThis.RTCPeerConnection, iceServers = DEFAULT_ICE, label = "peer" } = {}) {
  const o = decode(invite); if (o.t !== "offer") throw new BarixError("ESIGNAL", "not an invite");
  const pc = new RTC({ iceServers }); let dc; const got = new Promise((res) => { pc.ondatachannel = (e) => { dc = e.channel; res(e.channel); }; });
  await pc.setRemoteDescription(o.sdp); await pc.setLocalDescription(await pc.createAnswer()); await waitIce(pc);
  return { answer: encode({ t: "answer", sdp: pc.localDescription }), pc, transport: got.then((ch) => { const t = dataChannelTransport(ch, label); return t.ready.then(() => t); }) };
}

/** Same-origin signalling over BroadcastChannel: both tabs call connectBroadcast with opposite roles. */
export async function connectBroadcast({ channel = "barix-signal", role, RTC = globalThis.RTCPeerConnection, iceServers = [], BC = globalThis.BroadcastChannel, label = "tab" }) {
  const bc = new BC(channel); const pc = new RTC({ iceServers }); const send = (m) => bc.postMessage(m);
  pc.onicecandidate = (e) => e.candidate && send({ to: role === "host" ? "guest" : "host", ice: e.candidate });
  let transport;
  if (role === "host") {
    const dc = pc.createDataChannel("barix", { ordered: true }); transport = dataChannelTransport(dc, label);
    bc.onmessage = async (e) => { const m = e.data; if (m.to !== "host") return; if (m.answer) await pc.setRemoteDescription(m.answer); if (m.ice) await pc.addIceCandidate(m.ice).catch(() => {}); if (m.hello) { await pc.setLocalDescription(await pc.createOffer()); send({ to: "guest", offer: pc.localDescription }); } };
  } else {
    const chP = new Promise((res) => (pc.ondatachannel = (e) => res(e.channel)));
    bc.onmessage = async (e) => { const m = e.data; if (m.to !== "guest") return; if (m.offer) { await pc.setRemoteDescription(m.offer); await pc.setLocalDescription(await pc.createAnswer()); send({ to: "host", answer: pc.localDescription }); } if (m.ice) await pc.addIceCandidate(m.ice).catch(() => {}); };
    send({ to: "host", hello: true }); transport = chP.then((ch) => dataChannelTransport(ch, label));
  }
  const t = await transport; await t.ready; t.onClose(() => { bc.close(); }); return t;
}
