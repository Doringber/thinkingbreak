import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADSHOT_MULTIPLIER, WEAPONS, canFire, cancelReload, createLoadout,
  createWeaponState, cycleWeapon, damageAt, finishReload, fire, giveAmmo,
  isReloading, shotIntervalMs, startReload, weaponDef,
} from '../fps/src/game/weapons.js';

const seq = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('the three required weapon classes exist with distinct stats', () => {
  assert.equal(WEAPONS.length, 3);
  assert.deepEqual(WEAPONS.map((w) => w.id), ['rifle', 'shotgun', 'railgun']);

  const distinct = (key) => new Set(WEAPONS.map((w) => w[key])).size;
  for (const key of ['damage', 'rpm', 'spread', 'recoil', 'magazine', 'reloadMs', 'range']) {
    assert.equal(distinct(key), 3, `every weapon should have its own ${key}`);
  }
  assert.equal(weaponDef('shotgun').pellets, 9, 'the shotgun fires a spread of pellets');
  assert.equal(weaponDef('rifle').auto, true, 'the rifle is automatic');
  assert.equal(weaponDef('railgun').auto, false, 'the railgun is not');
});

test('fire rate is enforced from rpm', () => {
  const def = weaponDef('rifle');
  const state = createWeaponState(def);
  const interval = shotIntervalMs(def);
  assert.ok(Math.abs(interval - 60000 / 660) < 1e-9);

  assert.ok(fire(def, state, 1000), 'first shot fires');
  assert.equal(fire(def, state, 1000 + interval - 1), null, 'a shot inside the interval is refused');
  assert.equal(canFire(def, state, 1000 + interval - 1).reason, 'cooldown');
  assert.ok(fire(def, state, 1000 + interval), 'a shot at exactly the interval fires');
  assert.equal(state.ammo, def.magazine - 2);
});

test('firing consumes ammo and refuses an empty magazine', () => {
  const def = weaponDef('railgun');
  const state = createWeaponState(def);
  let now = 0;
  for (let i = 0; i < def.magazine; i++) {
    assert.ok(fire(def, state, now), `shot ${i + 1} fires`);
    now += shotIntervalMs(def);
  }
  assert.equal(state.ammo, 0);
  assert.equal(fire(def, state, now), null);
  assert.equal(canFire(def, state, now).reason, 'empty');
});

test('a shot produces one ray per pellet, inside the spread cone', () => {
  const def = weaponDef('shotgun');
  const state = createWeaponState(def);
  const shot = fire(def, state, 0, { rng: seq([0.5, 0.25]) });
  assert.equal(shot.rays.length, def.pellets);
  for (const ray of shot.rays) {
    const radius = Math.hypot(ray.yawOffset, ray.pitchOffset);
    assert.ok(radius <= def.spread + 1e-9, 'pellet stays inside the base cone when stationary');
  }
});

test('moving and airborne widen the cone', () => {
  const def = weaponDef('rifle');
  const spreadOf = (opts) => {
    const state = createWeaponState(def);
    // rng = 1 puts the sample on the rim of the cone.
    const shot = fire(def, state, 0, { ...opts, rng: () => 1 });
    return Math.hypot(shot.rays[0].yawOffset, shot.rays[0].pitchOffset);
  };
  const still = spreadOf({});
  const moving = spreadOf({ moving: true });
  const jumping = spreadOf({ moving: true, airborne: true });
  assert.ok(moving > still, 'moving is less accurate than standing still');
  assert.ok(jumping > moving, 'jumping is less accurate than running');
});

test('recoil kicks up and jitters horizontally', () => {
  const def = weaponDef('shotgun');
  const state = createWeaponState(def);
  const shot = fire(def, state, 0, { rng: () => 1 });
  assert.equal(shot.recoil.pitch, def.recoil);
  assert.ok(Math.abs(shot.recoil.yaw) <= def.recoilH + 1e-9);
});

test('damage falls off with distance and doubles-plus on a headshot', () => {
  const def = weaponDef('rifle');
  assert.equal(damageAt(def, 0), def.damage);
  assert.equal(damageAt(def, def.falloffStart), def.damage);

  const mid = damageAt(def, (def.falloffStart + def.falloffEnd) / 2);
  assert.ok(mid < def.damage && mid > def.damage * def.minDamageMul);

  const far = damageAt(def, def.falloffEnd + 50);
  assert.ok(Math.abs(far - def.damage * def.minDamageMul) < 0.01);

  assert.ok(Math.abs(damageAt(def, 0, true) - def.damage * HEADSHOT_MULTIPLIER) < 0.01);
});

test('the railgun has no falloff; the shotgun has severe falloff', () => {
  const rail = weaponDef('railgun');
  assert.equal(damageAt(rail, 0), damageAt(rail, 200));

  const shotgun = weaponDef('shotgun');
  assert.ok(damageAt(shotgun, 40) < damageAt(shotgun, 2) * 0.3);
});

test('reload moves rounds from reserve and only completes after reloadMs', () => {
  const def = weaponDef('rifle');
  const state = createWeaponState(def);
  state.ammo = 4;

  assert.equal(startReload(def, state, 0), true);
  assert.equal(isReloading(state, 0), true);
  assert.equal(finishReload(def, state, def.reloadMs - 1), false, 'not done yet');
  assert.equal(state.ammo, 4, 'ammo does not arrive early');

  assert.equal(finishReload(def, state, def.reloadMs), true);
  assert.equal(state.ammo, def.magazine);
  assert.equal(state.reserve, def.reserve - (def.magazine - 4));
  assert.equal(isReloading(state, def.reloadMs), false);
});

test('reload is a no-op when full, empty of reserve, or already running', () => {
  const def = weaponDef('rifle');

  const full = createWeaponState(def);
  assert.equal(startReload(def, full, 0), false, 'magazine already full');

  const dry = createWeaponState(def);
  dry.ammo = 0;
  dry.reserve = 0;
  assert.equal(startReload(def, dry, 0), false, 'nothing left to load');

  const busy = createWeaponState(def);
  busy.ammo = 1;
  assert.equal(startReload(def, busy, 0), true);
  assert.equal(startReload(def, busy, 10), false, 'already reloading');
});

test('a partial reserve only tops the magazine up as far as it goes', () => {
  const def = weaponDef('shotgun');
  const state = createWeaponState(def);
  state.ammo = 0;
  state.reserve = 2;
  startReload(def, state, 0);
  finishReload(def, state, def.reloadMs);
  assert.equal(state.ammo, 2);
  assert.equal(state.reserve, 0);
});

test('firing is blocked while reloading, and cancelling unblocks it', () => {
  const def = weaponDef('rifle');
  const state = createWeaponState(def);
  state.ammo = 5;
  startReload(def, state, 0);
  assert.equal(canFire(def, state, 100).reason, 'reloading');
  assert.equal(fire(def, state, 100), null);

  cancelReload(state);
  assert.equal(canFire(def, state, 100).ok, true);
  assert.equal(state.ammo, 5, 'a cancelled reload does not add rounds');
});

test('ammo pickups are capped at twice the starting reserve', () => {
  const def = weaponDef('rifle');
  const state = createWeaponState(def);
  giveAmmo(state, def, 10_000);
  assert.equal(state.reserve, def.reserve * 2);
  assert.equal(giveAmmo(state, def, 50), 0, 'a full reserve accepts nothing');
});

test('weapon cycling wraps in both directions', () => {
  assert.equal(cycleWeapon('rifle', 1), 'shotgun');
  assert.equal(cycleWeapon('railgun', 1), 'rifle');
  assert.equal(cycleWeapon('rifle', -1), 'railgun');
});

test('a loadout starts with every weapon and a valid current selection', () => {
  const loadout = createLoadout('railgun');
  assert.equal(loadout.current, 'railgun');
  assert.deepEqual(Object.keys(loadout.states).sort(), ['railgun', 'rifle', 'shotgun']);

  assert.equal(createLoadout('nonsense').current, 'rifle', 'unknown ids fall back to the rifle');
});
