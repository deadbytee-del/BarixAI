import { AutoProcessor, AutoModelForImageTextToText, RawImage, env } from "@huggingface/transformers";
env.cacheDir = new URL("../.cache/hf", import.meta.url).pathname;
const id = process.argv[2] ?? "onnx-community/Qwen3.5-0.8B-ONNX";
let t0 = performance.now();
const processor = await AutoProcessor.from_pretrained(id);
const model = await AutoModelForImageTextToText.from_pretrained(id, { dtype: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" }, device: "cpu" });
console.log("load ms", (performance.now() - t0) | 0, model.constructor.name);
const image = await RawImage.read(new URL("../.cache/vision/login.png", import.meta.url).pathname);
console.log("image", image.width, image.height);
for (const q of ["What text is written on the button?", "Describe this screenshot's layout and list all visible text verbatim."]) {
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: q }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true, enable_thinking: false });
  t0 = performance.now(); const inputs = await processor(text, image);
  console.log("preprocess ms", (performance.now() - t0) | 0, "input tokens", inputs.input_ids.dims[1]);
  t0 = performance.now(); const out = await model.generate({ ...inputs, max_new_tokens: 120, do_sample: false });
  const gen = processor.batch_decode(out.slice(null, [inputs.input_ids.dims[1], null]), { skip_special_tokens: true })[0];
  console.log(`Q: ${q}\nA (${((performance.now() - t0) / 1000).toFixed(1)}s): ${gen}\n`);
}
