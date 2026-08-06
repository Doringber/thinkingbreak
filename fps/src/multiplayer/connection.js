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

const SDK_VERSION = '2.45.4';

// Two CDNs, tried in order. Corporate networks routinely allowlist one and not
// the other, and from a player's side a blocked CDN is indistinguishable from
// "multiplayer is broken" — so fall through instead of failing on the first.
const SDK_SOURCES = [
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SDK_VERSION}/+esm`,
  `https://esm.sh/@supabase/supabase-js@${SDK_VERSION}`,
];

export class MultiplayerError extends Error {}

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
 *
 * @returns a session handle: `publish`, `reportHit`, `leave`, `playerId`.
 */
export async function joinRoom({ config, roomCode, onRoster, onIncomingHit, onError }) {
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
  const playerId = crypto.randomUUID();

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

  await new Promise((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reject(err instanceof Error ? err : new MultiplayerError('Could not connect to the room.'));
      }
    });
  });

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
