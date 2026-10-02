// Real browser + real Barix Bridge (local Node helper): connect from Settings, then the model's tool calls reach the internet and GitHub through it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { launch, site, openBarix, fakeEndpoint, call, sendAndWait } from "./harness.js";
import { createBridge } from "../../term/src/bridge.js";
import { createNodeWeb } from "../../term/src/web-node.js";

let browser, srv;
before(async () => { browser = await launch(); srv = await site("/BarixAI/"); });
after(async () => { await browser?.close(); await srv?.close(); });

test("Settings → Barix Bridge: connect, then github_my_repos and web_fetch work from the browser through the bridge", async () => {
  const seen = [];
  const up = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === "/user") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ login: "octo" })); }
    if (req.url.startsWith("/user/repos")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify([{ full_name: "octo/secret-repo", private: true, language: "JavaScript", pushed_at: "2026-09-30T00:00:00Z", description: "my private thing" }])); }
    if (req.url === "/docs") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><title>Foo Docs</title><body><main><h1>Foo install</h1><p>Run npm i foo to install.</p>" + "<p>padding text for the main block. ".repeat(30) + "</p></main></body></html>"); }
    res.writeHead(404); res.end(); }).listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r)); const upBase = `http://127.0.0.1:${up.address().port}`;
  const ep = await fakeEndpoint([call("github_my_repos", {}), call("web_fetch", { url: `${upBase}/docs` }), "You have octo/secret-repo, and the docs say to run npm i foo."]);
  const bridge = createBridge({ token: "barix-browser-test-token", port: 0, githubToken: () => "ghp_REALTOKEN", ghApi: upBase, ghRaw: upBase + "/raw", web: createNodeWeb({ allowPrivate: true }), llm: { name: "fake-ollama", baseUrl: ep.url, model: "qwen3.5-4b", window: 32768 } }); const bport = await bridge.listen();
  try {
    const { page, errors, ctx } = await openBarix(browser, srv.url, null);   // NO model of its own: the only compute is what the bridge offers
    await page.click("#btn-settings"); await page.waitForSelector(".card h4:has-text('Barix Bridge')");
    await page.fill('input[aria-label="Bridge address"]', `http://127.0.0.1:${bport}`); await page.fill('input[aria-label="Pairing code"]', "wrong-code-wrong-code");
    await page.click("button:has-text('Connect')"); await page.waitForFunction(() => /Could not connect: wrong pairing code/.test(document.body.innerText), null, { timeout: 15000 });
    await page.fill('input[aria-label="Pairing code"]', "barix-browser-test-token"); await page.click("button:has-text('Connect')");
    await page.waitForFunction(() => /Connected as octo/.test(document.body.innerText), null, { timeout: 15000 });
    await page.click("button:has-text('Cancel')"); await page.waitForFunction(() => /bridge · octo/.test(document.querySelector("#chips").innerText));
    await sendAndWait(page, `List my GitHub repos and read ${upBase}/docs for me`, { timeout: 90000 });
    const msg = await page.locator(".msg.assistant").last().innerText();
    assert.match(await page.locator("#chips").innerText(), /bridge · octo/); assert.match(msg, /github_my_repos/); assert.match(msg, /web_fetch/); assert.match(msg, /octo\/secret-repo/);
    const fed = JSON.stringify(ep.calls.at(-1).messages); assert.match(fed, /octo\/secret-repo \(private\)/, "repo list reached the model"); assert.match(fed, /Foo install/, "page text reached the model"); assert.match(fed, /untrusted data/, "web content is fenced as untrusted");
    assert.ok(seen.some((s) => s.url.startsWith("/user/repos") && s.auth === "Bearer ghp_REALTOKEN"), "the bridge attached the real GitHub token upstream");
    assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).includes("ghp_REALTOKEN"), "the GitHub token never reaches the page");
    assert.deepEqual(errors.filter((e) => !/favicon|Failed to load resource.*(404|401)/.test(e)), []); await ctx.close();
  } finally { await bridge.close(); up.close(); await ep.close?.(); }
});
