import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createBridge } from "../src/bridge.js";
import { createNodeWeb, assertPublicUrl, htmlToText, parseDuckDuckGo, parseBing, isPrivateAddress } from "../src/web-node.js";

const TOKEN = "barix-test-token-123456";
function upstream() { // fake GitHub + a fake website
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, ua: req.headers["user-agent"] });
    if (req.url === "/user") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ login: "octo" })); }
    if (req.url.startsWith("/user/repos")) { res.writeHead(200, { "content-type": "application/json", etag: '"abc"', "x-ratelimit-remaining": "4999" }); return res.end(JSON.stringify([{ full_name: "octo/secret-repo", private: true }])); }
    if (req.url.startsWith("/raw/octo/secret-repo/main/README.md")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("# secret readme"); }
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><head><title>Docs</title><style>x{}</style></head><body><nav>menu</nav><main><h1>Install</h1><p>Run <code>npm i foo</code> &amp; go.</p><script>evil()</script>" + "<p>filler text for the main block to be long enough. ".repeat(20) + "</p></main></body></html>"); }
    res.writeHead(404); res.end("nope");
  }).listen(0, "127.0.0.1");
  return new Promise((r) => srv.once("listening", () => r({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}
async function boot(opts = {}) {
  const up = await upstream();
  const b = createBridge({ token: TOKEN, port: 0, githubToken: () => "ghp_REALTOKEN", ghApi: up.base, ghRaw: up.base + "/raw", web: createNodeWeb({ allowPrivate: true }), ...opts });
  const port = await b.listen(); const base = `http://127.0.0.1:${port}`;
  return { b, up, base, close: async () => { await b.close(); up.srv.close(); } };
}
const call = (base, path, { token = TOKEN, method = "GET", origin, body } = {}) => fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("bridge: pairing token is required; wrong or missing tokens get 401", async () => {
  const t = await boot(); try {
    assert.equal((await call(t.base, "/v1/status", { token: null })).status, 401); assert.equal((await call(t.base, "/v1/status", { token: "nope-nope-nope-nope" })).status, 401);
    const ok = await call(t.base, "/v1/status"); assert.equal(ok.status, 200); const j = await ok.json(); assert.equal(j.github.login, "octo"); assert.equal(j.web, true);
  } finally { await t.close(); }
});

test("bridge: only allow-listed web origins may call it, with Private-Network-Access headers on preflight", async () => {
  const t = await boot(); try {
    assert.equal((await call(t.base, "/v1/status", { origin: "https://evil.example" })).status, 403);
    const pre = await fetch(t.base + "/v1/web/search", { method: "OPTIONS", headers: { origin: "https://deadbytee-del.github.io", "access-control-request-method": "POST", "access-control-request-private-network": "true" } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), "https://deadbytee-del.github.io"); assert.equal(pre.headers.get("access-control-allow-private-network"), "true");
    assert.equal((await call(t.base, "/v1/status", { origin: "http://localhost:8080" })).status, 200, "local dev origins are allowed");
  } finally { await t.close(); }
});

test("bridge: GitHub proxy is read-only, attaches the user's real token server-side and never forwards the pairing token", async () => {
  const t = await boot(); try {
    const r = await call(t.base, "/gh/user/repos?per_page=5"); assert.equal(r.status, 200); assert.equal(r.headers.get("etag"), '"abc"'); assert.equal(r.headers.get("x-ratelimit-remaining"), "4999"); assert.match(JSON.stringify(await r.json()), /secret-repo/);
    const seen = t.up.seen.find((s) => s.url.startsWith("/user/repos")); assert.equal(seen.auth, "Bearer ghp_REALTOKEN"); assert.ok(!JSON.stringify(t.up.seen).includes(TOKEN), "pairing token must not reach GitHub");
    assert.equal(await (await call(t.base, "/ghraw/octo/secret-repo/main/README.md")).text(), "# secret readme");
    assert.equal((await call(t.base, "/gh/repos/octo/x/issues", { method: "POST", body: { title: "x" } })).status, 405, "no writes through the bridge");
  } finally { await t.close(); }
});

test("bridge: web_fetch reads a page as clean text, and refuses private/local addresses by default", async () => {
  const t = await boot(); try {
    const r = await call(t.base, "/v1/web/fetch", { method: "POST", body: { url: t.up.base + "/page" } }); const j = await r.json();
    assert.equal(j.title, "Docs"); assert.match(j.text, /# Install/); assert.match(j.text, /Run `?npm i foo`? & go/); assert.ok(!/evil\(\)|menu/.test(j.text), "scripts and navigation are stripped");
  } finally { await t.close(); }
  const guarded = await boot({ web: createNodeWeb() }); try { // default guard
    const r = await call(guarded.base, "/v1/web/fetch", { method: "POST", body: { url: guarded.up.base + "/page" } }); assert.equal(r.status, 422); assert.match((await r.json()).error, /private|local/);
  } finally { await guarded.close(); }
});

test("SSRF guard: private ranges, metadata, credentials and redirects into the LAN are all refused", async () => {
  for (const a of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd12::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(a), a);
  for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) assert.ok(!isPrivateAddress(a), a);
  for (const u of ["http://localhost/", "http://foo.localhost/", "http://printer.local/", "http://10.1.1.1/", "file:///etc/passwd", "http://user:pw@example.com/"]) await assert.rejects(assertPublicUrl(u), undefined, u);
  const lookup = async (h) => [{ address: h === "public.test" ? "93.184.216.34" : "10.0.0.9" }];
  await assert.rejects(assertPublicUrl("http://intranet.test/", { lookup }), /private/, "DNS pointing at a private IP");
  let hops = 0; const fetchImpl = async (u) => { hops++; return u.hostname === "public.test" ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) : new Response("secret", { status: 200, headers: { "content-type": "text/plain" } }); };
  await assert.rejects(createNodeWeb({ fetchImpl, lookup }).fetchPage("http://public.test/"), /private/, "a redirect to the metadata service is blocked"); assert.equal(hops, 1);
});

test("HTML extraction and search-result parsing", () => {
  const { title, text } = htmlToText('<title>A &amp; B</title><body><h2>Head</h2><ul><li>one</li><li>two</li></ul><pre>x = 1\ny = 2</pre><a href="https://x.dev/doc">the doc</a></body>');
  assert.equal(title, "A & B"); assert.match(text, /## Head/); assert.match(text, /- one\n- two/); assert.match(text, /```\nx = 1\ny = 2\n```/); assert.match(text, /the doc \(https:\/\/x\.dev\/doc\)/);
  const ddg = '<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&rut=x">Node.js</a><a class="result__snippet" href="#">JavaScript <b>runtime</b></a></div><div><a class="result__a" href="https://a.dev/">A</a></div>';
  assert.deepEqual(parseDuckDuckGo(ddg).map((r) => [r.title, r.url, r.snippet]), [["Node.js", "https://nodejs.org/en", "JavaScript runtime"], ["A", "https://a.dev/", ""]]);
  assert.equal(parseBing('<li class="b_algo"><h2><a href="https://example.com/x">Ex</a></h2><p>snippet here</p></li>')[0].url, "https://example.com/x");
});

test("bridge: a local model server is streamed through to the web app (and its address is never exposed)", async () => {
  const llmSrv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "qwen3.5-4b" }] })); }
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`); setTimeout(() => { res.write(`data: {"choices":[{"delta":{"content":"lo ${JSON.parse(b).model}"}}]}\n\n`); res.end("data: [DONE]\n\n"); }, 30); }); }).listen(0, "127.0.0.1"); await new Promise((r) => llmSrv.once("listening", r));
  const t = await boot({ llm: { name: "Ollama", baseUrl: `http://127.0.0.1:${llmSrv.address().port}/v1`, model: "qwen3.5-4b", window: 16384 } }); try {
    const st = await (await call(t.base, "/v1/status")).json(); assert.deepEqual(st.llm, { name: "Ollama", model: "qwen3.5-4b", window: 16384 }); assert.ok(!JSON.stringify(st).includes(String(llmSrv.address().port)), "upstream address hidden");
    assert.equal((await (await call(t.base, "/v1/llm/models")).json()).data[0].id, "qwen3.5-4b");
    assert.equal((await call(t.base, "/v1/llm/models", { token: null })).status, 401);
    const r = await call(t.base, "/v1/llm/chat/completions", { method: "POST", body: { model: "qwen3.5-4b", messages: [], stream: true } }); const txt = await r.text(); assert.match(txt, /Hel/); assert.match(txt, /lo qwen3.5-4b/); assert.match(txt, /\[DONE\]/);
    assert.equal((await call(t.base, "/v1/llm/chat/completions")).status, 405);
  } finally { await t.close(); llmSrv.close(); }
  const none = await boot(); try { assert.equal((await call(none.base, "/v1/llm/models")).status, 404); } finally { await none.close(); }
});
