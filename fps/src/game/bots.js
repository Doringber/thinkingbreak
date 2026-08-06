// Thinking Break — bot AI.
//
// Deliberately navmesh-free. The arena is 48 x 48 with generous open lanes, so
// bots steer directly toward a target and rely on three cheap behaviours to
// stay unstuck: wall-slide from the shared collision sweep, a hop when pinned,
// and a lateral sidestep when the hop was not enough.
//
// Bots always close on the player. Without that, a player who stands still
// behind cover sees nothing happen at all — and for a game meant to fill a
// 20-second agent turn, "nothing happens" is the worst possible failure.

import { hasLineOfSight, rayBox, sweepAxis } from './collision.js';
import { pickSpawn } from './arena.js';
import { DIFFICULTY } from './modes.js';

export const BOT = {
  halfWidth: 0.4,
  halfHeight: 0.9,
  headFraction: 0.42,   // top 42% of the body counts as a head
  gravity: 26,
  jumpVelocity: 7.4,
  eyeOffset: 0.62,
  fireRange: 70,
  strafeSwitchMs: 900,
  repathMs: 2200,
  stuckMs: 700,
  stuckEpsilon: 0.55,
  corpseMs: 900,
};

export const BOT_COLORS = [
  [0.95, 0.36, 0.48],
  [0.98, 0.62, 0.24],
  [0.55, 0.85, 0.98],
  [0.78, 0.45, 0.98],
  [0.42, 0.92, 0.62],
];

let nextId = 1;

export function createBot(spawn, difficulty = 'normal', rng = Math.random) {
  const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  return {
    id: nextId++,
    x: spawn.x, y: spawn.y + BOT.halfHeight, z: spawn.z,
    vx: 0, vy: 0, vz: 0,
    yaw: rng() * Math.PI * 2,
    health: diff.botHealth,
    maxHealth: diff.botHealth,
    alive: true,
    diedAt: 0,
    onGround: false,
    state: 'seek',
    target: null,
    strafeDir: rng() < 0.5 ? -1 : 1,
    nextStrafeAt: 0,
    nextRepathAt: 0,
    nextShotAt: 0,
    sawPlayerAt: -Infinity,
    lastPos: { x: spawn.x, z: spawn.z },
    lastProgressAt: 0,
    color: BOT_COLORS[nextId % BOT_COLORS.length],
    flash: 0,
  };
}

/** Collision/hit box for a bot. */
export function botBox(bot) {
  return { x: bot.x, y: bot.y, z: bot.z, hx: BOT.halfWidth, hy: BOT.halfHeight, hz: BOT.halfWidth };
}

/** Head sub-box, used for the headshot check. */
export function botHeadBox(bot) {
  const hy = BOT.halfHeight * BOT.headFraction * 0.5;
  return {
    x: bot.x,
    y: bot.y + BOT.halfHeight - hy,
    z: bot.z,
    hx: BOT.halfWidth * 0.72,
    hy,
    hz: BOT.halfWidth * 0.72,
  };
}

/**
 * Nearest bot along a ray.
 * @returns {{ bot, dist, headshot }|null}
 */
export function raycastBots(ox, oy, oz, dx, dy, dz, bots, maxDist) {
  let best = null;
  for (const bot of bots) {
    if (!bot.alive) continue;
    const t = rayBox(ox, oy, oz, dx, dy, dz, botBox(bot), maxDist);
    if (t === null) continue;
    if (best && t >= best.dist) continue;
    const head = rayBox(ox, oy, oz, dx, dy, dz, botHeadBox(bot), maxDist);
    best = { bot, dist: t, headshot: head !== null };
  }
  return best;
}

/**
 * Where a bot heads when it cannot see the player.
 *
 * It closes in. This used to hand `pickSpawn` the bot's own position, which
 * returns the spawn point *farthest away* — so losing sight made a bot sprint
 * to the other side of the map. Two bots and a player who stood still behind
 * cover produced a stalemate where nothing found anything.
 *
 * The jitter matters: without it every hunter converges on the identical point
 * and they arrive as one clump from one angle.
 */
function huntTarget(bot, player, rng) {
  const spread = 5;
  return {
    x: player.x + (rng() - 0.5) * 2 * spread,
    y: 0,
    z: player.z + (rng() - 0.5) * 2 * spread,
  };
}

/**
 * Where a snagged bot goes to free itself: a sidestep, perpendicular to the
 * direction it was trying to travel.
 *
 * Sending it to a far spawn point instead would unstick it, but it also
 * abandons the hunt for several seconds and reads as the bot losing interest
 * mid-fight. Stepping around the obstacle keeps it in the encounter.
 */
function pickEscapePoint(bot, player, rng) {
  const toPlayer = Math.atan2(player.x - bot.x, player.z - bot.z);
  const side = rng() < 0.5 ? 1 : -1;
  const angle = toPlayer + side * (Math.PI / 2);
  const step = 6 + rng() * 4;
  return {
    x: bot.x + Math.sin(angle) * step,
    y: 0,
    z: bot.z + Math.cos(angle) * step,
  };
}

/**
 * Advance one bot.
 * @returns {{ shoot: null | { damage: number, hitPlayer: boolean } }}
 */
export function stepBot(bot, ctx, dt) {
  const { arena, player, now, difficulty = 'normal', rng = Math.random } = ctx;
  const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  const solids = arena.solids;
  let shoot = null;

  bot.flash = Math.max(0, bot.flash - dt * 6);

  const eyeY = bot.y + BOT.eyeOffset;
  const px = player.x, py = player.y - 0.5, pz = player.z;
  const toPlayerX = px - bot.x, toPlayerZ = pz - bot.z;
  const distToPlayer = Math.hypot(toPlayerX, toPlayerZ);
  const canSee = player.alive && distToPlayer < BOT.fireRange &&
    hasLineOfSight(bot.x, eyeY, bot.z, px, py, pz, solids);

  if (canSee) {
    bot.sawPlayerAt = now;
    bot.state = distToPlayer < 6 ? 'reposition' : 'engage';
  } else if (now - bot.sawPlayerAt > 2500) {
    bot.state = 'seek';
  }

  // ── Choose a steering target ──────────────────────────────────────────────
  if (bot.state === 'seek') {
    if (!bot.target || now >= bot.nextRepathAt ||
        Math.hypot(bot.target.x - bot.x, bot.target.z - bot.z) < 2) {
      bot.target = huntTarget(bot, player, rng);
      bot.nextRepathAt = now + BOT.repathMs;
    }
  } else {
    bot.target = { x: px, y: py, z: pz };
  }

  let dirX = bot.target.x - bot.x;
  let dirZ = bot.target.z - bot.z;
  const dirLen = Math.hypot(dirX, dirZ) || 1;
  dirX /= dirLen; dirZ /= dirLen;

  // Face the player while engaging, otherwise face travel direction.
  const desiredYaw = canSee
    ? Math.atan2(-toPlayerX, -toPlayerZ)
    : Math.atan2(-dirX, -dirZ);
  let yawDelta = desiredYaw - bot.yaw;
  while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
  while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
  bot.yaw += yawDelta * Math.min(1, dt * 9);

  // Strafe while engaging so bots are not stationary targets.
  let moveX = dirX, moveZ = dirZ;
  if (bot.state === 'engage' || bot.state === 'reposition') {
    if (now >= bot.nextStrafeAt) {
      bot.strafeDir = rng() < 0.5 ? -1 : 1;
      bot.nextStrafeAt = now + BOT.strafeSwitchMs * (0.6 + rng() * 0.8);
    }
    const strafeX = -dirZ * bot.strafeDir;
    const strafeZ = dirX * bot.strafeDir;
    // Back off when too close, so bots orbit instead of face-hugging.
    const approach = bot.state === 'reposition' ? -0.6 : distToPlayer > 18 ? 1 : 0.25;
    moveX = dirX * approach + strafeX * 0.9;
    moveZ = dirZ * approach + strafeZ * 0.9;
    const len = Math.hypot(moveX, moveZ) || 1;
    moveX /= len; moveZ /= len;
  }

  // ── Integrate ─────────────────────────────────────────────────────────────
  const speed = diff.botSpeed;
  bot.vx = moveX * speed;
  bot.vz = moveZ * speed;
  bot.vy = Math.max(-55, bot.vy - BOT.gravity * dt);

  const box = botBox(bot);
  const sx = sweepAxis(box, 'x', bot.vx * dt, solids);
  box.x = sx.value;
  const sz = sweepAxis(box, 'z', bot.vz * dt, solids);
  box.z = sz.value;
  const sy = sweepAxis(box, 'y', bot.vy * dt, solids);
  const landed = sy.hit && bot.vy <= 0;
  box.y = sy.value;
  if (sy.hit) bot.vy = 0;

  bot.x = box.x; bot.y = box.y; bot.z = box.z;
  bot.onGround = landed;

  // Jump pads work for bots too — that is how they reach the upper decks.
  for (const pad of arena.jumpPads) {
    if (Math.abs(bot.x - pad.x) < pad.hx && Math.abs(bot.z - pad.z) < pad.hz &&
        bot.y - BOT.halfHeight <= 0.9) {
      bot.vy = pad.power;
      bot.onGround = false;
    }
  }

  // ── Stuck recovery ────────────────────────────────────────────────────────
  const travelled = Math.hypot(bot.x - bot.lastPos.x, bot.z - bot.lastPos.z);
  if (travelled > BOT.stuckEpsilon) {
    bot.lastPos = { x: bot.x, z: bot.z };
    bot.lastProgressAt = now;
  } else if (now - bot.lastProgressAt > BOT.stuckMs) {
    // Hop first — most snags are a step edge. If that did not help, aim
    // somewhere else entirely so the bot stops grinding against the same face.
    if (bot.onGround) bot.vy = BOT.jumpVelocity;
    bot.target = pickEscapePoint(bot, player, rng);
    bot.nextRepathAt = now + BOT.repathMs;
    bot.strafeDir *= -1;
    bot.lastProgressAt = now;
    bot.lastPos = { x: bot.x, z: bot.z };
  }

  // Fell out of the world: teleport back rather than despawn.
  if (bot.y < arena.killFloor) {
    const sp = pickSpawn(arena, player, rng);
    bot.x = sp.x; bot.y = sp.y + BOT.halfHeight; bot.z = sp.z;
    bot.vx = bot.vy = bot.vz = 0;
  }

  // ── Shooting ──────────────────────────────────────────────────────────────
  if (canSee && now >= bot.nextShotAt) {
    if (bot.nextShotAt === 0) {
      bot.nextShotAt = now + diff.botReaction;
    } else {
      const hit = rng() < diff.botAccuracy * (distToPlayer < 25 ? 1 : 0.6);
      shoot = { damage: diff.botDamage, hitPlayer: hit, from: { x: bot.x, y: eyeY, z: bot.z } };
      bot.nextShotAt = now + diff.botReaction + rng() * 260;
      bot.flash = 1;
    }
  } else if (!canSee) {
    bot.nextShotAt = 0; // re-arm the reaction delay for the next sighting
  }

  return { shoot };
}

export function damageBot(bot, amount) {
  if (!bot.alive) return { killed: false, applied: 0 };
  const applied = Math.min(bot.health, amount);
  bot.health -= applied;
  if (bot.health <= 0) {
    bot.health = 0;
    bot.alive = false;
  }
  return { killed: !bot.alive, applied };
}

export function respawnBot(bot, arena, player, difficulty, rng = Math.random, occupied = []) {
  const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  const sp = pickSpawn(arena, player, rng, occupied);
  bot.x = sp.x; bot.y = sp.y + BOT.halfHeight; bot.z = sp.z;
  bot.vx = bot.vy = bot.vz = 0;
  bot.health = diff.botHealth;
  bot.maxHealth = diff.botHealth;
  bot.alive = true;
  bot.state = 'seek';
  bot.target = null;
  bot.nextShotAt = 0;
  bot.sawPlayerAt = -Infinity;
  bot.flash = 0;
  bot.lastPos = { x: sp.x, z: sp.z };
}

/** Reset the shared id counter — tests rely on stable ids. */
export function _resetBotIds() {
  nextId = 1;
}
