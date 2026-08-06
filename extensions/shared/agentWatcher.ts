// Thinking Break — agent busy/idle watcher.
//
// The hook scripts installed for Claude Code, Cursor and Codex all do the same
// thing: write `{"busy":true|false}` to a small JSON file. This module watches
// that file and turns it into clean busy/idle edges.
//
// Adapted from the per-extension `fs.watch` logic in Doringber/creativity
// ("Pango Snack"), with three changes that matter in practice:
//   * Edges are de-duplicated, so the busy signal an agent emits on every tool
//     call does not re-trigger the open path dozens of times a minute.
//   * Idle is debounced, so the gap between two tool calls does not pause the
//     game for a fraction of a second.
//   * A stale busy state (agent crashed mid-task) times out instead of
//     wedging the game open forever.

import * as fs from "fs";
import * as path from "path";

export type AgentState = "busy" | "idle";

export interface AgentStateFile {
  busy: boolean;
  at?: number;
}

export interface WatcherOptions {
  stateFile: string;
  /** Delay before acting on a busy edge. Mirrors `delaySeconds`. */
  busyDelayMs: number;
  /** Ignore an idle that lands within this window of a busy. */
  idleGraceMs?: number;
  /** Treat a busy older than this as stale. */
  staleMs?: number;
  onBusy: () => void;
  onIdle: () => void;
}

export function createAgentWatcher(options: WatcherOptions) {
  const { stateFile, onBusy, onIdle } = options;
  const idleGraceMs = options.idleGraceMs ?? 1200;
  const staleMs = options.staleMs ?? 30 * 60 * 1000;

  let watcher: fs.FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;
  let busyTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let state: AgentState = "idle";
  let lastBusyAt = 0;
  let disposed = false;

  function readState(): AgentStateFile | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const busy = (parsed as AgentStateFile).busy;
      if (typeof busy !== "boolean") return null;
      return parsed as AgentStateFile;
    } catch {
      // Missing file, or a partial write caught mid-flush. Either way the next
      // watch event will bring a complete one.
      return null;
    }
  }

  function apply(next: AgentStateFile) {
    if (disposed) return;

    // `at` is written in seconds by the shell hooks and milliseconds by the
    // Node hook; normalise before comparing.
    const atMs = next.at === undefined ? Date.now() : next.at > 1e12 ? next.at : next.at * 1000;
    const stale = next.busy && Date.now() - atMs > staleMs;
    const wantBusy = next.busy && !stale;

    if (wantBusy) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
      lastBusyAt = Date.now();
      if (state === "busy") return; // already running: nothing to do
      state = "busy";
      clearTimeout(busyTimer);
      busyTimer = setTimeout(() => { busyTimer = undefined; onBusy(); }, options.busyDelayMs);
      return;
    }

    clearTimeout(busyTimer);
    busyTimer = undefined;
    if (state === "idle") return;

    const sinceBusy = Date.now() - lastBusyAt;
    if (sinceBusy < idleGraceMs) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        state = "idle";
        onIdle();
      }, idleGraceMs - sinceBusy);
      return;
    }
    state = "idle";
    onIdle();
  }

  function check() {
    const next = readState();
    if (next) apply(next);
  }

  function start() {
    stop();
    disposed = false;
    const dir = path.dirname(stateFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename !== path.basename(stateFile)) return;
        check();
      });
    } catch {
      // Some filesystems (network mounts, containers) do not support watching.
      // The poll below is the safety net.
    }
    // Low-frequency poll regardless: fs.watch misses events on several
    // platforms, and a missed idle would leave the game running.
    poll = setInterval(check, 2000);
    check();
  }

  function stop() {
    disposed = true;
    watcher?.close();
    watcher = undefined;
    if (poll) { clearInterval(poll); poll = undefined; }
    clearTimeout(busyTimer);
    clearTimeout(idleTimer);
    busyTimer = undefined;
    idleTimer = undefined;
  }

  return {
    start,
    stop,
    check,
    get state() { return state; },
    /** Force a state, bypassing timers. Used by the manual open command. */
    set(next: AgentState) {
      state = next;
      if (next === "busy") lastBusyAt = Date.now();
    },
  };
}

/** Write the initial state file if it does not exist yet. */
export function ensureStateFile(stateFile: string): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (!fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, JSON.stringify({ busy: false }));
  }
}

/** The shell script the agent hooks invoke. Kept identical across agents. */
export function hookScriptSource(stateFile: string): string {
  return `#!/usr/bin/env bash
# Thinking Break — written by the editor extension; do not edit manually.
STATE=${JSON.stringify(stateFile)}
mkdir -p "$(dirname "$STATE")"
case "$1" in
  busy) printf '{"busy":true,"at":%s}' "$(date +%s)" > "$STATE" ;;
  idle) printf '{"busy":false}' > "$STATE" ;;
esac
`;
}
