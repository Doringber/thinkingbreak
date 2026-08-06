// Thinking Break for Cursor.
//
// Hook wiring adapted from `cursor-pango-snack/src/extension.ts` in
// Doringber/creativity. Cursor's agent hooks are plain shell commands stored
// under `cursor.agent.hooks` in `~/.cursor/settings.json`.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { activateIntegration } from "./shared/activation";
import { hookScriptSource } from "./shared/agentWatcher";

const HOME = os.homedir();
const CURSOR_DIR = path.join(HOME, ".cursor");
const STATE_DIR = path.join(CURSOR_DIR, "thinking-break");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const HOOK_SCRIPT = path.join(STATE_DIR, "agent-state.sh");
const SETTINGS_FILE = path.join(CURSOR_DIR, "settings.json");
const MARKER = "thinking-break";

export function activate(ctx: vscode.ExtensionContext) {
  activateIntegration(ctx, {
    id: "thinking-break-cursor",
    configSection: "thinkingBreakCursor",
    agentName: "Cursor",
    stateFile: STATE_FILE,
    installHooks,
    installedMessage: "Thinking Break: Cursor hooks installed. Restart Cursor to activate them.",
  });
}

function installHooks(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT, hookScriptSource(STATE_FILE), { mode: 0o755 });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable settings: keep a copy before replacing it.
      try { fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.thinking-break-backup`); } catch { /* best effort */ }
    }
  }

  const existing = settings["cursor.agent.hooks"];
  const hooks: Record<string, string> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, string>) }
      : {};

  // Only replace a hook if it is unset or already ours, so a user's own hook
  // for the same event survives an install.
  const claim = (event: string, arg: "busy" | "idle") => {
    const current = hooks[event];
    if (current && !current.includes(MARKER)) return;
    hooks[event] = `bash ${JSON.stringify(HOOK_SCRIPT)} ${arg}`;
  };

  claim("beforeSubmitPrompt", "busy");
  claim("beforeShellExecution", "busy");
  claim("stop", "idle");
  claim("sessionEnd", "idle");

  settings["cursor.agent.hooks"] = hooks;
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

export function deactivate() {
  /* activateIntegration registers its own disposal */
}
