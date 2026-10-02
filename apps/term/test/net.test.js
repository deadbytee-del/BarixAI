import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resilientFetch, describeError } from "../src/net.js";

test("describeError shows the real cause chain, not just 'fetch failed'", () => {
  const e = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
  assert.match(describeError(e), /fetch failed ← UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate/);
});

test("when Node's fetch cannot connect, downloads fall back to the system downloader and return the same bytes", { skip: process.platform === "win32" ? false : false }, async (t) => {
  const payload = Buffer.from("model-bytes-".repeat(5000)); const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(payload); }).listen(0, "127.0.0.1"); await new Promise((r) => srv.once("listening", r));
  process.env.BARIX_FORCE_FALLBACK = "1"; const msgs = [];
  try {
    const f = resilientFetch((m) => msgs.push(m)); const res = await f(`http://127.0.0.1:${srv.address().port}/x.bin`);
    assert.equal(res.status, 200); assert.equal(Number(res.headers.get("content-length")), payload.length); assert.deepEqual(Buffer.from(await res.arrayBuffer()), payload);
    assert.ok(msgs.some((m) => /Switching to your system's downloader/.test(m)));
  } finally { delete process.env.BARIX_FORCE_FALLBACK; srv.close(); }
});
