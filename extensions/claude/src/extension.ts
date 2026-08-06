// Thinking Break for Claude Code.
//
// Hook wiring adapted from `pango-snack/src/extension.ts` in
// Doringber/creativity, with the settings merge made non-destructive and
// SubagentStop added so a finished subagent also pauses the game.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { activateIntegration } from "./shared/activation";
import { hookScriptSource } from "./shared/agentWatcher";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const STATE_DIR = path.join(CLAUDE_DIR, "thinking-break");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const HOOK_SCRIPT = path.join(STATE_DIR, "agent-state.sh");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
const MARKER = "thinking-break";

export function activate(ctx: vscode.ExtensionContext) {
  activateIntegration(ctx, {
    id: "thinking-break",
    configSection: "thinkingBreak",
    agentName: "Claude",
    stateFile: STATE_FILE,
    installHooks,
    installedMessage: "Thinking Break: Claude Code hooks installed.",
  });
}

function installHooks(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT, hookScriptSource(STATE_FILE), { mode: 0o755 });

  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    } else {
      // Something else owns this file. Refuse rather than overwrite it.
      throw new Error(`${SETTINGS_FILE} is not a JSON object`);
    }
  } catch (err) {
    if (fs.existsSync(SETTINGS_FILE)) {
      // The file exists but could not be parsed. Overwriting would destroy a
      // user's hand-written config, so back it up first.
      const backup = `${SETTINGS_FILE}.thinking-break-backup`;
      try { fs.copyFileSync(SETTINGS_FILE, backup); } catch { /* best effort */ }
      if (err instanceof SyntaxError) settings = {};
      else throw err;
    }
  }

  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  const command = (arg: "busy" | "idle") => ({
    type: "command",
    command: `bash ${JSON.stringify(HOOK_SCRIPT)} ${arg}`,
  });

  /** Drop any previous Thinking Break entry so re-running never duplicates. */
  const withoutOurs = (entries: unknown[] | undefined): unknown[] =>
    (entries ?? []).filter((entry) => !JSON.stringify(entry).includes(MARKER));

  hooks.PreToolUse = [
    ...withoutOurs(hooks.PreToolUse),
    { matcher: ".*", hooks: [command("busy")] },
  ];
  hooks.UserPromptSubmit = [
    ...withoutOurs(hooks.UserPromptSubmit),
    { hooks: [command("busy")] },
  ];
  hooks.Stop = [...withoutOurs(hooks.Stop), { hooks: [command("idle")] }];
  hooks.SubagentStop = [...withoutOurs(hooks.SubagentStop), { hooks: [command("idle")] }];

  settings.hooks = hooks;
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

export function deactivate() {
  /* activateIntegration registers its own disposal */
}
