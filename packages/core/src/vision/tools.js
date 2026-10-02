// Vision tools. ctx.vision = VisionPipeline; ctx.browser (optional capability) = { screenshot({url|file,width,height}) -> Uint8Array(png) }.
// Images are referenced by id (img_xxxxxxxx) or by a project path; screenshots of the project's own pages
// let Barix compare "what I built" against "what the user showed me".
import { compareImages, describeComparison } from "./image.js";

const S = (description) => ({ type: "string", description });
const P = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
async function resolveImage(ctx, ref) {
  const hit = ctx.vision.store.get(ref); if (hit) return hit;
  if (ctx.fs.exists(ref)) return ctx.vision.ingest(await ctx.fs.readBytes(ref), { name: ref });
  throw new Error(`no image "${ref}" (use an id like img_ab12cd34 from earlier analysis, or a project path to a png/jpg/webp)`);
}
export const visionTools = [
  {
    name: "analyze_image", group: "vision", requires: ["vision"], description: "Analyze an image (id or project path); optionally answer a specific question about it (re-reads the pixels).",
    parameters: P({ image: S("image id or project path"), question: S("specific question; omit for a full report") }, ["image"]),
    async run({ image, question }, ctx) {
      const e = await resolveImage(ctx, image);
      if (question) return { ok: true, output: `[${e.id}] ${await ctx.vision.ask(e.id, question, { signal: ctx.signal })}`, meta: { summary: "answered" } };
      const r = e.report ?? (await ctx.vision.describe(e, { signal: ctx.signal })); return { ok: true, output: r.text, meta: { summary: r.type } };
    },
  },
  {
    name: "preview_page", group: "browser", requires: ["browser"], mutating: false, timeoutMs: 120_000,
    description: "Render a project HTML file (or URL) in a real browser and return a screenshot id plus its analysis. Use to check how your changes actually look.",
    parameters: P({ path: S("project HTML file, or http(s) URL"), width: { type: "integer", minimum: 320, maximum: 2560 }, height: { type: "integer", minimum: 240, maximum: 2000 } }, ["path"]),
    async run({ path, width = 1280, height = 800 }, ctx) {
      const png = await ctx.browser.screenshot({ target: path, width, height, fs: ctx.fs }); const e = await ctx.vision.ingest(png, { name: `preview:${path}` }); ctx.lastPreview = e.id;
      const rgba = await ctx.vision.codec.decode(e.bytes); const { describeMeasured } = await import("./image.js");
      return { ok: true, output: `Rendered ${path} at ${width}×${height} → ${e.id}\n${describeMeasured(rgba)}${ctx.vision.referenceId ? `\nCompare with the user's reference using compare_images(${ctx.vision.referenceId}, ${e.id}).` : ""}`, evidence: { kind: "preview", data: { path, image: e.id } }, meta: { summary: e.id } };
    },
  },
  {
    name: "compare_images", group: "vision", requires: ["vision"], description: "Pixel-compare two images (reference vs current render): similarity and the regions that differ, with colors on both sides.",
    parameters: P({ reference: S("reference image id/path"), current: S("current image id/path") }, ["reference", "current"]),
    async run({ reference, current }, ctx) {
      const [a, b] = await Promise.all([resolveImage(ctx, reference), resolveImage(ctx, current)]); const [ra, rb] = await Promise.all([ctx.vision.codec.decode(a.bytes), ctx.vision.codec.decode(b.bytes)]);
      const c = compareImages(ra, rb); return { ok: true, output: describeComparison(c), data: c, evidence: { kind: "visual-compare", data: { similarity: c.similarity, reference: a.id, current: b.id } }, meta: { summary: `${(c.similarity * 100).toFixed(0)}% similar` } };
    },
  },
];
