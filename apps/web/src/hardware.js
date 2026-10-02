import { MODELS } from "./models.js";
export async function probe() {
  const hw = { webgpu: false, f16: false, adapter: null, maxBufferGB: 0, memGB: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency ?? 2, isolated: !!globalThis.crossOriginIsolated, opfs: !!navigator.storage?.getDirectory, fsAccess: !!globalThis.showDirectoryPicker, webrtc: !!globalThis.RTCPeerConnection, storage: null };
  try {
    const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    if (a) { hw.webgpu = true; hw.f16 = a.features.has("shader-f16"); hw.maxBufferGB = +(a.limits.maxBufferSize / 2 ** 30).toFixed(2); const i = a.info ?? (await a.requestAdapterInfo?.()); hw.adapter = i ? [i.vendor, i.architecture, i.description].filter(Boolean).join(" ") : "unknown GPU"; }
  } catch { /* no WebGPU */ }
  try { const e = await navigator.storage?.estimate?.(); if (e) hw.storage = { quotaGB: +(e.quota / 2 ** 30).toFixed(1), usedGB: +(e.usage / 2 ** 30).toFixed(2) }; } catch {}
  return hw;
}
/** @returns {{model:object, device:"webgpu"|"wasm", dtype:string, window:number, reason:string, alternatives:object[]}} */
export function recommend(hw) {
  const gpuOk = hw.webgpu && hw.f16 && hw.maxBufferGB >= 1;
  const mem = hw.memGB ?? 4; // deviceMemory caps at 8
  let pick;
  if (gpuOk && mem >= 8 && hw.maxBufferGB >= 2) pick = MODELS[1]; else if (gpuOk && mem >= 4) pick = MODELS[1]; else pick = MODELS[0];
  const device = gpuOk ? "webgpu" : "wasm"; const cfg = pick[device];
  const reason = gpuOk ? `WebGPU with f16 detected (${hw.adapter ?? "GPU"}, max buffer ${hw.maxBufferGB}GB)` : `no usable WebGPU (${hw.webgpu ? "missing shader-f16" : "unavailable"}); using WebAssembly on CPU${hw.isolated ? " (multi-threaded)" : " (single-threaded: this page is not cross-origin isolated)"}`;
  return { model: pick, device, dtype: cfg.dtype, window: pick.window[device], mb: cfg.mb, reason, alternatives: MODELS.filter((m) => m !== pick) };
}
