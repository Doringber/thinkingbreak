// Thinking Break — multiplayer connection (Supabase Realtime).
//
// Loaded lazily — `game.js` only imports this file once a player opens the
// Multiplayer panel and enters a room code, so single-player pays zero extra
// network or bundle cost. The Supabase JS SDK itself is fetched from the
// esm.sh no-bundler CDN, keeping the "no build step" property of the rest of
// the game: nothing here needs npm or a bundler to run.
//
// This file is intentionally thin. Every rule that can be tested without a
// live connection — room codes, throttling, interpolation, damage math —
// lives in protocol.js instead; this just wires those onto the Supabase SDK.
//
// Each client is the sole authority over its own presence state — nobody
// else ever writes it. A shooter cannot decrement a target's health directly:
// two clients racing to own the same field is exactly the kind of bug that
// only shows up with a second browser open (the target's own routine publish
// would silently overwrite whatever the shooter just wrote). Instead a hit is
// a *signal* — sent as an ephemeral broadcast addressed to the target — and
// the target's own client applies the damage to itself. Broadcasts are never
// stored server-side, so unlike a database write there is nothing to clean up.
//
// Presence (the roster) and broadcast (hits) both ride the same per-room
// channel; there is no Supabase Auth involved — a random client-generated id
// is enough identity for a trusted-team room-code model. See
// docs/MULTIPLAYER.md for the full trust model.

import { isValidRoomCode, normalizeRoomCode } from './protocol.js';

// The major line rather than an exact patch, on purpose. Supabase's newer
// `sb_publishable_…` keys are not JWTs, and client versions from before that
// format existed reject them — pinning a patch we happened to write down once
// is how you end up debugging a "wrong key" that is in fact a stale client.
// Both CDNs resolve `@2` to the newest 2.x, so a project using either the new
// publishable key or a legacy `eyJ…` anon key gets a client that understands it.
const SDK_VERSION = '2';

// Two CDNs, tried in order. Corporate networks routinely allowlist one and not
// the other, and from a player's side a blocked CDN is indistinguishable from
// "multiplayer is broken" — so fall through instead of failing on the first.
const SDK_SOURCES = [
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SDK_VERSION}/+esm`,
  `https://esm.sh/@supabase/supabase-js@${SDK_VERSION}`,
];

export class MultiplayerError extends Error {}

// Long enough for a cold CDN fetch plus a WebSocket handshake on a slow link,
// short enough that a wrong URL or a network that blocks WebSockets says so
// instead of showing "Connecting…" forever.
const CONNECT_TIMEOUT_MS = 12_000;

/**
 * A per-tab identity. `crypto.randomUUID` needs a secure context, which a
 * teammate opening the game over plain HTTP on a LAN address does not have —
 * fall back instead of throwing a TypeError that reads like a broken game.
 */
function newPlayerId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    return [...c.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let sdkPromise = null;
function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    const failures = [];
    for (const url of SDK_SOURCES) {
      try {
        return await import(/* webpackIgnore: true */ url);
      } catch (err) {
        let host = url;
        try { host = new URL(url).host; } catch { /* keep the full url */ }
        failures.push(`${host}: ${err?.message ?? err}`);
      }
    }
    // A cached rejection would make every later Join fail without a reload,
    // so a player who reconnects (or gets on the VPN) can just press it again.
    sdkPromise = null;
    throw new MultiplayerError(
      `Could not load the multiplayer client from any CDN — check the network allows `
      + `cdn.jsdelivr.net or esm.sh. (${failures.join('; ')})`,
    );
  })();
  return sdkPromise;
}

/**
 * Join a room. Resolves once subscribed and the local presence is tracked;
 * rejects with a `MultiplayerError` on a bad room code or missing config, and
 * with whatever the network threw otherwise — callers should show the
 * message rather than silently no-op, since a player who thinks they joined
 * but did not would never know to retry.
 *
 * @param {object} opts
 * @param {(players: object, localId: string) => void} [opts.onRoster]
 *   Fires with the full current room presence state on every change.
 * @param {(amount: number, fromId: string) => void} [opts.onIncomingHit]
 *   Fires once per hit broadcast addressed to this player. Apply it to local
 *   health — nothing needs to be cleaned up, broadcasts aren't stored.
 * @param {(err: unknown) => void} [opts.onError]
 * @param {object} [opts.initialSnapshot]
 *   Published the moment the channel is live. Without it a player stays
 *   invisible until the game's next publish tick, which never comes if they
 *   joined while paused — exactly when someone opens the roster to look.
 *
 * @returns a session handle: `publish`, `reportHit`, `leave`, `playerId`.
 */
export async function joinRoom({ config, roomCode, onRoster, onIncomingHit, onError, initialSnapshot }) {
  const code = normalizeRoomCode(roomCode);
  if (!isValidRoomCode(code)) {
    throw new MultiplayerError(`"${roomCode}" is not a valid room code (4-12 letters or numbers).`);
  }
  if (!config?.url || !config?.anonKey) {
    throw new MultiplayerError('Multiplayer is not configured yet — see docs/MULTIPLAYER.md.');
  }

  const { createClient } = await loadSdk();
  const supabase = createClient(config.url, config.anonKey, {
    realtime: { params: { eventsPerSecond: 20 } },
  });

  // No Supabase Auth needed — a random id is enough identity for a
  // trusted-team room-code model, and it skips a whole setup step.
  const playerId = newPlayerId();

  const channel = supabase.channel(`room-${code}`, {
    config: { presence: { key: playerId } },
  });

  let latestRoster = {};
  channel.on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState();
    const players = {};
    for (const [id, presences] of Object.entries(state)) {
      // A given key can briefly hold more than one presence during a
      // reconnect; the most recent one is what the player actually sees.
      if (presences.length > 0) players[id] = presences[presences.length - 1];
    }
    latestRoster = players;
    onRoster?.(players, playerId);
  });

  channel.on('broadcast', { event: 'hit' }, ({ payload }) => {
    if (!payload || payload.to !== playerId) return;
    if (typeof payload.amount === 'number' && typeof payload.from === 'string') {
      onIncomingHit?.(payload.amount, payload.from);
    }
  });

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      // Nothing guarantees the callback ever fires — a network that silently
      // drops WebSockets just goes quiet — so the wait has its own deadline.
      const timer = setTimeout(() => finish(new MultiplayerError(
        'Timed out connecting to the room. Check the Supabase URL and key in '
        + 'supabaseConfig.js, and that this network allows WebSocket connections.',
      )), CONNECT_TIMEOUT_MS);

      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') return finish();
        // CLOSED arrives with no error attached. Without it here, a refused
        // subscription leaves the caller waiting on a promise that never
        // settles — the UI stuck on "Connecting…" with nothing to retry.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          finish(err instanceof Error ? err : new MultiplayerError(
            `Could not join the room (${status.toLowerCase().replace(/_/g, ' ')}).`,
          ));
        }
      });
    });
  } catch (err) {
    // Don't leave a half-open channel behind for the next Join to fight.
    try { await supabase.removeChannel(channel); } catch { /* nothing to undo */ }
    throw err;
  }

  // Be in the roster before returning, so teammates see this player even if the
  // game is paused and never reaches a publish tick.
  if (initialSnapshot) {
    try {
      await channel.track(initialSnapshot);
    } catch {
      /* the next publish retries — not worth failing the whole join over */
    }
  }

  let left = false;
  return {
    playerId,
    roomCode: code,

    publish(snapshot) {
      if (left) return Promise.resolve();
      return channel.track(snapshot).catch((err) => onError?.(err));
    },

    /** Signal a hit to `targetId`'s own client; fire-and-forget. */
    reportHit(targetId, amount) {
      if (left || targetId === playerId || !(amount > 0)) return Promise.resolve();
      return channel
        .send({ type: 'broadcast', event: 'hit', payload: { to: targetId, from: playerId, amount: Math.round(amount) } })
        .catch((err) => onError?.(err));
    },

    getRoster() {
      return latestRoster;
    },

    async leave() {
      if (left) return;
      left = true;
      try {
        await channel.untrack();
      } catch {
        /* connection may already be gone */
      }
      try {
        await supabase.removeChannel(channel);
      } catch {
        /* best effort */
      }
    },
  };
}
