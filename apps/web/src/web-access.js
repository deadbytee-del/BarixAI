// Internet access for the browser app. A web page cannot fetch arbitrary sites (CORS) or hold a GitHub login safely, so:
//   • with the Barix Bridge connected (a small local Node helper): full web search/fetch + the user's GitHub repos, via the bridge
//   • without it: a limited, honest fallback — Wikipedia search and pages that allow cross-origin reads
import { htmlToText } from "@barix/core";

const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return { error: t.slice(0, 200) }; } };

export function bridgeWeb({ url, token }) {
  const base = url.replace(/\/$/, ""); const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) => { const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) }); const out = await j(res); if (!res.ok) throw new Error(out.error ?? `bridge answered ${res.status}`); return out; };
  return {
    kind: "bridge",
    async search(query, { max = 6 } = {}) { const o = await post("/v1/web/search", { query, max }); return Object.assign(o.results ?? [], { engine: o.engine }); },
    async fetchPage(u, { maxChars = 12000 } = {}) { return post("/v1/web/fetch", { url: u, maxChars }); },
  };
}

export async function bridgeStatus({ url, token }) {
  const res = await fetch(url.replace(/\/$/, "") + "/v1/status", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
  const out = await j(res); if (!res.ok) throw new Error(res.status === 401 ? "wrong pairing code" : out.error ?? `status ${res.status}`); return out;
}

export function fallbackWeb() {
  return {
    kind: "browser",
    async search(query, { max = 6 } = {}) {
      const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${max}&format=json&origin=*`, { signal: AbortSignal.timeout(15000) }); const o = await r.json();
      const rs = (o.query?.search ?? []).map((x) => ({ title: x.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`, snippet: x.snippet.replace(/<[^>]+>/g, "") }));
      return Object.assign(rs, { engine: "Wikipedia only (connect the Barix Bridge for full web search)" });
    },
    async fetchPage(u, { maxChars = 12000 } = {}) {
      let res; try { res = await fetch(u, { signal: AbortSignal.timeout(15000) }); } catch { throw new Error("this site does not allow reading from a web page (CORS). Connect the Barix Bridge (Settings → Barix Bridge) to read any public website."); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`); const type = res.headers.get("content-type") ?? ""; if (type && !/^(text\/|application\/(json|xml))/i.test(type)) throw new Error(`not a text page (${type.split(";")[0]})`);
      const body = (await res.text()).slice(0, 2_000_000); const { title, text } = /html/i.test(type) ? htmlToText(body) : { title: "", text: body };
      return { url: u, status: res.status, title, text: text.slice(0, maxChars), truncated: text.length > maxChars, totalChars: text.length };
    },
  };
}
