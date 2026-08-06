#!/usr/bin/env bash
# Thinking Break — uninstaller.
#
# Removes the hooks, the state directories, the LaunchAgent and the editor
# extensions. Only touches entries it recognises as its own, so hooks you wrote
# yourself are left alone.
#
# Usage:  curl -fsSL https://doringber.github.io/thinkingbreak/uninstall.sh | bash
set -uo pipefail

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { echo -e "${BLUE}▸${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

echo ""
echo -e "  ${BLUE}◎ Thinking Break${NC} — uninstaller"
echo ""

# ── JSON hook removal ────────────────────────────────────────────────────────
strip_json_hooks() {
  local file="$1" kind="$2"
  [ -f "$file" ] || return 0
  python3 - "$file" "$kind" <<'PY' || warn "Could not clean $1"
import json, sys

path, kind = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)

changed = False
if kind == "claude":
    hooks = data.get("hooks")
    if isinstance(hooks, dict):
        for event, entries in list(hooks.items()):
            if not isinstance(entries, list):
                continue
            kept = [e for e in entries if "thinking-break" not in json.dumps(e)]
            if len(kept) != len(entries):
                changed = True
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
        if not hooks:
            data.pop("hooks", None)
elif kind == "cursor":
    hooks = data.get("cursor.agent.hooks")
    if isinstance(hooks, dict):
        for event, command in list(hooks.items()):
            if isinstance(command, str) and "thinking-break" in command:
                del hooks[event]
                changed = True
        if not hooks:
            data.pop("cursor.agent.hooks", None)

if changed:
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print(f"cleaned {path}")
PY
}

say "Removing agent hooks…"
strip_json_hooks "$HOME/.claude/settings.json" claude
strip_json_hooks "$HOME/.cursor/settings.json" cursor

# ── fenced blocks in TOML / shell rc files ───────────────────────────────────
strip_block() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -q "thinking-break" "$file" 2>/dev/null || return 0
  python3 - "$file" <<'PY' || warn "Could not clean $1"
import sys

path = sys.argv[1]
begin, end = "# >>> thinking-break-codex >>>", "# <<< thinking-break-codex <<<"
with open(path) as fh:
    lines = fh.readlines()

out, skipping = [], False
for line in lines:
    if line.strip() == begin:
        skipping = True
        continue
    if line.strip() == end:
        skipping = False
        continue
    if not skipping:
        out.append(line)

if len(out) != len(lines):
    with open(path, "w") as fh:
        fh.writelines(out)
    print(f"cleaned {path}")
PY
}

strip_block "$HOME/.codex/config.toml"
for rc in .bashrc .zshrc .bash_profile; do
  strip_block "$HOME/$rc"
done
ok "Hooks removed."

# ── LaunchAgent (macOS terminal installer) ───────────────────────────────────
PLIST="$HOME/Library/LaunchAgents/com.doringber.thinking-break.plist"
if [ -f "$PLIST" ]; then
  say "Removing the LaunchAgent…"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  ok "LaunchAgent removed."
fi

# ── state directories ────────────────────────────────────────────────────────
say "Removing state directories…"
rm -rf "$HOME/.thinking-break" \
       "$HOME/.claude/thinking-break" \
       "$HOME/.cursor/thinking-break" \
       "$HOME/.codex/thinking-break"
ok "State removed."

# ── extensions ───────────────────────────────────────────────────────────────
say "Uninstalling editor extensions…"
for cli in code cursor; do
  command -v "$cli" >/dev/null 2>&1 || continue
  for ext in doringber.thinking-break doringber.thinking-break-cursor doringber.thinking-break-codex; do
    "$cli" --uninstall-extension "$ext" >/dev/null 2>&1 && ok "Removed $ext from $cli"
  done
done

echo ""
echo -e "  ${GREEN}◎ Uninstalled.${NC}"
echo "  Your saved game lives in the browser. To clear it, open"
echo "  https://doringber.github.io/thinkingbreak/fps/?debug=1 and choose 'clear save',"
echo "  or clear site data for doringber.github.io."
echo ""
