# Deploying

## GitHub Pages (browser app)
1. Repo → Settings → Pages → **Source: GitHub Actions** (one time).
2. Push to `main`. `.github/workflows/pages.yml` runs the tests, builds `apps/web/dist` and deploys it.
3. The site is served from `https://<user>.github.io/<repo>/`. All asset URLs are relative; WASM (tree-sitter, ONNX Runtime, esbuild) is self-hosted; models are fetched from Hugging Face and cached by the browser.
4. GitHub Pages cannot set COOP/COEP headers, so `coi-sw.js` (a tiny service worker) re-serves responses with them to enable multi-threaded WASM. If it cannot register, Barix runs single-threaded and says so.

Local preview under a subpath: `npm run build:web && npm run serve`.

## BarixTerm publishing
`barixterm publish . --repo owner/name --pages --yes` (token from `GITHUB_TOKEN` or `gh auth login`). Steps: inspect → secret scan → build-system detection → validate (real build/test/lint) → git init/repo → remote (create if `--create`) → review → commit → push → **verify remote ref equals local HEAD** → enable Pages → poll build → **fetch the live URL and its assets**. Any failed verification stops the run and nothing is reported as deployed.
