#!/usr/bin/env bash
# Thinking Break — one-line installer for VS Code, Cursor and Codex.
#
# Adapted from install.sh in Doringber/creativity ("Pango Snack"): the download,
# build-and-package flow and the IDE CLI resolution are the same shape, with the
# shared-source sync step added and the project renamed throughout.
#
# Usage:  curl -fsSL https://doringber.github.io/thinkingbreak/install.sh | bash
# Re-run: safe (idempotent).
set -euo pipefail
export CI=true  # npm auto-yes on the prompts it still emits

REPO="Doringber/thinkingbreak"
BRANCH="${THINKING_BREAK_BRANCH:-main}"
TARBALL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { echo -e "${BLUE}▸${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

echo ""
echo -e "  ${BLUE}◎ Thinking Break${NC} — installer"
echo ""

# ── prerequisites ─────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is required. Install it from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar  >/dev/null 2>&1 || die "tar is required."

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required (found $(node --version))."

HAS_CODE=false; HAS_CURSOR=false; HAS_CODEX=false
command -v code   >/dev/null 2>&1 && HAS_CODE=true
command -v cursor >/dev/null 2>&1 && HAS_CURSOR=true
command -v codex  >/dev/null 2>&1 && HAS_CODEX=true

if ! $HAS_CODE && ! $HAS_CURSOR; then
  die "Neither 'code' (VS Code) nor 'cursor' (Cursor) was found in PATH.
    Open your editor and run its 'Shell Command: Install ... command in PATH' action, then rerun."
fi

# Resolve the real IDE CLI for --install-extension. The binary on PATH may be a
# wrapper (Cursor's agent CLI, for one) that rejects --install-extension, so
# prefer the CLI inside the app bundle. Override with $CODE_CLI / $CURSOR_CLI.
resolve_ide_cli() {
  local name="$1" p
  case "$name" in
    code)
      [ -n "${CODE_CLI:-}" ] && [ -x "$CODE_CLI" ] && { echo "$CODE_CLI"; return 0; }
      for p in "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
               "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
               "/usr/share/code/bin/code" "/usr/local/bin/code" "/opt/homebrew/bin/code"; do
        [ -x "$p" ] && { echo "$p"; return 0; }
      done ;;
    cursor)
      [ -n "${CURSOR_CLI:-}" ] && [ -x "$CURSOR_CLI" ] && { echo "$CURSOR_CLI"; return 0; }
      for p in "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
               "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
               "/usr/local/bin/cursor" "/opt/homebrew/bin/cursor"; do
        [ -x "$p" ] && { echo "$p"; return 0; }
      done ;;
  esac
  command -v "$name" 2>/dev/null && return 0
  return 1
}

# ── download ──────────────────────────────────────────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say "Downloading Thinking Break…"
curl -fsSL "$TARBALL" | tar -xz -C "$WORK" --strip-components=1 \
  || die "Download failed. Check your internet connection."

[ -d "$WORK/extensions/shared" ] || die "Downloaded archive is missing extensions/ — is the branch correct?"

# ── build ─────────────────────────────────────────────────────────────────────
say "Installing build dependencies…"
( cd "$WORK" && npm install --silent --no-audit --no-fund ) </dev/null \
  || die "npm install failed."

say "Compiling extensions…"
( cd "$WORK" && node tools/build-extensions.js ) </dev/null \
  || die "Compilation failed."

build_and_install() {
  local dir="$1" cli="$2" label="$3"
  local vsix="$WORK/${dir}.vsix"

  say "Packaging ${label}…"
  # `</dev/null` so vsce never tries to read from the curl pipe.
  ( cd "$WORK/extensions/$dir" \
      && npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository -o "$vsix" >/dev/null 2>&1 ) </dev/null \
    || die "Could not package the ${label} extension."

  local real_cli
  real_cli=$(resolve_ide_cli "$cli") \
    || die "Could not find the ${label} CLI. Open it, run its 'Install command in PATH' action, then rerun."

  say "Installing into ${label}…"
  "$real_cli" --install-extension "$vsix" --force >/dev/null \
    && ok "Installed in ${label}." \
    || die "Failed to install into ${label}."
}

$HAS_CODE   && build_and_install "claude" "code"   "VS Code (Claude Code)"
$HAS_CURSOR && build_and_install "cursor" "cursor" "Cursor"

if $HAS_CODEX; then
  if $HAS_CODE; then
    build_and_install "codex" "code" "VS Code (Codex)"
  else
    warn "The Codex extension targets VS Code; Cursor users can use Cursor's own agent instead."
  fi
else
  warn "Codex CLI not found in PATH — skipping. Install it from https://github.com/openai/codex"
fi

echo ""
echo -e "  ${GREEN}◎ Done.${NC}"
echo "  Open your editor and give your agent a task. The game opens a few seconds in,"
echo "  and pauses — saving your session — the moment the agent finishes."
echo ""
echo "  Play in a browser:  https://doringber.github.io/thinkingbreak/fps/"
echo "  Open manually:      Ctrl/Cmd+Shift+P → 'Thinking Break: Open Game'"
$HAS_CODEX && echo "  Codex:              restart your terminal so the shell wrapper takes effect."
echo "  Uninstall:          curl -fsSL https://doringber.github.io/thinkingbreak/uninstall.sh | bash"
echo ""
