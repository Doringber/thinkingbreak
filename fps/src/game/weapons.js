// Thinking Break — weapon definitions and firing rules.
//
// All original designs. The module is deliberately free of rendering and audio
// so the damage/fire-rate/reload rules can be unit-tested directly.

export const HEADSHOT_MULTIPLIER = 2.5;

/**
 * @typedef {object} WeaponDef
 * @property {string} id
 * @property {string} name
 * @property {number} damage        Damage per pellet at point blank.
 * @property {number} pellets       Rays cast per shot.
 * @property {number} rpm           Rounds per minute.
 * @property {number} spread        Base cone half-angle in radians.
 * @property {number} moveSpread    Extra spread while moving/airborne.
 * @property {number} recoil        Vertical kick per shot, radians.
 * @property {number} recoilH       Horizontal kick magnitude, radians.
 * @property {number} magazine
 * @property {number} reserve       Starting reserve ammo.
 * @property {number} reloadMs
 * @property {number} range
 * @property {number} falloffStart  Distance where damage begins to drop.
 * @property {number} falloffEnd    Distance where damage bottoms out.
 * @property {number} minDamageMul  Damage multiplier at/after falloffEnd.
 */

/** @type {WeaponDef[]} */
export const WEAPONS = [
  {
    id: 'rifle',
    name: 'AR-9 Cascade',
    slot: 1,
    damage: 21,
    pellets: 1,
    rpm: 660,
    spread: 0.006,
    moveSpread: 0.028,
    recoil: 0.009,
    recoilH: 0.004,
    magazine: 30,
    reserve: 150,
    reloadMs: 1500,
    range: 120,
    falloffStart: 30,
    falloffEnd: 70,
    minDamageMul: 0.6,
    auto: true,
    color: [0.25, 0.42, 0.95],
    pitch: 420,
  },
  {
    id: 'shotgun',
    name: 'SG-12 Breaker',
    slot: 2,
    damage: 13,
    pellets: 9,
    rpm: 75,
    spread: 0.075,
    moveSpread: 0.03,
    recoil: 0.05,
    recoilH: 0.012,
    magazine: 6,
    reserve: 40,
    reloadMs: 2100,
    range: 45,
    falloffStart: 6,
    falloffEnd: 22,
    minDamageMul: 0.22,
    auto: false,
    color: [0.95, 0.55, 0.22],
    pitch: 180,
  },
  {
    id: 'railgun',
    name: 'RG-1 Longshot',
    slot: 3,
    damage: 88,
    pellets: 1,
    rpm: 50,
    spread: 0,
    moveSpread: 0.05,
    recoil: 0.07,
    recoilH: 0.006,
    magazine: 4,
    reserve: 22,
    reloadMs: 2400,
    range: 250,
    falloffStart: 250,
    falloffEnd: 250,
    minDamageMul: 1,
    auto: false,
    pierce: true,
    color: [0.62, 0.35, 0.98],
    pitch: 900,
  },
];

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

export function weaponDef(id) {
  return WEAPONS_BY_ID[id] ?? WEAPONS[0];
}

/** Minimum time between shots, in milliseconds. */
export function shotIntervalMs(def) {
  return 60000 / def.rpm;
}

/** Fresh mutable state for one weapon. */
export function createWeaponState(def) {
  return {
    id: def.id,
    ammo: def.magazine,
    reserve: def.reserve,
    lastShotAt: -Infinity,
    reloadingUntil: 0,
  };
}

export function createLoadout(startWeapon = 'rifle') {
  const states = {};
  for (const def of WEAPONS) states[def.id] = createWeaponState(def);
  return { current: WEAPONS_BY_ID[startWeapon] ? startWeapon : 'rifle', states };
}

export function isReloading(state, now) {
  return now < state.reloadingUntil;
}

/**
 * Can this weapon fire right now?
 * @returns {{ ok: boolean, reason?: 'reloading'|'empty'|'cooldown' }}
 */
export function canFire(def, state, now) {
  if (isReloading(state, now)) return { ok: false, reason: 'reloading' };
  if (state.ammo <= 0) return { ok: false, reason: 'empty' };
  if (now - state.lastShotAt < shotIntervalMs(def)) return { ok: false, reason: 'cooldown' };
  return { ok: true };
}

/**
 * Consume one shot. Mutates `state`; returns the per-shot data the game needs.
 * Callers must check `canFire` first — this asserts rather than silently no-ops,
 * because a caller that skips the check has a bug worth surfacing in tests.
 */
export function fire(def, state, now, { moving = false, airborne = false, rng = Math.random } = {}) {
  const gate = canFire(def, state, now);
  if (!gate.ok) return null;

  state.ammo -= 1;
  state.lastShotAt = now;

  const spread = def.spread + (moving ? def.moveSpread : 0) + (airborne ? def.moveSpread * 0.8 : 0);
  const rays = [];
  for (let i = 0; i < def.pellets; i++) {
    // Uniform-ish disc sample in the spread cone.
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * spread;
    rays.push({ yawOffset: Math.cos(angle) * radius, pitchOffset: Math.sin(angle) * radius });
  }

  return {
    rays,
    recoil: { pitch: def.recoil, yaw: (rng() - 0.5) * 2 * def.recoilH },
    ammoLeft: state.ammo,
  };
}

/** Distance-based damage falloff, then the headshot multiplier. */
export function damageAt(def, distance, headshot = false) {
  let mul = 1;
  if (distance >= def.falloffEnd) {
    mul = def.minDamageMul;
  } else if (distance > def.falloffStart) {
    const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
    mul = 1 + (def.minDamageMul - 1) * t;
  }
  const dmg = def.damage * mul * (headshot ? HEADSHOT_MULTIPLIER : 1);
  return Math.round(dmg * 100) / 100;
}

/**
 * Begin a reload. Returns false when it would be a no-op (full mag, no reserve,
 * or already reloading) so the UI does not play a sound for nothing.
 */
export function startReload(def, state, now) {
  if (isReloading(state, now)) return false;
  if (state.ammo >= def.magazine) return false;
  if (state.reserve <= 0) return false;
  state.reloadingUntil = now + def.reloadMs;
  return true;
}

/** Move rounds from reserve into the magazine once the timer elapses. */
export function finishReload(def, state, now) {
  if (state.reloadingUntil === 0 || now < state.reloadingUntil) return false;
  state.reloadingUntil = 0;
  const need = def.magazine - state.ammo;
  const take = Math.min(need, state.reserve);
  state.ammo += take;
  state.reserve -= take;
  return take > 0;
}

/** Cancel an in-flight reload (weapon switch, pause, death). */
export function cancelReload(state) {
  state.reloadingUntil = 0;
}

export function giveAmmo(state, def, amount) {
  const before = state.reserve;
  state.reserve = Math.min(def.reserve * 2, state.reserve + amount);
  return state.reserve - before;
}

/** Cycle weapons by `dir` (+1 / -1) through the slot order. */
export function cycleWeapon(currentId, dir) {
  const idx = WEAPONS.findIndex((w) => w.id === currentId);
  const next = (idx + dir + WEAPONS.length) % WEAPONS.length;
  return WEAPONS[next].id;
}
