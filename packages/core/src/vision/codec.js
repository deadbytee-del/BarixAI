// Image codecs. Interface: { decode(bytes)->{width,height,data(RGBA)}, resize(bytes,{maxPixels,maxSide})->{bytes,mime,width,height}, encodePNG(rgba)->bytes }
// Node uses sharp (bundled with the ONNX stack); browsers use createImageBitmap + OffscreenCanvas.
export async function nodeCodec() {
  const sharp = (await import("sharp")).default;
  return {
    name: "sharp",
    async decode(bytes) { const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) }; },
    async resize(bytes, { maxPixels = 1_000_000, maxSide = 1568 } = {}) {
      const m = await sharp(bytes).metadata(); let { width: w, height: h } = m; const scale = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
      if (scale >= 1 && m.format === "png") return { bytes, mime: "image/png", width: w, height: h };
      const nw = Math.max(28, Math.round(w * scale)), nh = Math.max(28, Math.round(h * scale)); const out = await sharp(bytes).resize(nw, nh, { fit: "fill" }).png().toBuffer();
      return { bytes: new Uint8Array(out), mime: "image/png", width: nw, height: nh };
    },
    async encodePNG({ width, height, data }) { return new Uint8Array(await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } }).png().toBuffer()); },
  };
}
export function browserCodec() {
  const draw = async (bytes, maxSide, maxPixels) => {
    const bmp = await createImageBitmap(new Blob([bytes])); let w = bmp.width, h = bmp.height; const scale = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
    const nw = Math.max(28, Math.round(w * scale)), nh = Math.max(28, Math.round(h * scale)); const c = new OffscreenCanvas(nw, nh); const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, nw, nh); bmp.close?.(); return { c, ctx, nw, nh, ow: w, oh: h, scale };
  };
  return {
    name: "canvas",
    async decode(bytes) { const { ctx, nw, nh } = await draw(bytes, 4096, 8_000_000); const id = ctx.getImageData(0, 0, nw, nh); return { width: nw, height: nh, data: id.data }; },
    async resize(bytes, { maxPixels = 1_000_000, maxSide = 1568 } = {}) { const { c, nw, nh } = await draw(bytes, maxSide, maxPixels); const blob = await c.convertToBlob({ type: "image/png" }); return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", width: nw, height: nh }; },
    async encodePNG({ width, height, data }) { const c = new OffscreenCanvas(width, height); c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0); return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()); },
  };
}
