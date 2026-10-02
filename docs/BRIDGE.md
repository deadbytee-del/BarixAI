# Barix Bridge — internet, your GitHub repos and a bigger model for the web app

A web page cannot read arbitrary websites (CORS), cannot keep your GitHub login safely, and a browser tab can only fit a small model. The **Bridge** is a tiny local Node server that fixes all three. It is part of BarixTerm:

```
BarixTerm.bat bridge                 # prints an address and a pairing code
```

Then in the web app: **Settings → Barix Bridge** → paste the address (default `http://127.0.0.1:8799`) and the pairing code → **Connect**. Keep the bridge window open.

## What the web app gets
| capability | how |
|---|---|
| **Internet** — `web_search`, `web_fetch` tools | the bridge fetches public pages (HTML → clean text) and searches (DuckDuckGo → Bing → Wikipedia fallbacks; or your SearXNG via `BARIX_SEARCH_URL`) |
| **Your GitHub** — `github_my_repos`, `github_repo`, `github_tree`, `github_read`, `github_issues`, `github_search_code`, `github_import` … | the bridge proxies GitHub's API **read-only** using your `gh auth login` / `GITHUB_TOKEN`. Private repos work. The token never reaches the page |
| **A much smarter model** | if Ollama / llama.cpp / LM Studio is running on your PC, the bridge exposes it and the web app uses it automatically (`--llm URL --llm-model ID --llm-window N` to point at a specific server, `--no-llm` to disable) |

Without the bridge the web app still works: Wikipedia search, pages that allow cross-origin reads, GitHub through a token you paste (public repos otherwise).

BarixTerm itself has the web tools built in too (no bridge needed): `--no-web` turns them off.

## Safety
- Listens on `127.0.0.1` only. Every request needs the pairing code (stored in `~/.barix/bridge.json`, mode 0600). Only `https://deadbytee-del.github.io` and `localhost` origins may call it (`--origin URL` adds one); it answers Chrome's Private-Network-Access preflight.
- **GitHub is GET-only**: nothing can be created, changed or deleted through the bridge.
- **Web fetches refuse private networks**: every URL and every redirect hop is DNS-resolved and refused if it points at loopback, LAN, link-local or cloud-metadata addresses; credentials in URLs are refused; size and time are capped.
- Web content is **untrusted**: tool output is fenced and labelled, and the model is told not to follow instructions found in it. (A small model can still be fooled by a hostile page — treat it like any web content.)
- The local model server's address is never revealed to the page; chat requests are streamed through.

## Honest limits
- A model's intelligence comes from its weights. Tools give a small model facts it lacks (docs, your repos, today's news); a bigger local model gives it more reasoning. The bridge does not make the in-browser 0.8B–4B model itself stronger.
- Safari blocks pages from calling `http://127.0.0.1`. Use Chrome, Edge or Firefox.
- Keyless search engines throttle or challenge some networks; Barix falls back to the next engine and says which answered.
- Browser-model tool use is only as reliable as the model: small models sometimes skip or misuse tools.
