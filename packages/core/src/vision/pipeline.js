// VisionPipeline: part of Barix's intelligence pipeline, not a separate AI the user talks to.
//   normalize → classify → type-specific perception (VLM) → measurement (pixels) → one VisualReport
// The report enters the conversation as an ordinary segment, so memory, compaction and retrieval treat
// image knowledge like everything else. Images stay in an ImageStore and can be re-queried by id.
import { ImageStore, estimateImageTokens, describeMeasured, toDataURL, sniffMime } from "./image.js";
import { collect } from "../providers/base.js";
import { BarixError } from "../util/misc.js";

export const IMAGE_TYPES = ["screenshot-website", "screenshot-app", "ui-mockup", "error-screenshot", "code-screenshot", "diagram", "chart", "document", "game-screenshot", "photo", "other"];
const SYSTEM = "You analyze images for a software assistant. Be precise and literal. Transcribe visible text exactly. Never invent text or details that are not visible. If something is unreadable, say so.";
const FOCUS = {
  "screenshot-website": "Describe this web page for someone who must rebuild it: overall layout (regions top to bottom, columns), every component (nav, hero, cards, forms, buttons, footer) with its visible text verbatim, typography (relative sizes, weights), spacing, and visual style.",
  "screenshot-app": "Describe this application UI for someone who must rebuild it: windows/panels and their layout, every control and label verbatim, state shown (selected, disabled, errors), and visual style.",
  "ui-mockup": "Describe this UI mockup for implementation: layout grid, every component with its exact text, hierarchy, alignment, spacing, rounded corners/shadows, and style.",
  "error-screenshot": "Transcribe the error EXACTLY: message text, error codes, file paths with line numbers, stack frames, command shown, and the application it came from. Then state the most likely failing component.",
  "code-screenshot": "Transcribe the code EXACTLY in one fenced code block with the language tag, preserving indentation. Note the file name if visible. Mention any highlighted lines or error underlines.",
  diagram: "List every node (with its label) and every edge (from → to, with label), and any grouping/containers. Then summarize what the diagram expresses.",
  chart: "State the chart type, title, axis labels and units, each series with its legend name, and the key data points or trends with approximate values.",
  document: "Transcribe the document text preserving headings, lists and tables (as Markdown tables). Note any signatures, stamps or handwriting separately.",
  "game-screenshot": "Describe the game state: scene, characters/objects and positions, HUD elements with their values (health, score, timers), menus, and any visible text verbatim.",
  photo: "Describe the main subjects, setting and any visible text.", other: "Describe what the image shows, and transcribe any visible text exactly.",
};

export class VisionPipeline {
  /** @param {{router:any, codec:any, store?:ImageStore, counter?:any, maxPixels?:number, reportTokens?:number}} o */
  constructor({ router, codec, store = new ImageStore(), counter, maxPixels = 1_000_000, reportTokens = 450 }) { Object.assign(this, { router, codec, store, counter, maxPixels, reportTokens }); }

  /** Register image bytes (png/jpeg/webp/gif) and return the stored entry (resized copy used for the model). */
  async ingest(bytes, { name } = {}) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const mime = sniffMime(bytes); if (mime === "application/octet-stream") throw new BarixError("EIMAGE", `${name ?? "file"} is not a supported image (png, jpeg, webp, gif)`);
    const rs = await this.codec.resize(bytes, { maxPixels: this.maxPixels }); const e = await this.store.add(rs.bytes, { mime: rs.mime, width: rs.width, height: rs.height, name }); e.original = { width: undefined }; return e;
  }
  async #vlm(entry, prompt, { maxTokens, signal } = {}) {
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt, images: [toDataURL(entry.bytes, entry.mime)] }];
    const { text } = await collect(this.router.generate({ messages, maxTokens, temperature: 0, reasoning: "off", signal }, { vision: true, promptTokens: estimateImageTokens(entry.width, entry.height) + 200, maxTokens }));
    return text.trim();
  }
  async classify(entry, { userText = "", signal } = {}) {
    const out = await this.#vlm(entry, `Classify this image as exactly one of: ${IMAGE_TYPES.join(", ")}.\nUser request context: ${userText.slice(0, 200) || "(none)"}\nAnswer with the label only.`, { maxTokens: 12, signal }).catch(() => "");
    const low = out.toLowerCase(); const hit = IMAGE_TYPES.find((t) => low.includes(t)) ?? IMAGE_TYPES.find((t) => low.replace(/[^a-z]/g, "").includes(t.replace(/[^a-z]/g, "")));
    return hit ?? this.#heuristicType(userText);
  }
  #heuristicType(t) { const l = t.toLowerCase(); return /\b(error|exception|traceback|stack)\b/.test(l) ? "error-screenshot" : /\b(website|page|css|html|landing)\b/.test(l) ? "screenshot-website" : /\b(mock|design|figma)\b/.test(l) ? "ui-mockup" : /\b(code|function)\b/.test(l) ? "code-screenshot" : /\b(diagram|flow|architecture)\b/.test(l) ? "diagram" : /\b(chart|graph|plot)\b/.test(l) ? "chart" : "other"; }

  /** Full analysis of one stored image → VisualReport (also cached on the entry). */
  async describe(entry, { userText = "", question, signal, forceType } = {}) {
    const t0 = Date.now(); const type = forceType ?? (await this.classify(entry, { userText, signal }));
    const rgba = await this.codec.decode(entry.bytes); const measured = describeMeasured(rgba);
    const ask = question ? `${question}\n\n(Be precise; transcribe text exactly.)` : `${FOCUS[type] ?? FOCUS.other}${userText ? `\nThe user's request: ${userText.slice(0, 300)}` : ""}`;
    const perception = await this.#vlm(entry, ask, { maxTokens: this.reportTokens, signal });
    const report = { id: entry.id, type, width: entry.width, height: entry.height, perception, measured, ms: Date.now() - t0 };
    report.text = renderReport(report); entry.report = report; return report;
  }
  /** Pipeline entry used by the agent: accepts [{bytes,name}|Uint8Array], returns text for the conversation + token estimate. */
  async analyze(images, { userText = "", signal, onEvent } = {}) {
    const reports = []; let imageTokens = 0;
    for (const [i, img] of images.entries()) {
      const entry = await this.ingest(img.bytes ?? img, { name: img.name }); if (i === 0) this.referenceId = entry.id; onEvent?.({ type: "vision-progress", step: `analyzing image ${i + 1}/${images.length}` });
      reports.push(await this.describe(entry, { userText, signal })); imageTokens += estimateImageTokens(entry.width, entry.height);
    }
    return { text: reports.map((r) => r.text).join("\n\n"), reports, imageTokens };
  }
  /** Ask a new question about a stored image (re-queries the VLM with the pixels, not just the old report). */
  async ask(id, question, { signal } = {}) { const e = this.store.get(id); if (!e) throw new BarixError("ENOIMAGE", `unknown image ${id}`); return this.#vlm(e, question, { maxTokens: 300, signal }); }
}

export function renderReport(r) {
  return `[Image ${r.id} · ${r.type} · ${r.width}×${r.height}]\nPerceived (by vision model; text transcription is usually reliable, colors/positions may not be):\n${r.perception || "(no description produced)"}\n\n${r.measured}`;
}
