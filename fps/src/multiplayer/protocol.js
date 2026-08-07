// Thinking Break — multiplayer wire protocol and pure logic.
//
// Deliberately network-free. Everything here is a plain data transform, so
// every rule that actually matters — room codes, publish throttling,
// interpolation, damage — is unit-testable without a live connection.
// `connection.js` is the thin, mostly-untestable shim around the Supabase SDK
// that calls into this file; keeping the split this way means a bad room code
// or a broken lerp shows up in `npm test`, not in a two-browser manual check.

import { WEAPONS_BY_ID } from '../game/weapons.js';

export const PROTOCOL_VERSION = 1;

// ── Room codes ───────────────────────────────────────────────────────────────
// One code per team: short enough to read over a call, long enough that two
// unrelated teams won't collide by typing the same word.
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;

export function normalizeRoomCode(input) {
  return String(input ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRoomCode(code) {
  return ROOM_CODE_PATTERN.test(code);
}

// Deliberately missing 0/O and 1/I/L. A code is read aloud on calls and
// retyped from screenshots, and those pairs are where that goes wrong.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A fresh room code. Six characters from a 31-symbol alphabet is ~887M
 * combinations — far past the point where two teams collide by accident,
 * while still being short enough to say out loud.
 */
export function generateRoomCode(length = 6) {
  const n = CODE_ALPHABET.length;
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(length));
  let code = '';
  for (let i = 0; i < length; i++) {
    // Modulo over 256 skews slightly toward the front of the alphabet. That
    // costs a fraction of a bit of entropy on a code whose real protection is
    // being shared privately, and avoids a rejection loop for no benefit.
    const pick = bytes ? bytes[i] % n : Math.floor(Math.random() * n);
    code += CODE_ALPHABET[pick];
  }
  return code;
}

// ── Invite links ─────────────────────────────────────────────────────────────
// Typing a room code is one more thing to get wrong, and it has to happen on
// every teammate's machine. `?room=CODE` is read at boot and joined
// automatically, so sharing an arena is pasting one link into a team chat.

/** Pull a room code out of a URL query string. '' when absent or malformed. */
export function roomCodeFromUrl(search) {
  let raw;
  try {
    raw = new URLSearchParams(search ?? '').get('room');
  } catch {
    return '';
  }
  const code = normalizeRoomCode(raw);
  return isValidRoomCode(code) ? code : '';
}

// Params that describe *this* session rather than the room. An invite copied
// from inside an editor panel must not hand teammates `embed=1` — that starts
// chromeless and idle, waiting on a host webview they don't have — nor this
// machine's stale `agent=` state.
const SESSION_ONLY_PARAMS = ['embed', 'embedded', 'agent', 'host', 'debug'];

/** Build a shareable link to `code` from the current page URL. '' if invalid. */
export function buildInviteUrl(href, code) {
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) return '';
  try {
    const url = new URL(href);
    for (const param of SESSION_ONLY_PARAMS) url.searchParams.delete(param);
    url.searchParams.set('room', normalized);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

// ── Publish throttling ───────────────────────────────────────────────────────
// Position and heading are cheap to drop a few of and resync a moment later;
// health, agent state, weapon and death must never be dropped, or a teammate's
// screen shows them alive after they died, or "idle" after their agent has
// been busy for a minute. `shouldPublish` sends on a fixed cadence *or*
// immediately whenever one of those fields changes.
export function createPublishGate({ intervalMs = 80 } = {}) {
  let lastSentAt = -Infinity;
  let lastImportant = null;

  return {
    shouldPublish(now, snapshot) {
      const importantKey = `${snapshot.health}|${snapshot.agentState}|${snapshot.alive}|${snapshot.weapon}`;
      const changed = importantKey !== lastImportant;
      const due = now - lastSentAt >= intervalMs;
      if (!changed && !due) return false;
      lastSentAt = now;
      lastImportant = importantKey;
      return true;
    },
    reset() {
      lastSentAt = -Infinity;
      lastImportant = null;
    },
  };
}

// ── Remote player interpolation ─────────────────────────────────────────────
// Keeps the two most recent snapshots per remote id and lerps between them for
// rendering. Deliberately clamped rather than extrapolated: guessing where a
// player is heading after the last packet is what sends them sliding through
// a wall the instant the network hiccups.
export function createInterpolator() {
  const history = new Map(); // id -> [older, newer]

  return {
    push(id, snapshot) {
      const pair = history.get(id) ?? [];
      pair.push(snapshot);
      if (pair.length > 2) pair.shift();
      history.set(id, pair);
    },

    sample(id, now) {
      const pair = history.get(id);
      if (!pair || pair.length === 0) return null;
      if (pair.length === 1) return pair[0];
      const [a, b] = pair;
      if (b.t <= a.t) return b;
      const t = Math.min(1, Math.max(0, (now - a.t) / (b.t - a.t)));
      return {
        ...b,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: lerpAngle(a.yaw, b.yaw, t),
      };
    },

    remove(id) {
      history.delete(id);
    },
    ids() {
      return [...history.keys()];
    },
    has(id) {
      return history.has(id);
    },
    clear() {
      history.clear();
    },
  };
}

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// ── Damage ───────────────────────────────────────────────────────────────────
// Pure reducer so the shooter's optimistic local update and the eventual
// database transaction apply identical math — the visible health bar and the
// authoritative value can never drift apart over a rounding difference.
export function applyDamageToHealth(currentHealth, amount) {
  const before = currentHealth ?? 100;
  const next = Math.max(0, Math.round(before - Math.max(0, amount)));
  return { health: next, killed: next <= 0 && before > 0 };
}

// ── Player colour ────────────────────────────────────────────────────────────
// Deterministic from the id, so every client renders the same remote player
// in the same colour without agreeing on it over the network.
const PALETTE = [
  [0.95, 0.36, 0.48], [0.98, 0.62, 0.24], [0.55, 0.85, 0.98],
  [0.78, 0.45, 0.98], [0.42, 0.92, 0.62], [0.98, 0.86, 0.35],
];

export function colorForId(id) {
  let hash = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// ── Snapshot shape ────────────────────────────────────────────────────────────
// What gets written to `rooms/{code}/players/{id}` on every publish. Rounded
// so the wire payload stays small and diff-friendly.
export function buildSnapshot({ x, y, z, yaw, health, weapon, alive, agentState, kills, name, t }) {
  return {
    x: round2(x), y: round2(y), z: round2(z), yaw: round3(yaw),
    health: Math.round(health),
    // Validated against the real weapon list rather than just checked for
    // presence, so a malformed value — from a buggy or hostile peer — can
    // never reach a `WEAPONS_BY_ID[snapshot.weapon]` lookup downstream.
    weapon: typeof weapon === 'string' && WEAPONS_BY_ID[weapon] ? weapon : 'rifle',
    alive: alive !== false,
    agentState: agentState === 'busy' ? 'busy' : 'idle',
    kills: Math.max(0, Math.round(kills ?? 0)),
    name: typeof name === 'string' && name.length > 0 ? name.slice(0, 24) : null,
    t: t ?? Date.now(),
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** Defend against a malformed or malicious snapshot from the network. */
export function sanitizeSnapshot(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return buildSnapshot({
    x: finite(raw.x), y: finite(raw.y), z: finite(raw.z), yaw: finite(raw.yaw),
    health: Math.min(999, Math.max(0, finite(raw.health, 100))),
    weapon: raw.weapon, alive: raw.alive, agentState: raw.agentState,
    kills: Math.min(9999, Math.max(0, finite(raw.kills))),
    name: raw.name, t: finite(raw.t, Date.now()),
  });
}

// ── Roster (for the UI) ───────────────────────────────────────────────────────
export function summarizeRoster(players, localId) {
  return Object.entries(players ?? {})
    .filter(([id, p]) => id !== localId && p && typeof p === 'object')
    .map(([id, p]) => {
      const snap = sanitizeSnapshot(p) ?? buildSnapshot({});
      return {
        id,
        name: snap.name || `Player ${id.slice(0, 5)}`,
        agentState: snap.agentState,
        alive: snap.alive,
        health: snap.health,
        kills: snap.kills,
        color: colorForId(id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
