#!/usr/bin/env sh
# BarixTerm launcher for macOS/Linux (same behavior as BarixTerm.bat).
ROOT="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "[Barix] Node.js 20+ is required: https://nodejs.org" >&2; exit 1; }
[ "$(node -p "process.versions.node.split('.')[0]")" -ge 20 ] || { echo "[Barix] Node.js 20+ is required" >&2; exit 1; }
[ -d "$ROOT/node_modules/@barix/core" ] || { echo "[Barix] First run: installing dependencies..."; (cd "$ROOT" && npm install --no-audit --no-fund) || exit 1; }
exec node "$ROOT/apps/term/bin/barixterm.js" "$@"
