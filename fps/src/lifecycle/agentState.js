// Thinking Break — agent busy/idle state machine.
//
// Adapted from the busy/idle contract in Doringber/creativity ("Pango Snack"),
// where an extension opened and closed a browser panel. Here the panel stays
// put and the *game* transitions instead, so the machine has to be idempotent:
// agents emit `busy` on every tool call, which would otherwise restart the
// session several times a second.
//
// Pure logic, no DOM — the transports live in `bridge.js`.

export const AGENT_BUSY = 'busy';
export const AGENT_IDLE = 'idle';

/** Events an agent integration may send; anything else is ignored. */
const BUSY_EVENTS = new Set(['busy', 'start', 'working', 'thinking', 'pretooluse']);
const IDLE_EVENTS = new Set(['idle', 'stop', 'done', 'complete', 'completed', 'finish', 'sessionend', 'subagentstop']);

/** Normalize a raw event name into `'busy'`, `'idle'`, or null. */
export function normalizeEvent(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (BUSY_EVENTS.has(key)) return AGENT_BUSY;
  if (IDLE_EVENTS.has(key)) return AGENT_IDLE;
  return null;
}

/**
 * @param {object} opts
 * @param {() => void} opts.onResume   Called exactly once per idle→busy edge.
 * @param {() => void} opts.onPause    Called exactly once per busy→idle edge.
 * @param {(state: string) => void} [opts.onStatus] Called on every accepted event.
 * @param {number} [opts.idleGraceMs]  Ignore an idle that lands within this
 *   window of a busy — agents flicker between tool calls, and pausing on every
 *   micro-gap makes the game unplayable.
 * @param {() => number} [opts.now]
 */
export function createAgentStateMachine({
  onResume,
  onPause,
  onStatus,
  idleGraceMs = 900,
  now = () => Date.now(),
}) {
  let state = AGENT_IDLE;
  let lastBusyAt = -Infinity;
  let pendingIdleTimer = null;
  let transitions = 0;
  let disposed = false;
  const timers = new Set();

  const setTimer = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };

  const clearPendingIdle = () => {
    if (pendingIdleTimer !== null) {
      clearTimeout(pendingIdleTimer);
      timers.delete(pendingIdleTimer);
      pendingIdleTimer = null;
    }
  };

  function goBusy() {
    clearPendingIdle();
    lastBusyAt = now();
    if (state === AGENT_BUSY) {
      onStatus?.(AGENT_BUSY); // refresh the "Agent working" label, no restart
      return false;
    }
    state = AGENT_BUSY;
    transitions += 1;
    onStatus?.(AGENT_BUSY);
    onResume?.();
    return true;
  }

  function goIdle() {
    clearPendingIdle();
    if (state === AGENT_IDLE) {
      onStatus?.(AGENT_IDLE);
      return false;
    }
    state = AGENT_IDLE;
    transitions += 1;
    onStatus?.(AGENT_IDLE);
    onPause?.();
    return true;
  }

  return {
    /** Feed a raw event name. Returns true when it caused a state change. */
    handle(rawEvent) {
      if (disposed) return false;
      const evt = normalizeEvent(rawEvent);
      if (evt === null) return false;

      if (evt === AGENT_BUSY) return goBusy();

      // Idle inside the grace window: defer instead of pausing outright, and
      // let a follow-up busy cancel it. This is what keeps play smooth across
      // an agent's back-to-back tool calls.
      const sinceBusy = now() - lastBusyAt;
      if (state === AGENT_BUSY && sinceBusy < idleGraceMs) {
        clearPendingIdle();
        pendingIdleTimer = setTimer(() => { pendingIdleTimer = null; goIdle(); }, idleGraceMs - sinceBusy);
        return false;
      }
      return goIdle();
    },
    /** Pause immediately, skipping the grace window (used on hard stop/unload). */
    forceIdle() {
      if (disposed) return false;
      return goIdle();
    },
    get state() { return state; },
    get isBusy() { return state === AGENT_BUSY; },
    /** Number of accepted edges — asserts "no duplicate resume" in tests. */
    get transitions() { return transitions; },
    get hasPendingIdle() { return pendingIdleTimer !== null; },
    dispose() {
      disposed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      pendingIdleTimer = null;
    },
  };
}
