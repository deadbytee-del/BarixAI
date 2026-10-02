// Content-addressed public-asset cache (model shards, tokenizer files, public repo blobs).
// Integrity is enforced by the *requester*: it asks for an asset by the hash it already trusts
// (from a model manifest), and rejects any bytes whose SHA-256 differs — a malicious peer cannot poison it.
import { sha256Hex } from "../util/hash.js";
import { BarixError } from "../util/misc.js";

export class AssetCache {
  constructor({ maxBytes = 512 * 1024 * 1024 } = {}) { this.maxBytes = maxBytes; this.map = new Map(); this.bytes = 0; }
  has(hash) { return this.map.has(hash); }
  get(hash) { const v = this.map.get(hash); if (v) { this.map.delete(hash); this.map.set(hash, v); } return v ?? null; }
  /** Store bytes under their own hash (local, trusted source). */
  async put(bytes) { const hash = await sha256Hex(bytes); this.#store(hash, bytes); return hash; }
  /** Accept bytes from an untrusted peer for a hash we expected. Rejects mismatches. */
  async receive(expectedHash, bytes) {
    const actual = await sha256Hex(bytes);
    if (actual !== expectedHash) throw new BarixError("EINTEGRITY", `asset hash mismatch: expected ${expectedHash.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
    this.#store(expectedHash, bytes); return bytes;
  }
  #store(hash, bytes) {
    if (this.map.has(hash)) return; this.map.set(hash, bytes); this.bytes += bytes.length;
    while (this.bytes > this.maxBytes && this.map.size > 1) { const [k, v] = this.map.entries().next().value; this.map.delete(k); this.bytes -= v.length; }
  }
  stats() { return { assets: this.map.size, bytes: this.bytes }; }
}
export const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const f32ToB64 = (f) => toB64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
export const b64ToF32 = (s) => { const u = fromB64(s); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
