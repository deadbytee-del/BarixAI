#!/usr/bin/env sh
# BarixTerm launcher for macOS/Linux (same behavior as BarixTerm.bat). Works from anywhere: if the program
# files are not next to this script they are downloaded once to ~/.barix/app (BARIX_ZIP_URL overrides the source).
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "[Barix] Node.js 20+ is required: https://nodejs.org" >&2; exit 1; }
[ "$(node -p "process.versions.node.split('.')[0]")" -ge 20 ] || { echo "[Barix] Node.js 20+ is required" >&2; exit 1; }
ROOT="$HERE"
if [ ! -f "$ROOT/apps/term/bin/barixterm.js" ]; then
  ROOT="${BARIX_HOME:-$HOME/.barix}/app"
  [ "$1" = "--update" ] && rm -rf "$ROOT"
  if [ ! -f "$ROOT/apps/term/bin/barixterm.js" ]; then
    URL="${BARIX_ZIP_URL:-https://github.com/deadbytee-del/BarixAI/archive/refs/heads/main.tar.gz}"
    echo "[Barix] Program files not found next to this script - downloading once to $ROOT"
    TMP="$(mktemp -d)" && mkdir -p "$ROOT" || exit 1
    { curl -fsSL "$URL" -o "$TMP/a.tgz" || wget -q "$URL" -O "$TMP/a.tgz"; } && tar -xzf "$TMP/a.tgz" -C "$ROOT" --strip-components=1 || { echo "[Barix] Download failed; check your connection." >&2; rm -rf "$TMP" "$ROOT"; exit 1; }
    rm -rf "$TMP"
  fi
  [ "$1" = "--update" ] && { echo "[Barix] Program files are up to date in $ROOT"; exit 0; }
fi
[ -d "$ROOT/node_modules/@barix/core" ] || { echo "[Barix] First run: installing dependencies..."; (cd "$ROOT" && npm install --no-audit --no-fund) || exit 1; }
command -v git >/dev/null 2>&1 || echo "[Barix] Note: git not found; git/publishing/self-edit need it." >&2
exec node "$ROOT/apps/term/bin/barixterm.js" "$@"
