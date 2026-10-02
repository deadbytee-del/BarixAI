// Internet access implemented in Node (used by BarixTerm directly and by the Barix Bridge for the browser app).
// Safety: only public http(s) hosts. Every hop (including redirects) is DNS-resolved and refused if it points at loopback, a private
// network, link-local/cloud-metadata, or similar — so a web page or a model can never use Barix to reach your local network.
import dns from "node:dns/promises";
import net from "node:net";
import { htmlToText, decodeEntities as decode } from "@barix/core";
export { htmlToText };

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)); }
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); if (x === "::" || x === "::1") return true; const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x); if (m) return isPrivateAddress(m[1]); return /^(fc|fd|fe[89ab])/.test(x) || x.startsWith("ff"); }
  return true;
}
export async function assertPublicUrl(raw, { allowPrivate = false, lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  let u; try { u = new URL(raw); } catch { throw new Error("not a valid URL"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http and https URLs are allowed");
  if (u.username || u.password) throw new Error("URLs with embedded credentials are not allowed");
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, ""); if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("local addresses are not allowed");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => { throw new Error(`cannot resolve ${host}`); });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("that address is on a private/local network; only public websites can be fetched");
  return u;
}

const UA = "Mozilla/5.0 (compatible; BarixBot/0.1; +https://github.com/deadbytee-del/BarixAI)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";   // the search endpoint rejects unknown bots
const TEXTY = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-yaml|yaml|rss\+xml|atom\+xml)|image\/svg)/i;

export function createNodeWeb({ fetchImpl = (...a) => fetch(...a), allowPrivate = false, lookup, maxBytes = 2_000_000, timeoutMs = 15_000, searchUrl = process.env.BARIX_SEARCH_URL } = {}) {
  async function get(url, { accept = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", ua = UA } = {}) {
    let cur = url;
    for (let hop = 0; hop < 6; hop++) {
      const u = await assertPublicUrl(cur, { allowPrivate, lookup });
      const res = await fetchImpl(u, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": ua, accept, "accept-language": "en" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { cur = new URL(res.headers.get("location"), u).toString(); continue; }
      return { res, url: u.toString() };
    }
    throw new Error("too many redirects");
  }
  async function readBody(res) { // bounded read
    const reader = res.body?.getReader?.(); if (!reader) return new TextDecoder().decode(await res.arrayBuffer()).slice(0, maxBytes);
    const chunks = []; let n = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; if (n > maxBytes) { try { await reader.cancel(); } catch {} break; } }
    return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))).slice(0, maxBytes);
  }
  return {
    async fetchPage(url, { maxChars = 12000 } = {}) {
      const { res, url: finalUrl } = await get(url); const type = res.headers.get("content-type") ?? "";
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (type && !TEXTY.test(type)) throw new Error(`not a text page (${type.split(";")[0]}); only HTML, text, JSON and XML are read`);
      const body = await readBody(res); let title = "", text;
      if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) ({ title, text } = htmlToText(body)); else text = body;
      const totalChars = text.length; const cut = text.length > maxChars;
      return { url: finalUrl, status: res.status, title, text: cut ? text.slice(0, maxChars) : text, truncated: cut, totalChars };
    },
    async search(query, { max = 6 } = {}) {
      if (searchUrl) { // SearXNG-compatible JSON endpoint, e.g. http://localhost:8888/search
        const u = new URL(searchUrl); u.searchParams.set("q", query); u.searchParams.set("format", "json"); const { res } = await get(u.toString(), { accept: "application/json" });
        if (!res.ok) throw new Error(`search server answered ${res.status}`); const j = await res.json(); return (j.results ?? []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
      }
      // Keyless engines, tried in order; a bot-challenge page or an empty parse moves on to the next. The last resort (Wikipedia) always answers factual queries.
      const engines = [
        ["DuckDuckGo", `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parseDuckDuckGo, BROWSER_UA],
        ["DuckDuckGo Lite", `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, parseDdgLite, BROWSER_UA],
        ["Bing", `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, parseBing, BROWSER_UA],
      ]; const errors = [];
      for (const [name, url, parse, ua] of engines) {
        try { const { res } = await get(url, { ua }); if (!res.ok) { errors.push(`${name}: HTTP ${res.status}`); continue; } const rs = parse(await readBody(res)).slice(0, max); if (rs.length) return Object.assign(rs, { engine: name }); errors.push(`${name}: no results (possibly blocked)`); } catch (e) { errors.push(`${name}: ${e.message}`); }
      }
      try { const { res } = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${max}&format=json`, { accept: "application/json" }); const j = await res.json();
        const rs = (j.query?.search ?? []).map((r) => ({ title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`, snippet: decode(r.snippet.replace(/<[^>]+>/g, "")) })); if (rs.length) return Object.assign(rs, { engine: "Wikipedia (web search engines were unavailable)" }); } catch (e) { errors.push(`Wikipedia: ${e.message}`); }
      throw new Error(`no search engine answered (${errors.join("; ")})`);
    },
  };
}

export function parseDuckDuckGo(html) {
  const out = []; const chunks = html.split(/(?=<a[^>]+class="result__a")/i).slice(1);
  for (const c of chunks) {
    const m = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(c); if (!m) continue;
    let url = decode(m[1]); const q = /[?&]uddg=([^&]+)/.exec(url); if (q) url = decodeURIComponent(q[1]); else if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:/i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(c);
    out.push({ title: decode(m[2].replace(/<[^>]+>/g, "")).trim(), url, snippet: decode((sn?.[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() });
  }
  return out;
}

export function parseDdgLite(html) {
  const out = []; const re = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]+class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi;
  for (const m of html.matchAll(re)) { let url = decode(m[1]); const q = /[?&]uddg=([^&]+)/.exec(url); if (q) url = decodeURIComponent(q[1]); if (/^https?:/i.test(url)) out.push({ title: decode(m[2].replace(/<[^>]+>/g, "")).trim(), url, snippet: decode(m[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() }); }
  return out;
}
export function parseBing(html) {
  const out = []; for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/gi)) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(m[0]); if (!a) continue; let url = decode(a[1]);
    const b64 = /[?&]u=a1([^&]+)/.exec(url); if (b64) { try { url = Buffer.from(b64[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { /* keep */ } }
    if (!/^https?:/i.test(url)) continue; const sn = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(m[0]);
    out.push({ title: decode(a[2].replace(/<[^>]+>/g, "")).trim(), url, snippet: decode((sn?.[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() });
  } return out;
}
