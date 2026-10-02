import { test } from "node:test";
import assert from "node:assert/strict";
import { webTools, understand, ToolRegistry } from "../src/index.js";

const tool = (n) => webTools.find((t) => t.name === n);
const web = { search: async (q) => Object.assign([{ title: "T", url: "https://x.dev/", snippet: "S" }], { engine: "Test" }), fetchPage: async (u) => ({ url: u, status: 200, title: "Page", text: "hello", truncated: false, totalChars: 5 }) };

test("web tools return fenced, untrusted-labelled content with evidence, and report failures plainly", async () => {
  const s = await tool("web_search").run({ query: "x" }, { web }); assert.match(s.output, /untrusted data/); assert.match(s.output, /via Test/); assert.equal(s.evidence.kind, "web-search");
  const f = await tool("web_fetch").run({ url: "https://x.dev/" }, { web }); assert.match(f.output, /Page\nhttps:\/\/x.dev\/\n\nhello/); assert.equal(f.evidence.data.status, 200);
  const bad = await tool("web_fetch").run({ url: "http://10.0.0.1" }, { web: { fetchPage: async () => { throw new Error("private address"); } } }); assert.equal(bad.ok, false); assert.match(bad.output, /private address/);
});

test("the planner exposes web tools only when the host provides web access and the request calls for it", () => {
  const caps = { web: true, github: true };
  assert.ok(understand("search the web for the latest node release", { capabilities: caps }).toolGroups.includes("web"));
  assert.ok(understand("summarise https://example.com/post for me", { capabilities: caps }).toolGroups.includes("web"));
  assert.ok(!understand("search the web for node", { capabilities: { github: true } }).toolGroups.includes("web"), "no web capability → no web tools");
  assert.ok(understand("list my github repos", { capabilities: caps }).toolGroups.includes("github"));
  const reg = new ToolRegistry(); for (const t of webTools) reg.register(t); assert.deepEqual(reg.select({ web: true }, ["web"]).map((t) => t.name).sort(), ["web_fetch", "web_search"]); assert.equal(reg.select({}, ["web"]).length, 0);
});
