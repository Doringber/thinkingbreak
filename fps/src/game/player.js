// Thinking Break — player movement.
//
// Arcade-shooter feel on purpose: high ground acceleration, near-instant stops,
// real air control, and a slide that trades steering for speed. All physics run
// on delta time so the handling is identical at 60 and 240 Hz.

import { TAU, clamp } from '../core/math.js';
import { sweepAxis } from './collision.js';

export const PLAYER = {
  radius: 0.42,
  standHeight: 1.8,
  crouchHeight: 1.05,
  eyeOffset: -0.22,      // eye sits just below the top of the body box
  walkSpeed: 7.4,
  sprintSpeed: 10.6,
  crouchSpeed: 3.6,
  slideSpeed: 13.5,
  accelGround: 92,
  accelAir: 26,
  frictionGround: 11,
  frictionAir: 0.12,
  jumpVelocity: 8.2,
  gravity: 26,
  maxFallSpeed: 60,
  coyoteMs: 110,
  jumpBufferMs: 140,
  slideDurationMs: 700,
  slideCooldownMs: 400,
  maxHealth: 100,
};

export function createPlayer(spawn) {
  return {
    x: spawn.x, y: spawn.y, z: spawn.z,
    vx: 0, vy: 0, vz: 0,
    yaw: spawn.yaw ?? 0,
    pitch: 0,
    height: PLAYER.standHeight,
    crouching: false,
    sliding: false,
    slideUntil: 0,
    slideReadyAt: 0,
    onGround: false,
    lastGroundedAt: -Infinity,
    jumpQueuedAt: -Infinity,
    health: PLAYER.maxHealth,
    alive: true,
    bob: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    lastPadAt: -Infinity,
  };
}

/** Collision box for the player at its current height. */
export function playerBox(p) {
  return {
    x: p.x,
    y: p.y - p.height / 2,
    z: p.z,
    hx: PLAYER.radius,
    hy: p.height / 2,
    hz: PLAYER.radius,
  };
}

/** Eye position used for the camera and for every shot's ray origin. */
export function eyePosition(p) {
  return [p.x, p.y + PLAYER.eyeOffset + Math.sin(p.bob) * 0.035, p.z];
}

function applyFriction(p, dt, drag) {
  const speed = Math.hypot(p.vx, p.vz);
  if (speed < 1e-3) { p.vx = 0; p.vz = 0; return; }
  const drop = speed * drag * dt;
  const scale = Math.max(0, speed - drop) / speed;
  p.vx *= scale;
  p.vz *= scale;
}

/**
 * Quake-style acceleration: only ever adds velocity along `wish` up to the
 * target speed. Because it caps the *projection* rather than the total speed,
 * strafing while airborne still lets you steer — the thing that makes arena
 * movement feel alive.
 */
function accelerate(p, wishX, wishZ, wishSpeed, accel, dt) {
  const current = p.vx * wishX + p.vz * wishZ;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const gain = Math.min(accel * wishSpeed * dt, add);
  p.vx += wishX * gain;
  p.vz += wishZ * gain;
}

/**
 * Advance the player one step.
 * @param {object} p        player state (mutated)
 * @param {object} intent   { forward, strafe, jump, sprint, crouch, now }
 * @param {object} world    { solids, jumpPads, killFloor }
 * @param {number} dt       seconds
 */
export function stepPlayer(p, intent, world, dt) {
  const { solids, jumpPads = [], killFloor = -50 } = world;
  const now = intent.now ?? 0;

  // ── Stance ────────────────────────────────────────────────────────────────
  if (p.sliding && now >= p.slideUntil) {
    p.sliding = false;
    p.slideReadyAt = now + PLAYER.slideCooldownMs;
  }
  const wantsCrouch = intent.crouch && !p.sliding;
  const horizontalSpeed = Math.hypot(p.vx, p.vz);

  if (intent.crouch && !p.crouching && !p.sliding && p.onGround &&
      horizontalSpeed > PLAYER.walkSpeed * 0.85 && now >= p.slideReadyAt) {
    p.sliding = true;
    p.slideUntil = now + PLAYER.slideDurationMs;
    const boost = PLAYER.slideSpeed / Math.max(horizontalSpeed, 0.001);
    p.vx *= Math.min(boost, 1.45);
    p.vz *= Math.min(boost, 1.45);
  }

  const targetHeight = wantsCrouch || p.sliding ? PLAYER.crouchHeight : PLAYER.standHeight;
  if (targetHeight > p.height) {
    // Only stand back up when there is room, so crouching under a ledge does
    // not eject the player through the ceiling.
    const probe = { ...playerBox(p), y: p.y - targetHeight / 2, hy: targetHeight / 2 };
    const blocked = solids.some((s) =>
      Math.abs(probe.x - s.x) < probe.hx + s.hx &&
      Math.abs(probe.y - s.y) < probe.hy + s.hy &&
      Math.abs(probe.z - s.z) < probe.hz + s.hz);
    if (!blocked) p.height = Math.min(targetHeight, p.height + 7 * dt);
  } else {
    p.height = Math.max(targetHeight, p.height - 9 * dt);
  }
  p.crouching = wantsCrouch;

  // ── Wish direction in world space ─────────────────────────────────────────
  // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  let wishX = -sin * intent.forward + cos * intent.strafe;
  let wishZ = -cos * intent.forward - sin * intent.strafe;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1e-4) { wishX /= wishLen; wishZ /= wishLen; } else { wishX = 0; wishZ = 0; }

  let wishSpeed = PLAYER.walkSpeed;
  if (p.sliding) wishSpeed = PLAYER.slideSpeed;
  else if (p.crouching) wishSpeed = PLAYER.crouchSpeed;
  else if (intent.sprint && intent.forward > 0) wishSpeed = PLAYER.sprintSpeed;
  if (wishLen < 1e-4) wishSpeed = 0;

  if (p.onGround) {
    applyFriction(p, dt, p.sliding ? 1.4 : PLAYER.frictionGround);
    accelerate(p, wishX, wishZ, wishSpeed, p.sliding ? 6 : PLAYER.accelGround, dt);
  } else {
    applyFriction(p, dt, PLAYER.frictionAir);
    accelerate(p, wishX, wishZ, Math.min(wishSpeed, PLAYER.sprintSpeed), PLAYER.accelAir, dt);
  }

  // ── Jump, with coyote time and input buffering ────────────────────────────
  if (intent.jump) p.jumpQueuedAt = now;
  const grounded = p.onGround || now - p.lastGroundedAt < PLAYER.coyoteMs;
  if (grounded && now - p.jumpQueuedAt < PLAYER.jumpBufferMs) {
    p.vy = PLAYER.jumpVelocity;
    p.onGround = false;
    p.sliding = false;
    p.jumpQueuedAt = -Infinity;
    p.lastGroundedAt = -Infinity;
  }

  p.vy = Math.max(-PLAYER.maxFallSpeed, p.vy - PLAYER.gravity * dt);

  // ── Integrate, one axis at a time ─────────────────────────────────────────
  const box = playerBox(p);

  const sx = sweepAxis(box, 'x', p.vx * dt, solids);
  box.x = sx.value;
  if (sx.hit) p.vx = 0;

  const sz = sweepAxis(box, 'z', p.vz * dt, solids);
  box.z = sz.value;
  if (sz.hit) p.vz = 0;

  const sy = sweepAxis(box, 'y', p.vy * dt, solids);
  const landed = sy.hit && p.vy <= 0;
  box.y = sy.value;
  if (sy.hit) p.vy = 0;

  p.x = box.x;
  p.z = box.z;
  p.y = box.y + p.height / 2;
  p.onGround = landed;
  if (landed) p.lastGroundedAt = now;

  // ── Jump pads ─────────────────────────────────────────────────────────────
  let padHit = null;
  if (p.onGround || p.y - p.height < 1.2) {
    for (const pad of jumpPads) {
      if (Math.abs(p.x - pad.x) < pad.hx + PLAYER.radius &&
          Math.abs(p.z - pad.z) < pad.hz + PLAYER.radius &&
          p.y - p.height <= 0.9 && now - p.lastPadAt > 250) {
        p.vy = pad.power;
        p.onGround = false;
        p.sliding = false;
        p.lastPadAt = now;
        padHit = pad;
        break;
      }
    }
  }

  // ── Head bob ──────────────────────────────────────────────────────────────
  const speed = Math.hypot(p.vx, p.vz);
  p.bob = p.onGround && speed > 0.5 ? p.bob + dt * speed * 1.1 : p.bob * 0.9;

  // ── Recoil recovery ───────────────────────────────────────────────────────
  const recover = Math.min(1, dt * 7);
  p.pitch -= p.recoilPitch * recover;
  p.yaw -= p.recoilYaw * recover;
  p.recoilPitch *= 1 - recover;
  p.recoilYaw *= 1 - recover;
  p.pitch = clamp(p.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

  const fellOut = p.y < killFloor;
  return { landed, padHit, fellOut, speed };
}

/** Apply a mouse delta to the view angles. */
export function applyLook(p, dx, dy, sensitivity, invertY = false) {
  p.yaw -= dx * sensitivity;
  p.pitch -= (invertY ? -dy : dy) * sensitivity;
  p.pitch = clamp(p.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  // Wrap into (-π, π] with a modulo rather than a single subtraction: a fast
  // flick can be many turns' worth of delta in one frame.
  p.yaw = ((p.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function addRecoil(p, recoil) {
  p.pitch += recoil.pitch;
  p.yaw += recoil.yaw;
  p.recoilPitch += recoil.pitch;
  p.recoilYaw += recoil.yaw;
}

export function damagePlayer(p, amount) {
  if (!p.alive) return 0;
  const applied = Math.min(p.health, amount);
  p.health -= applied;
  if (p.health <= 0) { p.health = 0; p.alive = false; }
  return applied;
}

export function healPlayer(p, amount) {
  const before = p.health;
  p.health = Math.min(PLAYER.maxHealth, p.health + amount);
  return p.health - before;
}

export function respawnPlayer(p, spawn) {
  p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.health = PLAYER.maxHealth;
  p.alive = true;
  p.sliding = false;
  p.crouching = false;
  p.height = PLAYER.standHeight;
  p.onGround = false;
  if (spawn.yaw !== undefined) p.yaw = spawn.yaw;
}
