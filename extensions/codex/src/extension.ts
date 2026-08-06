// Thinking Break for OpenAI Codex CLI.
//
// Adapted from `codex-pango-snack/src/extension.ts` in Doringber/creativity,
// keeping its three-layer detection because no single layer covers every way
// Codex gets invoked:
//   1. `~/.codex/config.toml` hooks, where the CLI supports them.
//   2. A shell wrapper function in the user's rc files.
//   3. Process polling, as a last resort.
//
// The shell-rc patch is fenced with begin/end markers so it can be removed
// cleanly, and re-running never appends a second copy.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { activateIntegration } from "./shared/activation";
import { createAgentWatcher, hookScriptSource } from "./shared/agentWatcher";

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, ".codex");
const STATE_DIR = path.join(CODEX_DIR, "thinking-break");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const HOOK_SCRIPT = path.join(STATE_DIR, "agent-state.sh");
const CONFIG_FILE = path.join(CODEX_DIR, "config.toml");

const BEGIN = "# >>> thinking-break-codex >>>";
const END = "# <<< thinking-break-codex <<<";
const POLL_MS = 2500;

export function activate(ctx: vscode.ExtensionContext) {
  activateIntegration(ctx, {
    id: "thinking-break-codex",
    configSection: "thinkingBreakCodex",
    agentName: "Codex",
    stateFile: STATE_FILE,
    installHooks,
    installedMessage:
      "Thinking Break: Codex hooks installed. Restart your terminal so the shell wrapper takes effect.",
    extraSetup: (context, watcher) => setupProcessPolling(context, watcher),
  });
}

/**
 * Fallback detection: if the hooks never fired (older Codex build, or a shell
 * that was already open when we patched its rc), notice the process directly.
 * Only ever *adds* signal — it never contradicts a fresh hook write.
 */
function setupProcessPolling(
  ctx: vscode.ExtensionContext,
  watcher: ReturnType<typeof createAgentWatcher>
) {
  if (process.platform === "win32") return; // no pgrep

  const timer = setInterval(() => {
    if (!vscode.workspace.getConfiguration("thinkingBreakCodex").get<boolean>("processPolling", true)) {
      return;
    }
    execFile("pgrep", ["-x", "codex"], (error, stdout) => {
      const running = !error && stdout.trim().length > 0;
      const currentlyBusy = watcher.state === "busy";
      if (running === currentlyBusy) return;
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(
          STATE_FILE,
          running ? JSON.stringify({ busy: true, at: Date.now() }) : JSON.stringify({ busy: false })
        );
      } catch {
        /* state dir unwritable */
      }
      watcher.check();
    });
  }, POLL_MS);

  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function installHooks(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT, hookScriptSource(STATE_FILE), { mode: 0o755 });
  patchCodexConfig();
  patchShellRc();
}

function patchCodexConfig(): void {
  try {
    fs.mkdirSync(CODEX_DIR, { recursive: true });
    let toml = "";
    try { toml = fs.readFileSync(CONFIG_FILE, "utf8"); } catch { /* new file */ }
    if (toml.includes(BEGIN)) return;

    fs.appendFileSync(
      CONFIG_FILE,
      `\n${BEGIN}\n[hooks]\nexec_before = "bash ${HOOK_SCRIPT} busy"\nexec_after  = "bash ${HOOK_SCRIPT} idle"\n${END}\n`
    );
  } catch {
    // Config not writable — the shell wrapper and the poller still cover us.
  }
}

function patchShellRc(): void {
  const snippet = [
    BEGIN,
    "thinking_break_codex() {",
    `  bash ${JSON.stringify(HOOK_SCRIPT)} busy`,
    '  command codex "$@"',
    "  local status=$?",
    `  bash ${JSON.stringify(HOOK_SCRIPT)} idle`,
    "  return $status",
    "}",
    "alias codex=thinking_break_codex",
    END,
    "",
  ].join("\n");

  for (const name of [".bashrc", ".zshrc", ".bash_profile"]) {
    const rc = path.join(HOME, name);
    if (!fs.existsSync(rc)) continue;
    try {
      const content = fs.readFileSync(rc, "utf8");
      if (content.includes(BEGIN)) continue;
      fs.appendFileSync(rc, `\n${snippet}`);
    } catch {
      /* rc not writable */
    }
  }
}

export function deactivate() {
  /* activateIntegration registers its own disposal */
}
