// Thinking Break — shared extension activation.
//
// The Claude Code, Cursor and Codex extensions differ only in where their state
// file lives, how their hooks are installed, and what their settings are
// called. Everything else — status bar, commands, watcher, panel handling — is
// this module.

import * as vscode from "vscode";
import {
  clearStalePanelLock, closeGamePanel, isPanelOpen, openGamePanel,
  returnFocusToEditor, sendAgentState,
} from "./gamePanel";
import { createAgentWatcher, ensureStateFile } from "./agentWatcher";

export interface AgentIntegration {
  /** Command/settings namespace, e.g. `thinking-break`. */
  id: string;
  /** Settings section, e.g. `thinkingBreak`. */
  configSection: string;
  /** Human-readable agent name for status text. */
  agentName: string;
  /** Path to the busy/idle JSON file this agent's hooks write. */
  stateFile: string;
  /** Install (or repair) the agent hooks. Must be idempotent. */
  installHooks: () => void;
  /** Message shown after a manual hook install. */
  installedMessage: string;
  /** Optional extra setup, e.g. Codex process polling. */
  extraSetup?: (ctx: vscode.ExtensionContext, watcher: ReturnType<typeof createAgentWatcher>) => void;
}

export function activateIntegration(ctx: vscode.ExtensionContext, integration: AgentIntegration) {
  const cfg = <T>(key: string, fallback: T): T => {
    const value = vscode.workspace.getConfiguration(integration.configSection).get<T>(key);
    return value === undefined ? fallback : value;
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = `${integration.id}.openGame`;
  statusBar.tooltip = "Thinking Break — click to open the game";
  ctx.subscriptions.push(statusBar);

  const setStatus = (text: string, warn = false) => {
    statusBar.text = text;
    statusBar.backgroundColor = warn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    statusBar.show();
  };
  setStatus("$(target) Thinking Break");

  // A reload leaves a lock behind; drop it before the first open.
  clearStalePanelLock();
  ensureStateFile(integration.stateFile);
  try {
    integration.installHooks();
  } catch (err) {
    console.warn("Thinking Break: could not install hooks", err);
  }

  async function openGame(preserveFocus = false) {
    const opened = await openGamePanel(cfg("gameUrl", DEFAULT_GAME_URL), {
      hidePanels: cfg("hidePanelsWhenPlaying", true),
      openExternal: cfg("openInExternalBrowser", false),
      useSimpleBrowser: cfg("useSimpleBrowser", false),
      roomCode: cfg("roomCode", ""),
      preserveFocus,
    });
    if (opened) sendAgentState("busy");
    return opened;
  }

  const watcher = createAgentWatcher({
    stateFile: integration.stateFile,
    busyDelayMs: Math.max(0, cfg("delaySeconds", 3) * 1000),
    idleGraceMs: Math.max(0, cfg("idleGraceSeconds", 1.2) * 1000),
    onBusy: () => {
      if (!cfg("enabled", true)) return;
      setStatus(`$(game) Playing — ${integration.agentName} working`, true);
      // `openGamePanel` reveals an existing panel rather than making a second
      // one, and `sendAgentState` resumes the session already in it.
      void openGame(cfg("openInBackground", false));
    },
    onIdle: () => {
      if (!cfg("enabled", true)) return;
      setStatus("$(target) Thinking Break");
      // Pause the game but keep the panel: the next task then resumes the same
      // session instantly instead of reloading the page.
      sendAgentState("idle");
      const onIdleBehaviour = cfg<string>("onIdle", "pauseAndFocusEditor");
      if (onIdleBehaviour === "pauseAndClose") closeGamePanel();
      else if (onIdleBehaviour === "pauseAndFocusEditor" && isPanelOpen()) void returnFocusToEditor();
    },
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand(`${integration.id}.openGame`, async () => {
      watcher.set("busy");
      await openGame(false);
    }),
    vscode.commands.registerCommand(`${integration.id}.closeGame`, () => {
      closeGamePanel();
      setStatus("$(target) Thinking Break");
    }),
    vscode.commands.registerCommand(`${integration.id}.installHooks`, () => {
      try {
        integration.installHooks();
        void vscode.window.showInformationMessage(integration.installedMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Thinking Break: hook install failed — ${message}`);
      }
    })
  );

  integration.extraSetup?.(ctx, watcher);
  watcher.start();
  ctx.subscriptions.push({ dispose: () => { watcher.stop(); closeGamePanel(); } });

  return { watcher, openGame };
}

export const DEFAULT_GAME_URL = "https://doringber.github.io/thinkingbreak/fps/";
