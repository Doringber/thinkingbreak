// Thinking Break — multiplayer connection (Firebase Realtime Database).
//
// Loaded lazily — `game.js` only imports this file once a player opens the
// Multiplayer panel and enters a room code, so single-player pays zero extra
// network or bundle cost. The Firebase SDK itself is fetched from Google's
// official no-bundler ESM CDN build, keeping the "no build step" property of
// the rest of the game: nothing here needs npm or a bundler to run.
//
// This file is intentionally thin. Every rule that can be tested without a
// live connection — room codes, throttling, interpolation, damage math —
// lives in protocol.js instead; this just wires those onto the Firebase SDK.
//
// Each client is the sole authority over its own player node — nobody else
// ever writes to it. A shooter cannot decrement a target's health directly:
// two clients racing to own the same field is exactly the kind of bug that
// only shows up with a second browser open (the target's own routine publish
// would silently overwrite whatever the shooter just wrote). Instead a hit is
// a *signal* — pushed to the target's own inbox at `rooms/{code}/hits/{id}` —
// and the target's client applies the damage to itself and clears the entry.
// See docs/MULTIPLAYER.md for the security rules this expects.

import { isValidRoomCode, normalizeRoomCode } from './protocol.js';

const SDK_VERSION = '10.12.2';
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import(/* webpackIgnore: true */ `${CDN}/firebase-app.js`),
      import(/* webpackIgnore: true */ `${CDN}/firebase-auth.js`),
      import(/* webpackIgnore: true */ `${CDN}/firebase-database.js`),
    ]).then(([app, auth, db]) => ({ ...app, ...auth, ...db }));
  }
  return sdkPromise;
}

export class MultiplayerError extends Error {}

/**
 * Join a room. Resolves once authenticated and the local presence node is
 * written; rejects with a `MultiplayerError` on a bad room code or missing
 * config, and with whatever the network threw otherwise — callers should show
 * the message rather than silently no-op, since a player who thinks they
 * joined but did not would never know to retry.
 *
 * @param {object} opts
 * @param {(players: object, localId: string) => void} [opts.onRoster]
 *   Fires with the full current room state on every change.
 * @param {(amount: number, fromId: string) => void} [opts.onIncomingHit]
 *   Fires once per hit addressed to this player. Apply it to local health —
 *   the connection has already cleared the inbox entry by the time this runs.
 * @param {(err: unknown) => void} [opts.onError]
 *
 * @returns a session handle: `publish`, `reportHit`, `leave`, `playerId`.
 */
export async function joinRoom({ config, roomCode, onRoster, onIncomingHit, onError }) {
  const code = normalizeRoomCode(roomCode);
  if (!isValidRoomCode(code)) {
    throw new MultiplayerError(`"${roomCode}" is not a valid room code (4-12 letters or numbers).`);
  }
  if (!config?.apiKey || !config?.databaseURL || !config?.projectId) {
    throw new MultiplayerError('Multiplayer is not configured yet — see docs/MULTIPLAYER.md.');
  }

  const {
    initializeApp, getAuth, signInAnonymously,
    getDatabase, ref, push, onValue, onChildAdded, set, remove, onDisconnect,
  } = await loadSdk();

  // A distinct app name per room+join lets a page rejoin a different room, or
  // the same room twice, without colliding with "app already exists" from a
  // previous session.
  const app = initializeApp(config, `thinking-break-${code}-${Date.now()}`);
  const { user } = await signInAnonymously(getAuth(app));
  const playerId = user.uid;

  const db = getDatabase(app);
  const playersRef = ref(db, `rooms/${code}/players`);
  const selfRef = ref(db, `rooms/${code}/players/${playerId}`);
  const inboxRef = ref(db, `rooms/${code}/hits/${playerId}`);

  // If the tab closes, the network drops, or the browser crashes, Firebase
  // removes this node for us server-side — no heartbeat/cron needed to keep
  // a stale player from haunting everyone else's roster.
  await onDisconnect(selfRef).remove();

  let latestRoster = {};
  const unsubscribeRoster = onValue(
    playersRef,
    (snap) => {
      latestRoster = snap.val() ?? {};
      onRoster?.(latestRoster, playerId);
    },
    (err) => onError?.(err)
  );

  const unsubscribeHits = onChildAdded(
    inboxRef,
    (snap) => {
      const hit = snap.val();
      // Clear it first: if onIncomingHit throws, a bad hit still cannot get
      // stuck re-processing forever.
      remove(snap.ref).catch(() => {});
      if (hit && typeof hit.amount === 'number' && typeof hit.from === 'string') {
        onIncomingHit?.(hit.amount, hit.from);
      }
    },
    (err) => onError?.(err)
  );

  let left = false;
  return {
    playerId,
    roomCode: code,

    publish(snapshot) {
      if (left) return Promise.resolve();
      return set(selfRef, snapshot).catch((err) => onError?.(err));
    },

    /** Signal a hit to `targetId`'s own client; fire-and-forget. */
    reportHit(targetId, amount) {
      if (left || targetId === playerId || !(amount > 0)) return Promise.resolve();
      const targetInbox = ref(db, `rooms/${code}/hits/${targetId}`);
      return push(targetInbox, { amount: Math.round(amount), from: playerId, at: Date.now() })
        .catch((err) => onError?.(err));
    },

    getRoster() {
      return latestRoster;
    },

    async leave() {
      if (left) return;
      left = true;
      unsubscribeRoster();
      unsubscribeHits();
      try {
        await onDisconnect(selfRef).cancel();
      } catch {
        /* best effort */
      }
      try {
        await remove(selfRef);
      } catch {
        /* connection may already be gone */
      }
    },
  };
}
