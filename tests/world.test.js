// Collision, raycasting, movement and bot behaviour — everything about the
// world that does not need a GPU.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boxFromBounds, boxNormalAt, hasLineOfSight, makeBox, overlaps, rayBox,
  raycastSolids, sweepAxis,
} from '../fps/src/game/collision.js';
import { ARENA_HALF, buildArena, pickSpawn } from '../fps/src/game/arena.js';
import {
  PLAYER, applyLook, createPlayer, damagePlayer, eyePosition, healPlayer,
  playerBox, respawnPlayer, stepPlayer,
} from '../fps/src/game/player.js';
import {
  BOT, _resetBotIds, botBox, botHeadBox, createBot, damageBot, raycastBots,
  respawnBot, stepBot,
} from '../fps/src/game/bots.js';
import { makeRng } from '../fps/src/core/math.js';

const rng = makeRng(1234);

// ── Collision ───────────────────────────────────────────────────────────────

test('overlap detection is exclusive at exact contact', () => {
  const a = makeBox(0, 0, 0, 1, 1, 1);
  assert.equal(overlaps(a, makeBox(1.5, 0, 0, 1, 1, 1)), true);
  assert.equal(overlaps(a, makeBox(2, 0, 0, 1, 1, 1)), false, 'touching faces do not count as overlapping');
  assert.equal(overlaps(a, makeBox(0, 5, 0, 1, 1, 1)), false);
});

test('boxFromBounds round-trips to the right centre and half-extents', () => {
  const b = boxFromBounds(-4, 0, 2, 6, 3, 10);
  assert.deepEqual([b.x, b.y, b.z], [1, 1.5, 6]);
  assert.deepEqual([b.hx, b.hy, b.hz], [5, 1.5, 4]);
});

test('a swept axis stops against a solid instead of passing through', () => {
  const solids = [makeBox(5, 0, 0, 1, 1, 1)];
  const body = makeBox(0, 0, 0, 0.5, 0.5, 0.5);
  const result = sweepAxis(body, 'x', 10, solids);
  assert.equal(result.hit, true);
  assert.ok(result.value < 4.01 && result.value > 3.4, `stopped at ${result.value}, expected just short of 3.5`);
});

test('a swept axis with a clear path moves the full distance', () => {
  const body = makeBox(0, 0, 0, 0.5, 0.5, 0.5);
  const result = sweepAxis(body, 'z', 3, []);
  assert.equal(result.hit, false);
  assert.equal(result.value, 3);
});

test('sweeping backwards resolves against the far face', () => {
  const solids = [makeBox(-5, 0, 0, 1, 1, 1)];
  const body = makeBox(0, 0, 0, 0.5, 0.5, 0.5);
  const result = sweepAxis(body, 'x', -10, solids);
  assert.equal(result.hit, true);
  assert.ok(result.value > -4.01 && result.value < -3.4);
});

test('rayBox reports the near-face distance, and misses return null', () => {
  const box = makeBox(0, 0, -10, 1, 1, 1);
  assert.ok(Math.abs(rayBox(0, 0, 0, 0, 0, -1, box) - 9) < 1e-6);
  assert.equal(rayBox(0, 0, 0, 0, 0, 1, box), null, 'a ray pointing away misses');
  assert.equal(rayBox(0, 5, 0, 0, 0, -1, box), null, 'a ray above the box misses');
  assert.equal(rayBox(0, 0, 0, 0, 0, -1, box, 5), null, 'maxDist is respected');
});

test('raycastSolids returns the nearest hit', () => {
  const near = makeBox(0, 0, -5, 1, 1, 1);
  const far = makeBox(0, 0, -20, 1, 1, 1);
  const hit = raycastSolids(0, 0, 0, 0, 0, -1, [far, near]);
  assert.equal(hit.box, near);
  assert.ok(Math.abs(hit.dist - 4) < 1e-6);
});

test('boxNormalAt names the face that was hit', () => {
  const box = makeBox(0, 0, 0, 1, 1, 1);
  assert.deepEqual(boxNormalAt(box, 1, 0, 0), [1, 0, 0]);
  assert.deepEqual(boxNormalAt(box, -1, 0, 0), [-1, 0, 0]);
  assert.deepEqual(boxNormalAt(box, 0, 1, 0), [0, 1, 0]);
  assert.deepEqual(boxNormalAt(box, 0, 0, -1), [0, 0, -1]);
});

test('line of sight is blocked by geometry in between', () => {
  const wall = [makeBox(0, 0, 0, 5, 5, 0.5)];
  assert.equal(hasLineOfSight(0, 0, -10, 0, 0, 10, wall), false);
  assert.equal(hasLineOfSight(0, 0, -10, 0, 0, -1, wall), true, 'stopping short of the wall is clear');
  assert.equal(hasLineOfSight(20, 0, -10, 20, 0, 10, wall), true, 'a path around the wall is clear');
});

// ── Arena ───────────────────────────────────────────────────────────────────

test('the arena has the features the design calls for', () => {
  const arena = buildArena();
  assert.ok(arena.solids.length > 25, 'a reasonable amount of geometry');
  assert.equal(arena.half, ARENA_HALF);
  assert.equal(arena.jumpPads.length, 3);
  assert.ok(arena.pickupSpots.some((p) => p.type === 'health'), 'health pickups');
  assert.ok(arena.pickupSpots.some((p) => p.type === 'ammo'), 'ammo pickups');
  assert.ok(arena.spawnPoints.length >= 6, 'enough spawn points to spread a wave out');

  const kinds = new Set(arena.solids.map((b) => b.kind));
  for (const kind of ['floor', 'deck', 'ramp', 'cover']) {
    assert.ok(kinds.has(kind), `the arena includes ${kind} geometry`);
  }

  const elevations = new Set(arena.solids.filter((b) => b.kind === 'deck').map((b) => Math.round(b.y + b.hy)));
  assert.ok(elevations.size >= 2, 'more than one raised elevation');
});

test('no jump pad sits on top of the player spawn', () => {
  const arena = buildArena();
  for (const pad of arena.jumpPads) {
    const dx = Math.abs(pad.x - arena.playerSpawn.x);
    const dz = Math.abs(pad.z - arena.playerSpawn.z);
    assert.ok(
      dx > pad.hx + PLAYER.radius || dz > pad.hz + PLAYER.radius,
      `jump pad at (${pad.x}, ${pad.z}) overlaps the player spawn`
    );
  }
});

test('no spawn point is buried inside solid geometry', () => {
  const arena = buildArena();
  const spawns = [arena.playerSpawn, ...arena.spawnPoints];
  for (const spawn of spawns) {
    const body = makeBox(spawn.x, spawn.y + 0.95, spawn.z, 0.42, 0.9, 0.42);
    const stuck = arena.solids.find((s) => overlaps(body, s));
    assert.equal(stuck, undefined, `spawn (${spawn.x}, ${spawn.y}, ${spawn.z}) is inside solid geometry`);
  }
});

test('pickSpawn prefers points far from the player', () => {
  const arena = buildArena();
  const near = { x: -18, z: 0 };
  const chosen = pickSpawn(arena, near, () => 0);
  assert.ok(
    Math.hypot(chosen.x - near.x, chosen.z - near.z) > 20,
    'the chosen spawn is not next to the player'
  );
});

test('pickSpawn avoids stacking on occupied points', () => {
  const arena = buildArena();
  const first = pickSpawn(arena, { x: 0, z: 0 }, () => 0);
  const second = pickSpawn(arena, { x: 0, z: 0 }, () => 0, [first]);
  assert.notDeepEqual([second.x, second.z], [first.x, first.z]);
});

// ── Player movement ─────────────────────────────────────────────────────────

const idleIntent = (over = {}) => ({ forward: 0, strafe: 0, jump: false, sprint: false, crouch: false, now: 0, ...over });

/** Featureless ground, for measuring movement rather than level layout. */
const OPEN_WORLD = {
  solids: [boxFromBounds(-200, -2, -200, 200, 0, 200)],
  jumpPads: [],
  killFloor: -50,
};

function spawnedPlayer(arena) {
  return createPlayer({ ...arena.playerSpawn, y: arena.playerSpawn.y + PLAYER.standHeight });
}

/** Run the player simulation for `seconds` at a fixed 60 Hz. */
function simulate(player, arena, intentFor, seconds) {
  const dt = 1 / 60;
  let now = 0;
  let last = null;
  for (let t = 0; t < seconds; t += dt) {
    now += dt * 1000;
    last = stepPlayer(player, { ...intentFor(now), now }, arena, dt);
  }
  return last;
}

test('a player dropped onto the floor lands and stops', () => {
  const arena = buildArena();
  const player = spawnedPlayer(arena);
  player.y += 5;
  simulate(player, arena, () => idleIntent(), 2);
  assert.equal(player.onGround, true);
  assert.ok(Math.abs(player.vy) < 0.01, 'vertical velocity settles');
  assert.ok(Math.abs(player.y - PLAYER.standHeight) < 0.05, `feet rest on the floor (y=${player.y})`);
});

test('holding forward moves the player in the direction they face', () => {
  const arena = buildArena();
  const player = spawnedPlayer(arena);
  player.yaw = 0; // looking down -Z
  const startZ = player.z;
  simulate(player, arena, () => idleIntent({ forward: 1 }), 1);
  assert.ok(player.z < startZ - 3, `moved forward (${startZ} -> ${player.z})`);
  assert.ok(Math.abs(player.x) < 0.5, 'and did not drift sideways');
});

test('strafing right moves along +X when facing -Z', () => {
  const arena = buildArena();
  const player = spawnedPlayer(arena);
  player.yaw = 0;
  simulate(player, arena, () => idleIntent({ strafe: 1 }), 1);
  assert.ok(player.x > 3, `strafed right (x=${player.x})`);
});

test('sprinting is faster than walking', () => {
  // Measured on open ground: the real arena has cover a few metres ahead of
  // the spawn, which would cap both runs at the same wall.
  const distance = (sprint) => {
    const player = createPlayer({ x: 0, y: PLAYER.standHeight, z: 0, yaw: 0 });
    const start = player.z;
    simulate(player, OPEN_WORLD, () => idleIntent({ forward: 1, sprint }), 1.5);
    return start - player.z;
  };
  const walked = distance(false);
  const sprinted = distance(true);
  assert.ok(sprinted > walked * 1.15, `sprint ${sprinted.toFixed(2)} vs walk ${walked.toFixed(2)}`);
});

test('jumping leaves the ground and gravity brings the player back', () => {
  const arena = buildArena();
  const player = spawnedPlayer(arena);
  simulate(player, arena, () => idleIntent(), 0.4); // settle
  const groundY = player.y;

  stepPlayer(player, idleIntent({ jump: true, now: 500 }), arena, 1 / 60);
  assert.equal(player.onGround, false);
  assert.ok(player.vy > 0);

  let now = 500;
  for (let i = 0; i < 200; i++) {
    now += 1000 / 60;
    stepPlayer(player, idleIntent({ now }), arena, 1 / 60);
  }
  assert.equal(player.onGround, true, 'came back down');
  assert.ok(Math.abs(player.y - groundY) < 0.05);
});

test('crouching lowers the player and slows them down', () => {
  const arena = buildArena();
  const player = spawnedPlayer(arena);
  player.yaw = 0;
  simulate(player, arena, () => idleIntent({ crouch: true }), 0.6);
  assert.ok(player.height < PLAYER.standHeight, 'the body box shrank');
  assert.ok(Math.abs(player.height - PLAYER.crouchHeight) < 0.05);

  const start = player.z;
  simulate(player, arena, () => idleIntent({ forward: 1, crouch: true }), 1);
  const crouchDistance = start - player.z;

  const runner = spawnedPlayer(arena);
  runner.yaw = 0;
  const runStart = runner.z;
  simulate(runner, arena, () => idleIntent({ forward: 1 }), 1);
  assert.ok(crouchDistance < (runStart - runner.z) * 0.7, 'crouch-walking is much slower');
});

test('crouching at speed triggers a slide', () => {
  const player = createPlayer({ x: 0, y: PLAYER.standHeight, z: 0, yaw: 0 });
  // Build up speed on open ground first, then crouch.
  simulate(player, OPEN_WORLD, () => idleIntent({ forward: 1, sprint: true }), 1.2);
  assert.ok(Math.hypot(player.vx, player.vz) > PLAYER.walkSpeed * 0.85, 'reached slide speed');

  stepPlayer(player, idleIntent({ forward: 1, sprint: true, crouch: true, now: 5000 }), OPEN_WORLD, 1 / 60);
  assert.equal(player.sliding, true);
});

test('crouching while stationary does not trigger a slide', () => {
  const player = createPlayer({ x: 0, y: PLAYER.standHeight, z: 0, yaw: 0 });
  simulate(player, OPEN_WORLD, () => idleIntent({ crouch: true }), 0.5);
  assert.equal(player.sliding, false);
  assert.equal(player.crouching, true);
});

test('a fast fall does not tunnel through a thin platform', () => {
  // A 0.3-deep step and a fall fast enough to clear it in a single frame:
  // this is exactly the case a destination-only collision test would miss.
  const platform = boxFromBounds(-5, 0, -5, 5, 0.3, 5);
  const world = { solids: [platform], jumpPads: [], killFloor: -100 };
  const player = createPlayer({ x: 0, y: 40, z: 0, yaw: 0 });
  player.vy = -80;

  let now = 0;
  for (let i = 0; i < 300; i++) {
    now += 1000 / 60;
    stepPlayer(player, idleIntent({ now }), world, 1 / 60);
  }
  assert.ok(player.y > 0.3, `landed on the platform instead of passing through (y=${player.y})`);
  assert.equal(player.onGround, true);
});

test('walls stop the player instead of letting them through', () => {
  const arena = buildArena();
  const player = spawnedPlayer(arena);
  player.yaw = Math.PI; // face +Z, toward the south wall
  simulate(player, arena, () => idleIntent({ forward: 1, sprint: true }), 4);
  assert.ok(player.z < ARENA_HALF, `stopped inside the arena (z=${player.z})`);
});

test('a jump pad launches the player', () => {
  const arena = buildArena();
  const pad = arena.jumpPads[0];
  const player = createPlayer({ x: pad.x, y: PLAYER.standHeight, z: pad.z, yaw: 0 });
  const result = stepPlayer(player, idleIntent({ now: 1000 }), arena, 1 / 60);
  assert.ok(result.padHit, 'the pad reported a hit');
  assert.ok(player.vy > 10, `launched upward (vy=${player.vy})`);
});

test('applyLook clamps pitch and wraps yaw', () => {
  const player = createPlayer({ x: 0, y: 2, z: 0, yaw: 0 });
  applyLook(player, 0, -100_000, 0.002);
  assert.ok(player.pitch < Math.PI / 2 && player.pitch > Math.PI / 2 - 0.05, 'cannot look past straight up');
  applyLook(player, 0, 200_000, 0.002);
  assert.ok(player.pitch > -Math.PI / 2, 'cannot look past straight down');

  applyLook(player, -100_000, 0, 0.002);
  assert.ok(player.yaw >= -Math.PI && player.yaw <= Math.PI, 'yaw stays bounded');
});

test('invertY flips vertical aim', () => {
  const a = createPlayer({ x: 0, y: 2, z: 0, yaw: 0 });
  const b = createPlayer({ x: 0, y: 2, z: 0, yaw: 0 });
  applyLook(a, 0, 100, 0.002, false);
  applyLook(b, 0, 100, 0.002, true);
  assert.equal(a.pitch, -b.pitch);
});

test('the eye sits inside the body box, below its top', () => {
  const player = createPlayer({ x: 0, y: PLAYER.standHeight, z: 0, yaw: 0 });
  const eye = eyePosition(player);
  const box = playerBox(player);
  assert.ok(eye[1] < box.y + box.hy, 'below the crown');
  assert.ok(eye[1] > box.y - box.hy, 'above the feet');
});

test('damage, healing and respawn behave', () => {
  const player = createPlayer({ x: 0, y: 2, z: 0, yaw: 0 });
  assert.equal(damagePlayer(player, 30), 30);
  assert.equal(player.health, 70);
  assert.equal(healPlayer(player, 100), 30, 'healing is capped at max health');
  assert.equal(player.health, PLAYER.maxHealth);

  assert.equal(damagePlayer(player, 500), PLAYER.maxHealth, 'overkill only applies what was left');
  assert.equal(player.alive, false);
  assert.equal(damagePlayer(player, 10), 0, 'a dead player takes no more damage');

  respawnPlayer(player, { x: 5, y: 2, z: 5, yaw: 1 });
  assert.equal(player.alive, true);
  assert.equal(player.health, PLAYER.maxHealth);
  assert.deepEqual([player.x, player.z], [5, 5]);
});

test('the player falls out of the world only below the kill floor', () => {
  const arena = buildArena();
  const player = createPlayer({ x: 0, y: arena.killFloor - 1, z: 0, yaw: 0 });
  const result = stepPlayer(player, idleIntent({ now: 0 }), arena, 1 / 60);
  assert.equal(result.fellOut, true);
});

// ── Bots ────────────────────────────────────────────────────────────────────

test('the head box sits at the top of the body box and is narrower', () => {
  _resetBotIds();
  const bot = createBot({ x: 0, y: 0, z: 0 }, 'normal', rng);
  const body = botBox(bot);
  const head = botHeadBox(bot);
  assert.ok(head.y > body.y, 'the head is in the upper half');
  assert.ok(head.y + head.hy <= body.y + body.hy + 1e-6, 'and inside the body box');
  assert.ok(head.hx < body.hx, 'the head is a smaller target');
});

test('raycastBots distinguishes a body hit from a headshot', () => {
  _resetBotIds();
  const bot = createBot({ x: 0, y: 0, z: -10 }, 'normal', rng);
  const body = botBox(bot);

  const chest = raycastBots(0, body.y, 0, 0, 0, -1, [bot], 100);
  assert.ok(chest, 'the chest shot connects');
  assert.equal(chest.headshot, false);

  const head = botHeadBox(bot);
  const skull = raycastBots(0, head.y, 0, 0, 0, -1, [bot], 100);
  assert.ok(skull, 'the head shot connects');
  assert.equal(skull.headshot, true);
});

test('raycastBots skips dead bots and returns the nearest of several', () => {
  _resetBotIds();
  const near = createBot({ x: 0, y: 0, z: -5 }, 'normal', rng);
  const far = createBot({ x: 0, y: 0, z: -20 }, 'normal', rng);
  const dead = createBot({ x: 0, y: 0, z: -2 }, 'normal', rng);
  dead.alive = false;

  const hit = raycastBots(0, near.y, 0, 0, 0, -1, [dead, far, near], 100);
  assert.equal(hit.bot, near, 'the living near bot is hit, not the dead closer one');
});

test('damaging a bot kills it exactly once', () => {
  _resetBotIds();
  const bot = createBot({ x: 0, y: 0, z: 0 }, 'normal', rng);
  assert.equal(damageBot(bot, 40).killed, false);
  assert.equal(bot.health, 60);
  const killing = damageBot(bot, 999);
  assert.equal(killing.killed, true);
  assert.equal(killing.applied, 60, 'only the remaining health is applied');
  assert.equal(damageBot(bot, 10).killed, false, 'a dead bot cannot be killed again');
});

test('bot health scales with difficulty', () => {
  _resetBotIds();
  const easy = createBot({ x: 0, y: 0, z: 0 }, 'easy', rng);
  const hard = createBot({ x: 0, y: 0, z: 0 }, 'hard', rng);
  assert.ok(hard.maxHealth > easy.maxHealth);
});

test('respawning resets a bot fully and moves it away from the player', () => {
  const arena = buildArena();
  _resetBotIds();
  const bot = createBot(arena.spawnPoints[0], 'normal', rng);
  bot.alive = false;
  bot.health = 0;
  const player = { x: arena.spawnPoints[0].x, y: 2, z: arena.spawnPoints[0].z };

  respawnBot(bot, arena, player, 'normal', rng);
  assert.equal(bot.alive, true);
  assert.equal(bot.health, bot.maxHealth);
  assert.ok(Math.hypot(bot.x - player.x, bot.z - player.z) > 10, 'not on top of the player');
});

test('bots move toward the player and stay inside the arena', () => {
  const arena = buildArena();
  _resetBotIds();
  const bot = createBot({ x: -18, y: 0, z: 0 }, 'normal', rng);
  const player = { x: 18, y: 2, z: 0, alive: true };
  const startDistance = Math.hypot(bot.x - player.x, bot.z - player.z);

  let now = 0;
  for (let i = 0; i < 240; i++) {
    now += 1000 / 60;
    stepBot(bot, { arena, player, now, difficulty: 'normal', rng }, 1 / 60);
  }

  assert.ok(
    Math.hypot(bot.x - player.x, bot.z - player.z) < startDistance,
    'the bot closed the gap'
  );
  assert.ok(Math.abs(bot.x) <= ARENA_HALF + 2, `stayed in bounds (x=${bot.x})`);
  assert.ok(Math.abs(bot.z) <= ARENA_HALF + 2, `stayed in bounds (z=${bot.z})`);
  assert.ok(bot.y > arena.killFloor, 'did not fall out of the world');
});

test('a bot that cannot see the player hunts it instead of fleeing', () => {
  // Regression: `seek` used to steer toward the spawn point farthest from the
  // bot, so losing line of sight sent it to the other side of the map. A
  // stationary player behind cover then produced a stalemate where neither
  // side ever found the other.
  const arena = buildArena();
  _resetBotIds();

  // Player tucked behind the big southern crate; bot far north with no sight.
  const player = { x: 0, y: 1.8, z: 18, alive: true };
  const bot = createBot({ x: 0, y: 0, z: -18 }, 'normal', rng);
  assert.equal(
    hasLineOfSight(bot.x, bot.y + BOT.eyeOffset, bot.z, player.x, player.y - 0.5, player.z, arena.solids),
    false,
    'precondition: the bot starts with no line of sight'
  );

  const startDistance = Math.hypot(bot.x - player.x, bot.z - player.z);
  let now = 0;
  let closest = startDistance;
  // 20 s: crossing the arena at 5.4 u/s while wall-sliding around cover takes
  // a while, and the point is that it arrives at all, not how fast.
  for (let i = 0; i < 1200; i++) {
    now += 1000 / 60;
    stepBot(bot, { arena, player, now, difficulty: 'normal', rng }, 1 / 60);
    closest = Math.min(closest, Math.hypot(bot.x - player.x, bot.z - player.z));
  }

  assert.ok(
    closest < 12,
    `the bot reached the player (${startDistance.toFixed(1)} -> ${closest.toFixed(1)})`
  );
});

test('the player spawn has a clear line into the arena', () => {
  // A stationary player must be able to see something to shoot at, and be
  // seeable, or the round never starts.
  const arena = buildArena();
  const spawn = arena.playerSpawn;
  const eyeY = spawn.y + PLAYER.standHeight + PLAYER.eyeOffset;

  // Straight ahead down the spawn's facing direction (yaw 0 => -Z).
  assert.ok(
    hasLineOfSight(spawn.x, eyeY, spawn.z, spawn.x, eyeY, spawn.z - 20, arena.solids),
    'nothing blocks the lane directly ahead of the spawn'
  );

  // And the centre of the arena is visible from the spawn.
  assert.ok(
    hasLineOfSight(spawn.x, eyeY, spawn.z, 0, 1.25, 0, arena.solids),
    'the middle of the arena is visible from the spawn'
  );
});

test('a bot cornered against geometry does not stay stuck', () => {
  const arena = buildArena();
  _resetBotIds();
  // Wedge the bot into the arena's south-west corner with the player far away.
  const bot = createBot({ x: -23, y: 0, z: 23 }, 'normal', rng);
  const player = { x: -23.5, y: 2, z: 23.5, alive: true };

  let now = 0;
  let maxTravel = 0;
  const origin = { x: bot.x, z: bot.z };
  for (let i = 0; i < 600; i++) {
    now += 1000 / 60;
    stepBot(bot, { arena, player, now, difficulty: 'normal', rng }, 1 / 60);
    maxTravel = Math.max(maxTravel, Math.hypot(bot.x - origin.x, bot.z - origin.z));
  }
  assert.ok(maxTravel > 2, `the bot found its way out (travelled ${maxTravel.toFixed(2)})`);
});

test('bots shoot only after a reaction delay and only with line of sight', () => {
  const arena = buildArena();
  _resetBotIds();
  const bot = createBot({ x: 0, y: 0, z: -6 }, 'hard', rng);
  const player = { x: 0, y: 2, z: 0, alive: true };
  const ctx = { arena, player, now: 0, difficulty: 'hard', rng: () => 0.01 };

  // First tick with sight arms the reaction timer rather than firing.
  const first = stepBot(bot, { ...ctx, now: 0 }, 1 / 60);
  assert.equal(first.shoot, null, 'no instant shot on first sighting');

  let fired = false;
  for (let i = 1; i <= 120 && !fired; i++) {
    const r = stepBot(bot, { ...ctx, now: i * (1000 / 60) }, 1 / 60);
    if (r.shoot) fired = true;
  }
  assert.equal(fired, true, 'the bot eventually fires');
});

test('a bot that falls out of the world is put back in play', () => {
  const arena = buildArena();
  _resetBotIds();
  const bot = createBot({ x: 0, y: 0, z: 0 }, 'normal', rng);
  bot.y = arena.killFloor - 5;
  stepBot(bot, { arena, player: { x: 0, y: 2, z: 0, alive: true }, now: 0, difficulty: 'normal', rng }, 1 / 60);
  assert.ok(bot.y > arena.killFloor, 'teleported back above the kill floor');
});

test('the head fraction leaves a real body target below it', () => {
  assert.ok(BOT.headFraction > 0 && BOT.headFraction < 1);
});
