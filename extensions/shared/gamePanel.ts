// Thinking Break — game panel management.
//
// Adapted from `snack-shared/openGamePanel.ts` in Doringber/creativity
// ("Pango Snack"), which opened the game in VS Code's Simple Browser and closed
// the panel when the agent went idle.
//
// The behaviour here is different in one important way. Closing the panel threw
// the session away and made the next open a cold start. Thinking Break instead
// hosts the game in a webview it owns, keeps that panel alive across agent
// turns, and relays busy/idle to the page over `postMessage`. Resuming is then
// instant and the run continues rather than restarting.
//
// Simple Browser remains available as a fallback for hosts where an owned
// webview is undesirable, and the single-panel lock from the original is kept
// so two editor windows never fight over one game.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const STATE_DIR = path.join(os.homedir(), ".thinking-break");
const LOCK_FILE = path.join(STATE_DIR, "panel.lock");
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export type AgentState = "busy" | "idle";

export interface OpenGameOptions {
  /** Collapse side panels so the viewport is landscape. Default true. */
  hidePanels?: boolean;
  /** Open in the system browser instead of inside the editor. Default false. */
  openExternal?: boolean;
  /** Use the built-in Simple Browser instead of an owned webview. */
  useSimpleBrowser?: boolean;
  /** Open the panel without stealing focus from the editor. */
  preserveFocus?: boolean;
  /**
   * Team room code. When set, the game joins that room on open, so a team
   * shares one arena without anyone typing a code — set it once in settings
   * (or push it through workspace settings) and every teammate's panel lands
   * in the same room. Empty means single-player.
   */
  roomCode?: string;
}

let panel: vscode.WebviewPanel | undefined;
let simpleBrowserOpen = false;
let lastState: AgentState = "idle";
/** True when the most recent open closed the side bars to make room for the game. */
let hidPanelsForGame = false;

/** Clear a lock left behind by a crashed or reloaded extension host. */
export function clearStalePanelLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* no lock to clear */
  }
}

function isPanelOpenElsewhere(): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { open: boolean; at: number; pid: number };
    if (!lock.open) return false;
    if (lock.pid === process.pid) return false;
    if (Date.now() - lock.at > LOCK_STALE_MS) {
      setPanelLock(false);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function setPanelLock(open: boolean): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (!open) {
      try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
      return;
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ open: true, at: Date.now(), pid: process.pid }));
  } catch {
    /* home directory not writable — the in-process guard still applies */
  }
}

/** Add the flags the game reads at boot. */
function gameUrl(url: string, extra: Record<string, string>): string {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    const query = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join("&");
    return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
  }
}

/**
 * Host page for the webview. It embeds the game in an iframe and forwards
 * messages both ways, which is what lets the extension pause and resume the
 * running page instead of reloading it.
 */
function webviewHtml(url: string): string {
  const origin = (() => {
    try { return new URL(url).origin; } catch { return "https://doringber.github.io"; }
  })();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    `frame-src ${origin}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0A0C12; overflow: hidden; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe id="game" src="${url}" allow="autoplay; pointer-lock; fullscreen"></iframe>
<script>
  const vscodeApi = acquireVsCodeApi();
  const frame = document.getElementById('game');
  let pending = null;

  // Extension host -> game page.
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'thinking-break') return;

    if (event.source === frame.contentWindow) {
      // Game -> extension host. A 'ready' message means the page just loaded
      // and needs the current agent state replayed.
      if (data.type === 'ready' && pending) frame.contentWindow.postMessage(pending, '*');
      vscodeApi.postMessage(data);
      return;
    }
    if (data.type === 'agent') {
      pending = data;
      try { frame.contentWindow.postMessage(data, '*'); } catch (err) { /* not loaded yet */ }
    }
  });
</script>
</body>
</html>`;
}

/**
 * Open the game, or focus it if it is already open.
 * @returns true when a panel is (now) showing the game.
 */
export async function openGamePanel(url: string, options: OpenGameOptions = {}): Promise<boolean> {
  const hidePanels = options.hidePanels !== false;
  const openExternal = options.openExternal === true;
  const preserveFocus = options.preserveFocus === true;
  // Normalized here so a stray space or lowercase setting still matches the
  // room everyone else is in; the game re-validates it either way.
  const roomCode = (options.roomCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const target = gameUrl(url, {
    embed: "1",
    agent: lastState,
    host: "editor",
    ...(roomCode ? { room: roomCode } : {}),
  });

  if (openExternal) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return true;
  }

  // Already ours: reveal it and let the caller push the agent state.
  if (panel) {
    try {
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One, preserveFocus);
      return true;
    } catch {
      panel = undefined; // disposed underneath us
    }
  }

  if (isPanelOpenElsewhere()) return false;

  if (hidePanels) {
    await prepareWideLayout();
  } else {
    hidPanelsForGame = false;
    await runCommand("workbench.action.focusFirstEditorGroup");
  }

  if (options.useSimpleBrowser) {
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", target);
      simpleBrowserOpen = true;
      setPanelLock(true);
      return true;
    } catch (err) {
      // Fall through to the webview, then to the system browser.
      console.warn("Thinking Break: Simple Browser unavailable", err);
    }
  }

  try {
    panel = vscode.window.createWebviewPanel(
      "thinkingBreak.game",
      "Thinking Break",
      { viewColumn: vscode.ViewColumn.One, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = webviewHtml(target);
    panel.onDidDispose(() => {
      panel = undefined;
      setPanelLock(false);
    });
    setPanelLock(true);
    return true;
  } catch (err) {
    panel = undefined;
    setPanelLock(false);
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Thinking Break: could not open the game — ${message}`);
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return true;
  }
}

/**
 * Tell the running game the agent changed state.
 * Safe to call when no panel exists — the state is remembered and applied to
 * the next panel that opens.
 */
export function sendAgentState(state: AgentState): void {
  lastState = state;
  if (!panel) return;
  try {
    void panel.webview.postMessage({ source: "thinking-break", type: "agent", state });
  } catch {
    /* panel disposed between the check and the post */
  }
}

/** True when a panel this extension owns is currently showing the game. */
export function isPanelOpen(): boolean {
  return panel !== undefined || simpleBrowserOpen;
}

/**
 * Return the user to whatever they were doing before the game opened.
 *
 * `prepareWideLayout` closes the primary and secondary side bars to make room
 * for the game — and one of those is commonly where an agent's chat panel
 * lives. Only re-focusing the editor group here, as this used to do, left
 * both bars closed with no visible way back to the conversation: the game
 * would open on busy, but going idle never actually returned anything. Undo
 * exactly what was closed, so a `hidePanelsWhenPlaying: false` setup — which
 * never touched the side bars — is left alone.
 */
export async function returnFocusToEditor(): Promise<void> {
  if (hidPanelsForGame) {
    await runCommand("workbench.action.focusSideBar");
    await runCommand("workbench.action.focusAuxiliaryBar");
  } else {
    await runCommand("workbench.action.focusFirstEditorGroup");
  }
}

/** Close the panel entirely. Only used by the explicit "close" command. */
export function closeGamePanel(): void {
  simpleBrowserOpen = false;
  try {
    panel?.dispose();
  } catch {
    /* already disposed */
  }
  panel = undefined;
  hidPanelsForGame = false;
  setPanelLock(false);
}

async function runCommand(command: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(command);
  } catch {
    /* command may not exist in this IDE build */
  }
}

/** Collapse side panels so the editor is wider than it is tall. */
async function prepareWideLayout(): Promise<void> {
  hidPanelsForGame = true;
  for (const command of [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closeSidebar",
    "workbench.action.editorLayoutSingle",
    "workbench.action.focusFirstEditorGroup",
  ]) {
    await runCommand(command);
  }
}
