import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFFICULTY, HEADSHOT_BONUS, KILL_SCORE, MODE_IDS, createModeRuntime, getMode,
  modeWeapon, registerKill, registerPlayerDeath, scoreForKill, tickMode,
} from '../fps/src/game/modes.js';

test('all five required modes are present', () => {
  assert.deepEqual(
    MODE_IDS.sort(),
    ['aimrush', 'gunprogression', 'onehit', 'survival', 'timeattack']
  );
});

test('every mode declares the interface the game loop calls', () => {
  for (const id of MODE_IDS) {
    const mode = getMode(id);
    assert.equal(typeof mode.name, 'string', `${id} needs a name`);
    assert.equal(typeof mode.blurb, 'string', `${id} needs a blurb`);
    assert.equal(typeof mode.isOver, 'function', `${id} needs isOver`);
    assert.equal(typeof mode.concurrentBots, 'function', `${id} needs concurrentBots`);
    assert.ok(mode.concurrentBots(1) > 0);
  }
});

test('an unknown mode id falls back to survival', () => {
  assert.equal(getMode('does-not-exist').id, 'survival');
});

test('scoring rewards headshots, streaks and distance', () => {
  const base = scoreForKill({ headshot: false, streak: 1, difficulty: 'normal' });
  assert.equal(base, KILL_SCORE);

  const head = scoreForKill({ headshot: true, streak: 1, difficulty: 'normal' });
  assert.equal(head, KILL_SCORE + HEADSHOT_BONUS);

  const streaked = scoreForKill({ headshot: false, streak: 4, difficulty: 'normal' });
  assert.ok(streaked > base, 'a streak is worth more');

  const far = scoreForKill({ headshot: false, streak: 1, difficulty: 'normal', distance: 50 });
  assert.ok(far > base, 'distance is worth more');
});

test('the streak bonus is capped', () => {
  const at6 = scoreForKill({ streak: 6, difficulty: 'normal' });
  const at40 = scoreForKill({ streak: 40, difficulty: 'normal' });
  assert.equal(at6, at40, 'the streak bonus stops growing');
});

test('difficulty scales the score', () => {
  const easy = scoreForKill({ streak: 1, difficulty: 'easy' });
  const normal = scoreForKill({ streak: 1, difficulty: 'normal' });
  const hard = scoreForKill({ streak: 1, difficulty: 'hard' });
  assert.ok(easy < normal && normal < hard);
});

test('the three difficulty levels differ in every dimension', () => {
  assert.deepEqual(Object.keys(DIFFICULTY), ['easy', 'normal', 'hard']);
  for (const key of ['botHealth', 'botDamage', 'botAccuracy', 'botSpeed', 'scoreMul']) {
    assert.ok(DIFFICULTY.easy[key] < DIFFICULTY.normal[key], `easy < normal for ${key}`);
    assert.ok(DIFFICULTY.normal[key] < DIFFICULTY.hard[key], `normal < hard for ${key}`);
  }
  assert.ok(DIFFICULTY.easy.botReaction > DIFFICULTY.hard.botReaction, 'hard bots react faster');
});

test('registering a kill accumulates score, kills and streak', () => {
  const rt = createModeRuntime('survival');
  const points = registerKill(rt, { headshot: true, difficulty: 'normal' });
  assert.equal(rt.kills, 1);
  assert.equal(rt.headshots, 1);
  assert.equal(rt.streak, 1);
  assert.equal(rt.score, points);

  registerKill(rt, {});
  assert.equal(rt.streak, 2);
  assert.equal(rt.bestStreak, 2);
});

test('survival advances a round once the wave is cleared, and never resets score', () => {
  const rt = createModeRuntime('survival');
  const mode = getMode('survival');
  const wave = mode.botsPerRound(1);

  for (let i = 0; i < wave; i++) registerKill(rt, {});
  assert.equal(rt.round, 2, 'clearing the wave promotes the round');
  assert.ok(rt.roundBanner?.includes('Round 2'));
  assert.ok(rt.score > 0, 'score carries into the next round');
  assert.equal(rt.over, false);
});

test('survival ends when the player dies', () => {
  const rt = createModeRuntime('survival');
  registerPlayerDeath(rt);
  assert.equal(rt.over, true);
  assert.equal(rt.outcome, 'dead');
});

test('time attack ends on the clock, not on death, and kills buy time', () => {
  const rt = createModeRuntime('timeattack');
  assert.equal(rt.timeLeftMs, 90_000);

  registerPlayerDeath(rt);
  assert.equal(rt.over, false, 'death does not end time attack');
  assert.equal(rt.streak, 0, 'but it does break the streak');

  tickMode(rt, 10_000);
  assert.equal(rt.timeLeftMs, 80_000);
  registerKill(rt, {});
  assert.equal(rt.timeLeftMs, 83_000, 'a kill adds three seconds');

  tickMode(rt, 999_999);
  assert.equal(rt.timeLeftMs, 0);
  assert.equal(rt.over, true);
  assert.equal(rt.outcome, 'timeup');
});

test('time attack caps the clock so it cannot be farmed forever', () => {
  const rt = createModeRuntime('timeattack');
  for (let i = 0; i < 200; i++) registerKill(rt, {});
  assert.ok(rt.timeLeftMs <= 180_000);
});

test('aim rush forces the railgun and one-hit kills', () => {
  const rt = createModeRuntime('aimrush');
  const mode = getMode('aimrush');
  assert.equal(modeWeapon(rt), 'railgun');
  assert.equal(mode.oneHitKills, true);
  assert.equal(mode.infiniteAmmo, true);
  assert.equal(mode.playerLives, false);
  assert.equal(rt.timeLeftMs, 60_000);
});

test('gun progression promotes every three kills and wins after the last rung', () => {
  const rt = createModeRuntime('gunprogression');
  assert.equal(modeWeapon(rt), 'rifle');

  for (let i = 0; i < 3; i++) registerKill(rt, {});
  assert.equal(modeWeapon(rt), 'shotgun', 'three kills promotes to the shotgun');

  for (let i = 0; i < 3; i++) registerKill(rt, {});
  assert.equal(modeWeapon(rt), 'railgun');
  assert.equal(rt.over, false);

  for (let i = 0; i < 3; i++) registerKill(rt, {});
  assert.equal(rt.over, true);
  assert.equal(rt.outcome, 'win');
});

test('gun progression can also be lost', () => {
  const rt = createModeRuntime('gunprogression');
  registerPlayerDeath(rt);
  assert.equal(rt.over, true);
  assert.equal(rt.outcome, 'dead');
});

test('one hit kills in both directions', () => {
  const mode = getMode('onehit');
  assert.equal(mode.oneHitKills, true);
  assert.equal(mode.oneHitDeaths, true);

  const rt = createModeRuntime('onehit');
  registerPlayerDeath(rt);
  assert.equal(rt.over, true);
});

test('untimed modes never tick their clock down', () => {
  const rt = createModeRuntime('survival');
  tickMode(rt, 500_000);
  assert.equal(rt.timeLeftMs, Infinity);
  assert.equal(rt.over, false);
});

test('a finished runtime ignores further ticks', () => {
  const rt = createModeRuntime('timeattack');
  tickMode(rt, 999_999);
  assert.equal(rt.over, true);
  const before = rt.timeLeftMs;
  tickMode(rt, 5000);
  assert.equal(rt.timeLeftMs, before);
});

test('a resumed session keeps its round', () => {
  const rt = createModeRuntime('survival', { round: 9 });
  assert.equal(rt.round, 9);
  assert.ok(getMode('survival').concurrentBots(9) > getMode('survival').concurrentBots(1));
});
