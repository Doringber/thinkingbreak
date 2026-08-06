// Thinking Break — versioned session persistence.
//
// A single localStorage key holds everything. The version field lets old saves
// be migrated forward; anything unreadable is discarded rather than crashing
// the game on boot, because a corrupted save must never cost the player a
// working game.

export const STORAGE_KEY = 'thinking-break/save';
export const SAVE_VERSION = 3;

export const DEFAULT_SAVE = Object.freeze({
  version: SAVE_VERSION,
  // Session — restored when the agent goes busy again.
  mode: 'survival',
  round: 1,
  score: 0,
  weapon: 'rifle',
  progress: {
    kills: 0,
    headshots: 0,
    shotsFired: 0,
    shotsHit: 0,
    timePlayedMs: 0,
    sessionsResumed: 0,
  },
  highScores: {},
  settings: {
    sensitivity: 0.0022,
    quality: 'auto',
    difficulty: 'normal',
    masterVolume: 0.6,
    sfxEnabled: true,
    invertY: false,
    fov: 90,
    showFps: false,
  },
  savedAt: 0,
});

function deepFreezeClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function defaultSave() {
  return deepFreezeClone(DEFAULT_SAVE);
}

/** Migration chain. Each entry upgrades from its key version to key+1. */
const MIGRATIONS = {
  // v1 stored `sens` at the top level and had no progress block.
  1(save) {
    const out = { ...save, version: 2 };
    out.settings = { ...defaultSave().settings, sensitivity: save.sens ?? DEFAULT_SAVE.settings.sensitivity };
    delete out.sens;
    out.progress = { ...defaultSave().progress };
    return out;
  },
  // v2 kept a single `highScore` number instead of per-mode records.
  2(save) {
    const out = { ...save, version: 3 };
    out.highScores = save.highScores ?? {};
    if (typeof save.highScore === 'number' && save.highScore > 0) {
      out.highScores[save.mode ?? 'survival'] = save.highScore;
    }
    delete out.highScore;
    return out;
  },
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Coerce arbitrary parsed JSON into a valid save.
 * Unknown/garbage fields fall back to defaults field-by-field, so a partially
 * corrupted save still keeps whatever was salvageable.
 */
export function normalizeSave(raw) {
  const base = defaultSave();
  if (!isPlainObject(raw)) return base;

  let save = { ...raw };
  let version = Number.isInteger(save.version) ? save.version : 1;

  // Refuse to downgrade: a save from a newer build gets reset instead of
  // being misread by older field expectations.
  if (version > SAVE_VERSION) return base;

  let guard = 0;
  while (version < SAVE_VERSION && MIGRATIONS[version] && guard++ < 32) {
    try {
      save = MIGRATIONS[version](save);
    } catch {
      return base;
    }
    version = save.version;
  }
  if (version !== SAVE_VERSION) return base;

  const num = (v, d, lo, hi) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const str = (v, d, allowed) =>
    typeof v === 'string' && (!allowed || allowed.includes(v)) ? v : d;
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);

  const settings = isPlainObject(save.settings) ? save.settings : {};
  const progress = isPlainObject(save.progress) ? save.progress : {};

  const out = {
    version: SAVE_VERSION,
    mode: str(save.mode, base.mode),
    round: Math.max(1, Math.round(num(save.round, base.round, 1, 9999))),
    score: Math.max(0, Math.round(num(save.score, 0, 0, 1e9))),
    weapon: str(save.weapon, base.weapon),
    progress: {
      kills: Math.max(0, Math.round(num(progress.kills, 0, 0, 1e9))),
      headshots: Math.max(0, Math.round(num(progress.headshots, 0, 0, 1e9))),
      shotsFired: Math.max(0, Math.round(num(progress.shotsFired, 0, 0, 1e9))),
      shotsHit: Math.max(0, Math.round(num(progress.shotsHit, 0, 0, 1e9))),
      timePlayedMs: Math.max(0, num(progress.timePlayedMs, 0, 0, 1e12)),
      sessionsResumed: Math.max(0, Math.round(num(progress.sessionsResumed, 0, 0, 1e9))),
    },
    highScores: {},
    settings: {
      sensitivity: num(settings.sensitivity, base.settings.sensitivity, 0.0002, 0.02),
      quality: str(settings.quality, base.settings.quality, ['low', 'medium', 'high', 'auto']),
      difficulty: str(settings.difficulty, base.settings.difficulty, ['easy', 'normal', 'hard']),
      masterVolume: num(settings.masterVolume, base.settings.masterVolume, 0, 1),
      sfxEnabled: bool(settings.sfxEnabled, base.settings.sfxEnabled),
      invertY: bool(settings.invertY, base.settings.invertY),
      fov: num(settings.fov, base.settings.fov, 60, 120),
      showFps: bool(settings.showFps, base.settings.showFps),
    },
    savedAt: num(save.savedAt, 0, 0, 1e15),
  };

  if (isPlainObject(save.highScores)) {
    for (const [k, v] of Object.entries(save.highScores)) {
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        out.highScores[k] = Math.round(v);
      }
    }
  }
  return out;
}

/**
 * Storage wrapper that degrades to memory when localStorage is unavailable
 * (private browsing, sandboxed iframe, disabled storage in a webview).
 */
export function createStore(backing) {
  let memory = null;
  const ls = (() => {
    if (backing) return backing;
    try {
      const probe = '__tb_probe__';
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    } catch {
      return null;
    }
  })();

  function load() {
    if (!ls) return memory ? normalizeSave(memory) : defaultSave();
    let raw;
    try {
      raw = ls.getItem(STORAGE_KEY);
    } catch {
      return defaultSave();
    }
    if (!raw) return defaultSave();
    try {
      return normalizeSave(JSON.parse(raw));
    } catch {
      // Corrupt JSON: drop it so the next save starts clean.
      try { ls.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return defaultSave();
    }
  }

  function save(data) {
    const clean = normalizeSave({ ...data, version: SAVE_VERSION });
    clean.savedAt = Date.now();
    memory = clean;
    if (!ls) return clean;
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Quota or disabled storage — the in-memory copy still keeps the
      // session alive for the rest of this page load.
    }
    return clean;
  }

  function clear() {
    memory = null;
    try { ls?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  return { load, save, clear, available: ls !== null };
}
