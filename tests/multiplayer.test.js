import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDamageToHealth, buildInviteUrl, buildSnapshot, colorForId, createInterpolator,
  createPublishGate, generateRoomCode, isValidRoomCode, normalizeRoomCode, roomCodeFromUrl,
  sanitizeSnapshot, summarizeRoster,
} from '../fps/src/multiplayer/protocol.js';

// ── Room codes ─────────────────────────────────────────────────────────────

test('room codes are normalized to uppercase alphanumeric', () => {
  assert.equal(normalizeRoomCode(' acme-team '), 'ACMETEAM');
  assert.equal(normalizeRoomCode('bl4st!!'), 'BL4ST');
  assert.equal(normalizeRoomCode(null), '');
  assert.equal(normalizeRoomCode(undefined), '');
  assert.equal(normalizeRoomCode(42), '42');
});

test('room codes must be 4-12 letters or digits', () => {
  assert.equal(isValidRoomCode('ABCD'), true);
  assert.equal(isValidRoomCode('ABCDEFGHIJKL'), true);
  assert.equal(isValidRoomCode('ABC'), false, 'too short');
  assert.equal(isValidRoomCode('ABCDEFGHIJKLM'), false, 'too long');
  assert.equal(isValidRoomCode('AB-CD'), false, 'punctuation');
  assert.equal(isValidRoomCode('ab12'), false, 'must already be uppercase — callers normalize first');
  assert.equal(isValidRoomCode(''), false);
});

// ── Publish gate ────────────────────────────────────────────────────────────

const snap = (over = {}) => ({ health: 100, agentState: 'idle', alive: true, weapon: 'rifle', ...over });

test('the publish gate sends on the first call regardless of timing', () => {
  const gate = createPublishGate({ intervalMs: 80 });
  assert.equal(gate.shouldPublish(0, snap()), true);
});

test('the publish gate throttles unchanged snapshots to the interval', () => {
  const gate = createPublishGate({ intervalMs: 80 });
  gate.shouldPublish(0, snap());
  assert.equal(gate.shouldPublish(10, snap()), false, 'too soon, nothing important changed');
  assert.equal(gate.shouldPublish(79, snap()), false);
  assert.equal(gate.shouldPublish(80, snap()), true, 'interval elapsed');
});

test('a change to health, agentState, alive or weapon publishes immediately', () => {
  for (const patch of [{ health: 91 }, { agentState: 'busy' }, { alive: false }, { weapon: 'shotgun' }]) {
    const gate = createPublishGate({ intervalMs: 10_000 });
    gate.shouldPublish(0, snap());
    assert.equal(gate.shouldPublish(1, snap(patch)), true, `${JSON.stringify(patch)} should not wait for the interval`);
  }
});

test('the publish gate can be reset', () => {
  const gate = createPublishGate({ intervalMs: 1000 });
  gate.shouldPublish(0, snap());
  gate.reset();
  assert.equal(gate.shouldPublish(1, snap()), true, 'reset forgets the last-sent time and state');
});

// ── Interpolation ────────────────────────────────────────────────────────────

test('a single snapshot is returned as-is with no history to interpolate from', () => {
  const interp = createInterpolator();
  interp.push('p1', { x: 1, y: 2, z: 3, yaw: 0, t: 100 });
  assert.deepEqual(interp.sample('p1', 150), { x: 1, y: 2, z: 3, yaw: 0, t: 100 });
});

test('interpolation blends linearly between the two most recent snapshots', () => {
  const interp = createInterpolator();
  interp.push('p1', { x: 0, y: 0, z: 0, yaw: 0, t: 0 });
  interp.push('p1', { x: 10, y: 0, z: 0, yaw: 0, t: 100 });
  const mid = interp.sample('p1', 50);
  assert.equal(mid.x, 5);
});

test('interpolation clamps rather than extrapolates past the newest snapshot', () => {
  const interp = createInterpolator();
  interp.push('p1', { x: 0, y: 0, z: 0, yaw: 0, t: 0 });
  interp.push('p1', { x: 10, y: 0, z: 0, yaw: 0, t: 100 });
  assert.equal(interp.sample('p1', 500).x, 10, 'held at the last known position, not projected forward');
  assert.equal(interp.sample('p1', -50).x, 0, 'held at the first known position for a query before it');
});

test('only the two most recent snapshots are kept per id', () => {
  const interp = createInterpolator();
  interp.push('p1', { x: 0, y: 0, z: 0, yaw: 0, t: 0 });
  interp.push('p1', { x: 1, y: 0, z: 0, yaw: 0, t: 10 });
  interp.push('p1', { x: 2, y: 0, z: 0, yaw: 0, t: 20 });
  assert.equal(interp.sample('p1', 15).x, 1.5, 'the oldest snapshot was dropped');
});

test('yaw interpolation takes the short way around the wrap', () => {
  const interp = createInterpolator();
  const almostPi = Math.PI - 0.1;
  interp.push('p1', { x: 0, y: 0, z: 0, yaw: almostPi, t: 0 });
  interp.push('p1', { x: 0, y: 0, z: 0, yaw: -almostPi, t: 100 });
  const mid = interp.sample('p1', 50);
  // Short way is through +/-PI, not back across zero.
  assert.ok(Math.abs(mid.yaw) > 3, `expected near +/-pi, got ${mid.yaw}`);
});

test('interpolator tracks multiple ids independently', () => {
  const interp = createInterpolator();
  interp.push('a', { x: 1, y: 0, z: 0, yaw: 0, t: 0 });
  interp.push('b', { x: 2, y: 0, z: 0, yaw: 0, t: 0 });
  assert.deepEqual(interp.ids().sort(), ['a', 'b']);
  interp.remove('a');
  assert.equal(interp.has('a'), false);
  assert.equal(interp.has('b'), true);
  interp.clear();
  assert.equal(interp.ids().length, 0);
});

test('sampling an unknown id returns null instead of throwing', () => {
  const interp = createInterpolator();
  assert.equal(interp.sample('ghost', 0), null);
});

// ── Damage ───────────────────────────────────────────────────────────────────

test('damage reduces health and reports a kill only on the crossing', () => {
  assert.deepEqual(applyDamageToHealth(100, 30), { health: 70, killed: false });
  assert.deepEqual(applyDamageToHealth(20, 30), { health: 0, killed: true });
  assert.deepEqual(applyDamageToHealth(0, 30), { health: 0, killed: false }, 'already dead, not killed again');
});

test('damage never goes negative and never heals', () => {
  assert.equal(applyDamageToHealth(50, -10).health, 50, 'negative damage is clamped to zero effect');
  assert.equal(applyDamageToHealth(undefined, 10).health, 90, 'missing health defaults to 100');
});

// ── Snapshot shape and sanitisation ─────────────────────────────────────────

test('buildSnapshot rounds coordinates and fills in safe defaults', () => {
  const s = buildSnapshot({ x: 1.23456, y: 2, z: 3, yaw: 0.123456, health: 87.6 });
  assert.equal(s.x, 1.23);
  assert.equal(s.yaw, 0.123);
  assert.equal(s.health, 88);
  assert.equal(s.weapon, 'rifle');
  assert.equal(s.alive, true);
  assert.equal(s.agentState, 'idle');
});

test('sanitizeSnapshot survives a hostile or malformed payload', () => {
  assert.equal(sanitizeSnapshot(null), null);
  assert.equal(sanitizeSnapshot('not an object'), null);
  assert.equal(sanitizeSnapshot(42), null);

  const cleaned = sanitizeSnapshot({
    x: 'nan', y: Infinity, z: -5, yaw: 1,
    health: -50, kills: -3, agentState: 'DROP TABLE', weapon: { evil: true },
    name: 'x'.repeat(500),
  });
  assert.equal(cleaned.x, 0, 'a non-numeric field falls back to 0');
  assert.equal(cleaned.y, 0, 'Infinity is not finite and falls back to 0');
  assert.equal(cleaned.z, -5);
  assert.equal(cleaned.health, 0, 'clamped at the floor');
  assert.equal(cleaned.kills, 0);
  assert.equal(cleaned.agentState, 'idle', 'an unrecognised value falls back rather than propagating');
  assert.equal(cleaned.weapon, 'rifle', 'a non-string weapon falls back');
  assert.equal(cleaned.name.length, 24, 'name is capped in length');
});

test('sanitizeSnapshot caps health and kills at a sane ceiling', () => {
  const cleaned = sanitizeSnapshot({ x: 0, y: 0, z: 0, yaw: 0, health: 1e9, kills: 1e9 });
  assert.ok(cleaned.health <= 999);
  assert.ok(cleaned.kills <= 9999);
});

// ── Colour ───────────────────────────────────────────────────────────────────

test('a player id always maps to the same colour', () => {
  const a = colorForId('player-123');
  const b = colorForId('player-123');
  assert.deepEqual(a, b);
});

test('different ids usually land on different colours', () => {
  const colors = new Set(['a', 'b', 'c', 'd', 'e'].map((id) => JSON.stringify(colorForId(id))));
  assert.ok(colors.size >= 3, 'a 6-colour palette should not collapse 5 distinct ids onto 1-2 colours');
});

// ── Roster ───────────────────────────────────────────────────────────────────

test('the roster excludes the local player and sorts by name', () => {
  const players = {
    me: buildSnapshot({ name: 'Me' }),
    bob: buildSnapshot({ name: 'Bob', health: 40, agentState: 'busy', kills: 3 }),
    alice: buildSnapshot({ name: 'Alice' }),
  };
  const roster = summarizeRoster(players, 'me');
  assert.equal(roster.length, 2, 'local player is excluded');
  assert.deepEqual(roster.map((p) => p.name), ['Alice', 'Bob']);
  const bob = roster.find((p) => p.name === 'Bob');
  assert.equal(bob.health, 40);
  assert.equal(bob.agentState, 'busy');
  assert.equal(bob.kills, 3);
});

test('a roster entry with no name falls back to a short id', () => {
  const roster = summarizeRoster({ xyz789: buildSnapshot({}) }, 'me');
  assert.ok(roster[0].name.includes('xyz78'));
});

test('malformed entries in the roster do not crash summarizeRoster', () => {
  const roster = summarizeRoster({ ghost: null, empty: {}, weird: 'nope', me: buildSnapshot({}) }, 'me');
  assert.equal(roster.length, 1, 'null, non-object entries and the local id are all skipped');
  assert.equal(roster[0].health, 100, '"empty" survives by falling back to defaults');
});

test('an empty or missing roster returns an empty list', () => {
  assert.deepEqual(summarizeRoster({}, 'me'), []);
  assert.deepEqual(summarizeRoster(undefined, 'me'), []);
});

// ── Invite links ───────────────────────────────────────────────────────────

test('a room code is read out of a query string and normalized', () => {
  assert.equal(roomCodeFromUrl('?room=acme2026'), 'ACME2026');
  assert.equal(roomCodeFromUrl('?embed=1&room=acme-2026&agent=busy'), 'ACME2026');
  assert.equal(roomCodeFromUrl('room=ACME2026'), 'ACME2026');
});

test('a missing, empty or malformed room param yields no code', () => {
  assert.equal(roomCodeFromUrl(''), '');
  assert.equal(roomCodeFromUrl('?debug=1'), '');
  assert.equal(roomCodeFromUrl('?room='), '');
  assert.equal(roomCodeFromUrl('?room=ab'), '', 'too short to be a valid code');
  assert.equal(roomCodeFromUrl('?room=' + 'A'.repeat(13)), '', 'too long');
  assert.equal(roomCodeFromUrl(undefined), '');
});

test('an invite link carries the room code on the current page URL', () => {
  const url = buildInviteUrl('https://example.com/thinkingbreak/fps/', 'ACME2026');
  assert.equal(url, 'https://example.com/thinkingbreak/fps/?room=ACME2026');
});

test('an invite link strips params that describe this session, not the room', () => {
  // Copied from inside an editor panel: teammates must not inherit `embed=1`
  // (chromeless, waiting on a host webview they do not have) or a stale agent
  // state, or the link lands them in a game that never starts.
  const url = buildInviteUrl(
    'https://example.com/fps/?embed=1&agent=busy&host=editor&debug=1&keep=yes#hud',
    'squad9',
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('room'), 'SQUAD9');
  assert.equal(parsed.searchParams.get('keep'), 'yes', 'unrelated params survive');
  for (const dropped of ['embed', 'agent', 'host', 'debug']) {
    assert.equal(parsed.searchParams.get(dropped), null, `${dropped} must be stripped`);
  }
  assert.equal(parsed.hash, '', 'the fragment is not part of an invite');
});

test('an invite link replaces an existing room param rather than duplicating it', () => {
  const url = buildInviteUrl('https://example.com/fps/?room=OLDROOM', 'NEWROOM');
  assert.equal(new URL(url).searchParams.getAll('room').length, 1);
  assert.equal(new URL(url).searchParams.get('room'), 'NEWROOM');
});

test('no invite link is offered without a valid room code or URL', () => {
  assert.equal(buildInviteUrl('https://example.com/fps/', ''), '');
  assert.equal(buildInviteUrl('https://example.com/fps/', 'ab'), '');
  assert.equal(buildInviteUrl('', 'ACME2026'), '', 'a relative/empty href has no origin to share');
  assert.equal(buildInviteUrl('not a url', 'ACME2026'), '');
});

// ── Generated room codes ────────────────────────────────────────────────────

test('a generated room code is valid and free of look-alike characters', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.equal(code.length, 6);
    assert.ok(isValidRoomCode(code), `${code} should pass validation`);
    assert.equal(normalizeRoomCode(code), code, 'already normalized');
    // 0/O and 1/I/L are what turn a code read over a call into a failed join.
    assert.ok(!/[01OIL]/.test(code), `${code} contains an ambiguous character`);
  }
});

test('generated room codes do not collide in practice', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(generateRoomCode());
  // ~887M possible codes: 2000 draws colliding would mean the generator is
  // broken, not unlucky.
  assert.equal(seen.size, 2000, 'every generated code should be distinct');
});

test('a generated code round-trips through an invite link', () => {
  const code = generateRoomCode();
  const url = buildInviteUrl('https://example.com/fps/', code);
  assert.equal(roomCodeFromUrl(new URL(url).search), code);
});
