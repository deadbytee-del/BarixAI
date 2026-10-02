// Foundation-model catalog for the browser. Sizes are the files actually downloaded for text(+vision) use.
// Selection is by measured capability (WebGPU/f16/buffer limits/memory), never by popularity.
export const MODELS = [
  { id: "onnx-community/Qwen3.5-0.8B-ONNX", name: "Barix Lite (0.8B)", params: "0.8B", webgpu: { dtype: "q4f16", mb: 650 }, wasm: { dtype: "q4", mb: 720 }, window: { webgpu: 16384, wasm: 8192 }, vision: true, quality: 0.4, minMemGB: 2, note: "Runs almost anywhere; best for quick edits and chat. Weakest at multi-step tool use." },
  { id: "onnx-community/Qwen3.5-2B-ONNX", name: "Barix Core (2B)", params: "2B", webgpu: { dtype: "q4f16", mb: 1580 }, wasm: { dtype: "q4", mb: 1750 }, window: { webgpu: 24576, wasm: 8192 }, vision: true, quality: 0.55, minMemGB: 4, note: "Good balance of speed and ability; recommended with a WebGPU-capable GPU." },
  { id: "onnx-community/Qwen3.5-4B-ONNX", name: "Barix Pro (4B)", params: "4B", webgpu: { dtype: "q4f16", mb: 2630 }, wasm: { dtype: "q4", mb: 2700 }, window: { webgpu: 32768, wasm: 8192 }, vision: true, quality: 0.7, minMemGB: 8, note: "Strongest browser option; needs a capable GPU and ~3GB of free memory." },
];
export const FOUNDATION_NOTE = "Barix runs its own context, memory, coding and verification layers around an open-weight foundation model (Qwen3.5, Apache-2.0) that executes locally in your browser.";
