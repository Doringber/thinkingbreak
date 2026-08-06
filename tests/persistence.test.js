import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SAVE, SAVE_VERSION, STORAGE_KEY, createStore, defaultSave, normalizeSave,
} from '../fps/src/core/storage.js';

/** Minimal in-memory stand-in for localStorage. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
    raw: map,
  };
}

test('an empty store returns the defaults', () => {
  const store = createStore(fakeStorage());
  const save = store.load();
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(save.mode, DEFAULT_SAVE.mode);
  assert.equal(save.score, 0);
  assert.equal(save.round, 1);
});

test('a round-trip preserves everything that has to survive an agent turn', () => {
  const store = createStore(fakeStorage());
  store.save({
    ...defaultSave(),
    mode: 'timeattack',
    round: 7,
    score: 12_500,
    weapon: 'railgun',
    highScores: { timeattack: 12_500, survival: 900 },
    progress: { kills: 88, headshots: 21, shotsFired: 400, shotsHit: 190, timePlayedMs: 61_000, sessionsResumed: 12 },
    settings: {
      sensitivity: 0.0035, quality: 'high', difficulty: 'hard',
      masterVolume: 0.25, sfxEnabled: true, invertY: true, fov: 105, showFps: true,
    },
  });

  const loaded = store.load();
  assert.equal(loaded.mode, 'timeattack');
  assert.equal(loaded.round, 7);
  assert.equal(loaded.score, 12_500);
  assert.equal(loaded.weapon, 'railgun');
  assert.equal(loaded.highScores.timeattack, 12_500);
  assert.equal(loaded.progress.kills, 88);
  assert.equal(loaded.settings.sensitivity, 0.0035);
  assert.equal(loaded.settings.quality, 'high');
  assert.equal(loaded.settings.difficulty, 'hard');
  assert.equal(loaded.settings.fov, 105);
  assert.equal(loaded.settings.invertY, true);
  assert.ok(loaded.savedAt > 0, 'a session timestamp is recorded');
});

test('corrupt JSON is discarded, not thrown, and the bad entry is cleared', () => {
  const backing = fakeStorage({ [STORAGE_KEY]: '{not json at all' });
  const store = createStore(backing);
  const save = store.load();
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(save.score, 0);
  assert.equal(backing.getItem(STORAGE_KEY), null, 'the unreadable entry was removed');
});

test('non-object saved values fall back to the defaults', () => {
  for (const raw of ['null', '42', '"a string"', '[1,2,3]', 'true']) {
    const store = createStore(fakeStorage({ [STORAGE_KEY]: raw }));
    assert.equal(store.load().version, SAVE_VERSION, `${raw} should not survive`);
  }
});

test('a v1 save migrates to the current version', () => {
  const v1 = { version: 1, mode: 'survival', round: 3, score: 500, sens: 0.005, highScore: 777 };
  const migrated = normalizeSave(v1);
  assert.equal(migrated.version, SAVE_VERSION);
  assert.equal(migrated.round, 3);
  assert.equal(migrated.score, 500);
  assert.equal(migrated.settings.sensitivity, 0.005, 'the old top-level `sens` moved into settings');
  assert.equal(migrated.highScores.survival, 777, 'the old single high score became a per-mode record');
  assert.equal(migrated.progress.kills, 0, 'the progress block was backfilled');
  assert.equal(migrated.sens, undefined, 'the legacy field is gone');
});

test('a v2 save migrates to the current version', () => {
  const v2 = {
    version: 2, mode: 'aimrush', round: 1, score: 100, highScore: 4242,
    settings: { ...defaultSave().settings, quality: 'low' },
    progress: { ...defaultSave().progress, kills: 5 },
  };
  const migrated = normalizeSave(v2);
  assert.equal(migrated.version, SAVE_VERSION);
  assert.equal(migrated.highScores.aimrush, 4242);
  assert.equal(migrated.settings.quality, 'low');
  assert.equal(migrated.progress.kills, 5);
  assert.equal(migrated.highScore, undefined);
});

test('a save from a newer build is reset rather than misread', () => {
  const future = normalizeSave({ version: SAVE_VERSION + 5, score: 99_999, mode: 'unknown-mode' });
  assert.equal(future.version, SAVE_VERSION);
  assert.equal(future.score, 0);
});

test('partially corrupted saves keep what is salvageable', () => {
  const messy = normalizeSave({
    version: SAVE_VERSION,
    mode: 'onehit',
    round: 'not a number',
    score: -50,
    weapon: 12345,
    settings: { sensitivity: 'fast', quality: 'ultra', fov: 9999, masterVolume: 5, sfxEnabled: 'yes' },
    progress: 'gone',
    highScores: { survival: 1200, bogus: 'nope', neg: -3 },
  });

  assert.equal(messy.mode, 'onehit', 'the valid field survived');
  assert.equal(messy.round, 1, 'a non-numeric round falls back');
  assert.equal(messy.score, 0, 'a negative score is clamped');
  assert.equal(messy.weapon, 'rifle', 'a non-string weapon falls back');
  assert.equal(messy.settings.sensitivity, DEFAULT_SAVE.settings.sensitivity);
  assert.equal(messy.settings.quality, DEFAULT_SAVE.settings.quality, 'an unknown quality falls back');
  assert.equal(messy.settings.fov, 120, 'an out-of-range fov is clamped to the maximum');
  assert.equal(messy.settings.masterVolume, 1, 'volume is clamped to 0..1');
  assert.equal(messy.settings.sfxEnabled, DEFAULT_SAVE.settings.sfxEnabled);
  assert.equal(messy.progress.kills, 0, 'a bad progress block is rebuilt');
  assert.equal(messy.highScores.survival, 1200, 'valid high scores survive');
  assert.equal(messy.highScores.bogus, undefined, 'invalid ones are dropped');
  assert.equal(messy.highScores.neg, undefined);
});

test('the store survives a storage backend that throws', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('blocked'); },
  };
  const store = createStore(hostile);
  assert.equal(store.load().version, SAVE_VERSION, 'a failing read yields defaults');
  const saved = store.save({ ...defaultSave(), score: 300 });
  assert.equal(saved.score, 300, 'a failing write still returns the normalized save');
});

test('clear() wipes the stored session', () => {
  const backing = fakeStorage();
  const store = createStore(backing);
  store.save({ ...defaultSave(), score: 42 });
  assert.ok(backing.getItem(STORAGE_KEY));
  store.clear();
  assert.equal(backing.getItem(STORAGE_KEY), null);
  assert.equal(store.load().score, 0);
});

test('saving always stamps the current version', () => {
  const backing = fakeStorage();
  const store = createStore(backing);
  store.save({ ...defaultSave(), version: 1, score: 10 });
  assert.equal(JSON.parse(backing.getItem(STORAGE_KEY)).version, SAVE_VERSION);
});
