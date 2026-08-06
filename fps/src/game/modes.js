// Thinking Break — short game modes.
//
// Every mode is sized for an agent turn: 10 seconds to about 5 minutes. Modes
// are described declaratively and drive the game loop through a tiny interface
// (`onStart`, `onKill`, `onTick`, `isOver`) so adding one never touches the
// renderer.

export const DIFFICULTY = {
  easy: { botHealth: 70, botDamage: 6, botAccuracy: 0.35, botReaction: 720, botSpeed: 4.2, scoreMul: 0.8 },
  normal: { botHealth: 100, botDamage: 9, botAccuracy: 0.55, botReaction: 420, botSpeed: 5.4, scoreMul: 1 },
  hard: { botHealth: 130, botDamage: 13, botAccuracy: 0.78, botReaction: 220, botSpeed: 6.4, scoreMul: 1.35 },
};

export const KILL_SCORE = 100;
export const HEADSHOT_BONUS = 60;

/**
 * @typedef {object} ModeRuntime
 * @property {number} timeLeftMs   Remaining time, or Infinity for untimed modes.
 * @property {number} round
 * @property {number} botsAlive
 * @property {number} kills
 * @property {number} score
 * @property {boolean} over
 * @property {string} [outcome]
 */

const base = {
  /** Bots present at once. */
  concurrentBots: (round) => Math.min(6, 2 + Math.floor(round / 2)),
  /** Player is mortal by default. */
  playerLives: true,
  /** Weapon the mode forces, or null to keep the player's choice. */
  forcedWeapon: null,
  infiniteAmmo: false,
  oneHitKills: false,
  oneHitDeaths: false,
  durationMs: Infinity,
  respawnBots: true,
};

/** @type {Record<string, object>} */
export const MODES = {
  survival: {
    ...base,
    id: 'survival',
    name: 'Survival',
    blurb: 'Endless waves. Each round is faster and hits harder.',
    hint: 'Stay alive. Rounds escalate.',
    concurrentBots: (round) => Math.min(7, 2 + Math.floor(round / 2)),
    botsPerRound: (round) => 4 + round * 2,
    onStart(rt) { rt.botsRemaining = this.botsPerRound(rt.round); },
    onKill(rt) {
      rt.botsRemaining -= 1;
      if (rt.botsRemaining <= 0) {
        rt.round += 1;
        rt.botsRemaining = this.botsPerRound(rt.round);
        rt.roundBanner = `Round ${rt.round}`;
      }
    },
    isOver: (rt) => rt.playerDead,
  },

  timeattack: {
    ...base,
    id: 'timeattack',
    name: 'Time Attack',
    blurb: 'Ninety seconds. Every kill adds three back.',
    hint: 'Kills extend the clock.',
    durationMs: 90_000,
    playerLives: false,
    concurrentBots: () => 5,
    onKill(rt) { rt.timeLeftMs = Math.min(180_000, rt.timeLeftMs + 3000); },
    isOver: (rt) => rt.timeLeftMs <= 0,
  },

  aimrush: {
    ...base,
    id: 'aimrush',
    name: 'Aim Rush',
    blurb: 'Stationary-ish targets, one shot each. Pure accuracy.',
    hint: 'Precision rifle only. Headshots are worth double.',
    durationMs: 60_000,
    playerLives: false,
    forcedWeapon: 'railgun',
    infiniteAmmo: true,
    oneHitKills: true,
    concurrentBots: () => 4,
    isOver: (rt) => rt.timeLeftMs <= 0,
  },

  gunprogression: {
    ...base,
    id: 'gunprogression',
    name: 'Gun Progression',
    blurb: 'Three kills promotes you. Clear the last weapon to win.',
    hint: 'Rifle → shotgun → railgun.',
    ladder: ['rifle', 'shotgun', 'railgun'],
    killsPerRung: 3,
    infiniteAmmo: true,
    concurrentBots: () => 3,
    onStart(rt) { rt.rung = 0; rt.rungKills = 0; },
    onKill(rt) {
      rt.rungKills += 1;
      if (rt.rungKills >= this.killsPerRung) {
        rt.rungKills = 0;
        rt.rung += 1;
        if (rt.rung < this.ladder.length) rt.roundBanner = `Promoted → ${this.ladder[rt.rung]}`;
      }
    },
    weaponFor(rt) { return this.ladder[Math.min(rt.rung ?? 0, this.ladder.length - 1)]; },
    isOver(rt) { return rt.playerDead || (rt.rung ?? 0) >= this.ladder.length; },
    outcomeFor(rt) { return (rt.rung ?? 0) >= this.ladder.length ? 'win' : 'dead'; },
  },

  onehit: {
    ...base,
    id: 'onehit',
    name: 'One Hit',
    blurb: 'One shot kills. So does one hit on you.',
    hint: 'No second chances — use cover.',
    oneHitKills: true,
    oneHitDeaths: true,
    concurrentBots: () => 3,
    isOver: (rt) => rt.playerDead,
  },
};

export const MODE_IDS = Object.keys(MODES);

export function getMode(id) {
  return MODES[id] ?? MODES.survival;
}

/** Fresh runtime for a mode. `round` lets a resumed session keep its progress. */
export function createModeRuntime(modeId, { round = 1 } = {}) {
  const mode = getMode(modeId);
  const rt = {
    modeId: mode.id,
    round: Math.max(1, round),
    timeLeftMs: mode.durationMs,
    kills: 0,
    headshots: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    botsAlive: 0,
    playerDead: false,
    over: false,
    outcome: null,
    roundBanner: null,
  };
  mode.onStart?.call(mode, rt);
  return rt;
}

/** Score for one kill, including streak and headshot bonuses. */
export function scoreForKill({ headshot, streak, difficulty = 'normal', distance = 0 }) {
  const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  const streakBonus = Math.min(5, Math.max(0, streak - 1)) * 20;
  const distanceBonus = distance > 40 ? 40 : distance > 20 ? 15 : 0;
  const raw = KILL_SCORE + (headshot ? HEADSHOT_BONUS : 0) + streakBonus + distanceBonus;
  return Math.round(raw * diff.scoreMul);
}

/** Register a kill against the runtime. Returns the points awarded. */
export function registerKill(rt, { headshot = false, difficulty = 'normal', distance = 0 } = {}) {
  const mode = getMode(rt.modeId);
  rt.kills += 1;
  if (headshot) rt.headshots += 1;
  rt.streak += 1;
  rt.bestStreak = Math.max(rt.bestStreak, rt.streak);
  const points = scoreForKill({ headshot, streak: rt.streak, difficulty, distance });
  rt.score += points;
  mode.onKill?.call(mode, rt);
  refreshOver(rt);
  return points;
}

export function registerPlayerDeath(rt) {
  const mode = getMode(rt.modeId);
  rt.streak = 0;
  if (mode.playerLives) rt.playerDead = true;
  refreshOver(rt);
}

/** Advance mode timers. `dtMs` is real elapsed time; paused frames never call this. */
export function tickMode(rt, dtMs) {
  if (rt.over) return rt;
  if (Number.isFinite(rt.timeLeftMs)) {
    rt.timeLeftMs = Math.max(0, rt.timeLeftMs - dtMs);
  }
  refreshOver(rt);
  return rt;
}

function refreshOver(rt) {
  const mode = getMode(rt.modeId);
  if (!rt.over && mode.isOver.call(mode, rt)) {
    rt.over = true;
    rt.outcome = mode.outcomeFor ? mode.outcomeFor.call(mode, rt) : (rt.playerDead ? 'dead' : 'timeup');
  }
}

/** Weapon the mode dictates for the current runtime, or null for free choice. */
export function modeWeapon(rt) {
  const mode = getMode(rt.modeId);
  if (mode.weaponFor) return mode.weaponFor.call(mode, rt);
  return mode.forcedWeapon;
}
