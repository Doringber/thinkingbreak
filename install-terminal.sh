#!/usr/bin/env bash
# Thinking Break — terminal installer (agents run outside an editor).
#
# Adapted from install-terminal.sh in Doringber/creativity ("Pango Snack"). The
# hook wiring for Claude Code / Cursor / Codex, the polling watcher and the
# LaunchAgent are the same design; the URLs, paths and names are Thinking
# Break's, and the watcher now *focuses* an already-open game window instead of
# closing and reopening the tab, so the session survives between tasks.
#
# macOS only — it uses osascript and launchd.
#
# Usage:  curl -fsSL https://doringber.github.io/thinkingbreak/install-terminal.sh | bash
# Re-run: safe (idempotent).
set -euo pipefail

GAME_URL="https://doringber.github.io/thinkingbreak/fps/"
URL_PREFIX="https://doringber.github.io/thinkingbreak/fps"
TB_DIR="$HOME/.thinking-break"
WATCH="$TB_DIR/watch.sh"
PLIST_LABEL="com.doringber.thinking-break"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
STALE_SEC=1800

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { echo -e "${BLUE}▸${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "macOS only (this installer uses osascript and launchd).
    On Linux or Windows, use the editor extensions instead:
    curl -fsSL https://doringber.github.io/thinkingbreak/install.sh | bash"
command -v osascript >/dev/null 2>&1 || die "osascript not found."
command -v python3   >/dev/null 2>&1 || die "python3 is required (it ships with macOS)."
[ -d "/Applications/Google Chrome.app" ] || warn "Google Chrome not found in /Applications — the watcher cannot open a window until it is installed."

echo ""
echo -e "  ${BLUE}◎ Thinking Break${NC} — terminal installer (Claude Code · Cursor · Codex)"
echo ""

mkdir -p "$TB_DIR"

# ── shared state-writer, one per agent; only the state path differs ──────────
write_state_script() {
  local dir="$1" state="$2"
  mkdir -p "$dir"
  cat > "$dir/agent-state.sh" <<EOF
#!/usr/bin/env bash
# Thinking Break — written by install-terminal.sh; do not edit manually.
STATE="$state"
mkdir -p "\$(dirname "\$STATE")"
case "\$1" in
  busy) printf '{"busy":true,"at":%s}' "\$(date +%s)" > "\$STATE" ;;
  idle) printf '{"busy":false}' > "\$STATE" ;;
esac
EOF
  chmod +x "$dir/agent-state.sh"
}

# ── Claude Code ──────────────────────────────────────────────────────────────
install_claude() {
  [ -d "$HOME/.claude" ] || { warn "Claude Code not detected — skipping."; return; }
  say "Wiring Claude Code…"
  local dir="$HOME/.claude/thinking-break"
  write_state_script "$dir" "$dir/state.json"
  python3 - "$dir/agent-state.sh" <<'PY'
import json, os, sys

script = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
data = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        # Unparseable settings: keep a copy rather than silently discarding it.
        os.replace(path, path + ".thinking-break-backup")

busy = f'bash "{script}" busy'
idle = f'bash "{script}" idle'
hooks = data.setdefault("hooks", {})

def without_ours(entries):
    return [e for e in entries or [] if "thinking-break" not in json.dumps(e)]

hooks["PreToolUse"] = without_ours(hooks.get("PreToolUse")) + [
    {"matcher": ".*", "hooks": [{"type": "command", "command": busy}]}
]
hooks["UserPromptSubmit"] = without_ours(hooks.get("UserPromptSubmit")) + [
    {"hooks": [{"type": "command", "command": busy}]}
]
hooks["Stop"] = without_ours(hooks.get("Stop")) + [
    {"hooks": [{"type": "command", "command": idle}]}
]
hooks["SubagentStop"] = without_ours(hooks.get("SubagentStop")) + [
    {"hooks": [{"type": "command", "command": idle}]}
]

with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY
  ok "Claude Code wired."
}

# ── Cursor ───────────────────────────────────────────────────────────────────
install_cursor() {
  [ -d "$HOME/.cursor" ] || { warn "Cursor not detected — skipping."; return; }
  say "Wiring Cursor…"
  local dir="$HOME/.cursor/thinking-break"
  write_state_script "$dir" "$dir/state.json"
  python3 - "$dir/agent-state.sh" <<'PY'
import json, os, sys

script = sys.argv[1]
path = os.path.expanduser("~/.cursor/settings.json")
data = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        os.replace(path, path + ".thinking-break-backup")

hooks = data.setdefault("cursor.agent.hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["cursor.agent.hooks"] = hooks

def claim(event, arg):
    current = hooks.get(event)
    # Leave a hook the user wrote themselves alone.
    if current and "thinking-break" not in current:
        return
    hooks[event] = f'bash "{script}" {arg}'

claim("beforeSubmitPrompt", "busy")
claim("beforeShellExecution", "busy")
claim("stop", "idle")
claim("sessionEnd", "idle")

with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY
  ok "Cursor wired."
}

# ── Codex ────────────────────────────────────────────────────────────────────
install_codex() {
  [ -d "$HOME/.codex" ] || { warn "Codex not detected — skipping."; return; }
  say "Wiring Codex…"
  local dir="$HOME/.codex/thinking-break"
  write_state_script "$dir" "$dir/state.json"
  local script="$dir/agent-state.sh"
  local cfg="$HOME/.codex/config.toml"
  if grep -q "thinking-break" "$cfg" 2>/dev/null; then
    ok "Codex already wired (leaving the existing block in place)."
    return
  fi
  cat >> "$cfg" <<EOF

# >>> thinking-break-codex >>>
[hooks]
exec_before = "bash \"$script\" busy"
exec_after  = "bash \"$script\" idle"
# <<< thinking-break-codex <<<
EOF
  ok "Codex wired."
}

# ── watcher ──────────────────────────────────────────────────────────────────
install_watcher() {
  say "Installing the watcher…"
  cat > "$WATCH" <<EOF
#!/usr/bin/env bash
# Thinking Break — terminal watcher.
# Opens the game in Chrome when any agent goes busy and focuses Chrome again on
# later tasks. The tab is left open on idle: the page pauses itself, and keeping
# it alive is what lets the next task resume the same session instantly.
set -u
GAME_URL="$GAME_URL"
URL_PREFIX="$URL_PREFIX"
STALE_SEC=$STALE_SEC
POLL=1
STATE_FILES=(
  "\$HOME/.claude/thinking-break/state.json"
  "\$HOME/.cursor/thinking-break/state.json"
  "\$HOME/.codex/thinking-break/state.json"
)
open=0

is_busy() {
  [ -f "\$1" ] || return 1
  local body at now age
  body=\$(cat "\$1" 2>/dev/null) || return 1
  [[ "\$body" == *'"busy":true'* ]] || return 1
  at=\$(printf '%s' "\$body" | grep -o '"at":[0-9]*' | grep -o '[0-9]*\$')
  [ -n "\$at" ] || return 0
  now=\$(date +%s); age=\$((now - at))
  # A busy older than STALE_SEC means the agent died mid-task.
  [ "\$age" -gt "\$STALE_SEC" ] && return 1
  return 0
}

tab_exists() {
  osascript 2>/dev/null <<'APPLESCRIPT'
tell application "Google Chrome"
  if not running then return "no"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) starts with "URLPREFIX" then return "yes"
    end repeat
  end repeat
  return "no"
end tell
APPLESCRIPT
}

open_game() {
  osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "Google Chrome"
  make new window
  set URL of active tab of front window to "\$GAME_URL"
  activate
end tell
APPLESCRIPT
  open=1
}

focus_game() {
  osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "Google Chrome"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if (URL of t) starts with "\$URL_PREFIX" then
        set active tab index of w to i
        set index of w to 1
        activate
        return
      end if
    end repeat
  end repeat
end tell
APPLESCRIPT
}

while true; do
  busy=1
  for f in "\${STATE_FILES[@]}"; do
    if is_busy "\$f"; then busy=0; break; fi
  done

  if [ "\$busy" -eq 0 ]; then
    if [ "\$open" -eq 0 ]; then
      if [ "\$(tab_exists | tr -d '[:space:]')" = "yes" ]; then focus_game; open=1; else open_game; fi
    fi
  else
    # Leave the tab alone; the page pauses itself when the agent goes idle.
    open=0
  fi
  sleep "\$POLL"
done
EOF
  # Bake the prefix into the tab_exists heredoc, which cannot interpolate.
  python3 - "$WATCH" "$URL_PREFIX" <<'PY'
import sys
path, prefix = sys.argv[1], sys.argv[2]
with open(path) as fh:
    text = fh.read()
with open(path, "w") as fh:
    fh.write(text.replace("URLPREFIX", prefix))
PY
  chmod +x "$WATCH"
  ok "Watcher installed."
}

# ── launchd ──────────────────────────────────────────────────────────────────
install_launchd() {
  say "Installing the LaunchAgent…"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WATCH</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TB_DIR/watch.log</string>
  <key>StandardErrorPath</key><string>$TB_DIR/watch.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  ok "LaunchAgent loaded (starts at login)."
}

install_claude
install_cursor
install_codex
install_watcher
install_launchd

echo ""
echo -e "  ${GREEN}◎ Done.${NC}"
echo "  Run any prompt in Claude Code, Cursor or Codex — Chrome opens the game."
echo ""
echo "  Play manually:  open \"$GAME_URL\""
echo "  Stop watcher:   launchctl unload \"$PLIST\""
echo "  Logs:           tail -f $TB_DIR/watch.log"
echo "  Uninstall:      curl -fsSL https://doringber.github.io/thinkingbreak/uninstall.sh | bash"
echo ""
