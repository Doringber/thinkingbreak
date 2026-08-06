// Thinking Break — transports that feed the agent state machine.
//
// Four independent channels, all optional, all converging on one machine:
//
//   1. postMessage from the host frame  — the VS Code / Cursor webview panel.
//   2. BroadcastChannel                 — other Thinking Break tabs, and any
//                                         local tooling that wants to signal.
//   3. localStorage `storage` events    — same, for browsers/webviews where
//                                         BroadcastChannel is unavailable.
//   4. URL query (`?agent=busy`)        — the initial state on a cold open.
//
// A page opened directly by a human (no `embed` flag) starts busy so the game
// is immediately playable; a page opened by an editor panel obeys the host.

import { AGENT_BUSY, AGENT_IDLE, createAgentStateMachine, normalizeEvent } from './agentState.js';

export const CHANNEL_NAME = 'thinking-break';
export const SIGNAL_KEY = 'thinking-break/agent-signal';
export const MESSAGE_SOURCE = 'thinking-break';

/** Read the boot state from the URL. */
export function readBootConfig(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  const embedded = params.get('embed') === '1' || params.get('embedded') === '1';
  const agentParam = normalizeEvent(params.get('agent'));
  return {
    embedded,
    host: params.get('host') ?? (embedded ? 'editor' : 'browser'),
    // Standalone visitors get to play right away; embedded panels wait for the
    // host to say the agent is busy (unless it told us up front).
    initialState: agentParam ?? (embedded ? AGENT_IDLE : AGENT_BUSY),
  };
}

/**
 * Wire every available transport to one state machine.
 * @returns {{ machine: object, dispose: () => void, boot: object }}
 */
export function createAgentBridge({ onResume, onPause, onStatus, boot = readBootConfig(), idleGraceMs = 900 }) {
  const machine = createAgentStateMachine({ onResume, onPause, onStatus, idleGraceMs });
  const teardown = [];

  // ── 1. Host frame → page ──────────────────────────────────────────────────
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onMessage = (event) => {
      const data = event?.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== MESSAGE_SOURCE) return;
      if (data.type === 'agent') machine.handle(data.state);
      else if (data.type === 'ping') respond(event);
    };
    const respond = (event) => {
      try {
        event.source?.postMessage(
          { source: MESSAGE_SOURCE, type: 'pong', state: machine.state },
          '*'
        );
      } catch { /* host frame went away */ }
    };
    window.addEventListener('message', onMessage);
    teardown.push(() => window.removeEventListener('message', onMessage));

    // Tell the host we are alive so it can replay the current agent state.
    try {
      window.parent?.postMessage({ source: MESSAGE_SOURCE, type: 'ready' }, '*');
    } catch { /* not framed */ }
  }

  // ── 2. BroadcastChannel ───────────────────────────────────────────────────
  if (typeof BroadcastChannel === 'function') {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event) => {
        const data = event?.data;
        if (data && data.type === 'agent') machine.handle(data.state);
      };
      teardown.push(() => { channel.onmessage = null; channel.close(); });
    } catch { /* unsupported */ }
  }

  // ── 3. storage events ─────────────────────────────────────────────────────
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onStorage = (event) => {
      if (event.key !== SIGNAL_KEY || !event.newValue) return;
      try {
        machine.handle(JSON.parse(event.newValue).state);
      } catch { /* malformed signal */ }
    };
    window.addEventListener('storage', onStorage);
    teardown.push(() => window.removeEventListener('storage', onStorage));
  }

  // ── 4. Page lifecycle ─────────────────────────────────────────────────────
  // A hidden tab must not keep burning GPU, whatever the agent is doing.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') machine.handle(AGENT_IDLE);
    };
    document.addEventListener('visibilitychange', onVisibility);
    teardown.push(() => document.removeEventListener('visibilitychange', onVisibility));

    const onUnload = () => machine.forceIdle();
    window.addEventListener('pagehide', onUnload);
    teardown.push(() => window.removeEventListener('pagehide', onUnload));
  }

  // Apply the boot state last, so a resume runs with every transport attached.
  machine.handle(boot.initialState);

  return {
    machine,
    boot,
    dispose() {
      for (const fn of teardown) {
        try { fn(); } catch { /* best effort */ }
      }
      machine.dispose();
    },
  };
}

/** Broadcast an agent state to other tabs — used by the debug controls. */
export function signalAgent(state) {
  const normalized = normalizeEvent(state) ?? AGENT_IDLE;
  const payload = { type: 'agent', state: normalized, at: Date.now() };
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(payload);
      channel.close();
    }
  } catch { /* ignore */ }
  try {
    globalThis.localStorage?.setItem(SIGNAL_KEY, JSON.stringify(payload));
  } catch { /* ignore */ }
  return normalized;
}

export { AGENT_BUSY, AGENT_IDLE };
