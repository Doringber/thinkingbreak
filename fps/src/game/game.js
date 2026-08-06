// Thinking Break — the game orchestrator.
//
// Owns exactly one requestAnimationFrame loop for the lifetime of the page.
// `resume()` and `pause()` are idempotent and never rebuild the world: an agent
// going busy again picks up the same round, score, ammo and position it left.

import { Renderer } from '../core/renderer.js';
import { createInput } from '../core/input.js';
import { createAudio } from '../core/audio.js';
import { clamp, forwardFrom, makeRng } from '../core/math.js';
import { buildArena, pickSpawn } from './arena.js';
import { boxNormalAt, raycastSolids } from './collision.js';
import { createEffects } from './effects.js';
import {
  BOT, botBox, createBot, damageBot, raycastBots, respawnBot, stepBot,
} from './bots.js';
import {
  addRecoil, applyLook, createPlayer, damagePlayer, eyePosition, healPlayer,
  PLAYER, playerBox, respawnPlayer, stepPlayer,
} from './player.js';
import {
  DIFFICULTY, createModeRuntime, getMode, modeWeapon, registerKill,
  registerPlayerDeath, tickMode,
} from './modes.js';
import {
  cancelReload, canFire, createLoadout, cycleWeapon, damageAt, finishReload,
  fire, giveAmmo, isReloading, startReload, weaponDef, WEAPONS,
} from './weapons.js';

const FOG_COLOR = [0.043, 0.051, 0.078];
const MAX_FRAME_MS = 50;      // clamp the first frame after a resume
const FIXED_MAX_DT = 1 / 30;  // never integrate more than this in one step
const PICKUP_RESPAWN_MS = 9000;
const PICKUP_RADIUS = 1.15;

const QUALITY_PRESETS = {
  low: { renderScale: 0.62, pixelRatioCap: 1.0, far: 130, fogStart: 40, particles: 'low' },
  medium: { renderScale: 0.82, pixelRatioCap: 1.35, far: 190, fogStart: 70, particles: 'medium' },
  high: { renderScale: 1.0, pixelRatioCap: 2.0, far: 260, fogStart: 110, particles: 'high' },
};

export class Game {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {object} opts.hud
   * @param {object} opts.store    from `createStore()`
   * @param {object} [opts.menu]   pause/menu controller
   * @param {boolean} [opts.embedded]
   */
  constructor({ canvas, hud, store, menu, embedded = false }) {
    this.canvas = canvas;
    this.hud = hud;
    this.store = store;
    this.menu = menu;
    this.embedded = embedded;

    this.save = store.load();
    this.settings = this.save.settings;

    // Inside an editor panel the viewport is small and shares the machine with
    // a compiler, so default to the cheapest preset unless told otherwise.
    if (this.settings.quality === 'auto') {
      this.activeQuality = embedded ? 'low' : 'medium';
      this.autoQuality = true;
    } else {
      this.activeQuality = this.settings.quality;
      this.autoQuality = false;
    }

    this.renderer = new Renderer(canvas);
    this.effects = createEffects();
    this.audio = createAudio({ volume: this.settings.masterVolume, enabled: this.settings.sfxEnabled });
    this.rng = makeRng(Date.now() & 0xffff);

    this.arena = buildArena();
    this.player = createPlayer({ ...this.arena.playerSpawn, y: this.arena.playerSpawn.y + PLAYER.standHeight });
    this.bots = [];
    this.pickups = [];

    this.loadout = createLoadout(this.save.weapon);
    this.mode = createModeRuntime(this.save.mode, { round: this.save.round });
    this.mode.score = this.save.score;

    // ── Loop state ────────────────────────────────────────────────────────
    // `rafId !== null` is the single source of truth for "a loop is running".
    // Every entry point checks it, which is what makes duplicate busy events
    // and double `start()` calls harmless.
    this.rafId = null;
    this.running = false;
    this.started = false;
    this.paused = true;
    this.pauseReason = 'boot';
    this.lastFrameAt = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.qualitySampleAt = 0;
    this.sessionStartedAt = 0;
    this.gameOverAt = 0;
    this.userGestured = false;
    this.muzzleFlashUntil = 0;

    this.input = createInput(canvas, { onAction: (name, payload) => this.onInputAction(name, payload) });

    this._loop = this._loop.bind(this);
    this.applyQuality(this.activeQuality);
    this.resetPickups();
    this.syncModeWeapon();
    this.spawnBotsForMode();
    this.renderFrame(0); // one frame so the canvas is never blank before resume
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Idempotent. Safe to call from every busy event. */
  start() {
    this.started = true;
    this.resume();
  }

  resume() {
    if (this.running) return false;
    this.running = true;
    this.paused = false;
    this.pauseReason = null;
    this.lastFrameAt = performance.now();
    this.sessionStartedAt = this.lastFrameAt;
    // Browsers refuse to start an AudioContext before a gesture and log a
    // warning for every attempt, so hold off until the player has interacted.
    if (this.userGestured) this.audio.resume();
    this.menu?.setPaused(false);
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this._loop);
    }
    return true;
  }

  /**
   * Stop the loop and persist. Called on agent idle, on Escape, and on tab
   * hide. Cancelling the rAF outright is what drops a paused game to ~0% GPU.
   */
  pause(reason = 'manual') {
    if (!this.running) {
      // Already paused, but still refresh the reason/menu so a manual pause
      // arriving after an agent pause shows the right screen.
      this.pauseReason = reason;
      this.menu?.setPaused(true, reason);
      return false;
    }
    this.running = false;
    this.paused = true;
    this.pauseReason = reason;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.input.clearKeys();
    this.input.releaseLock();
    this.audio.suspend();
    this.persist();
    this.menu?.setPaused(true, reason);
    return true;
  }

  togglePause() {
    return this.running ? this.pause('manual') : this.resume();
  }

  destroy() {
    this.pause('destroy');
    this.input.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.hud.dispose?.();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  persist() {
    const played = this.sessionStartedAt ? performance.now() - this.sessionStartedAt : 0;
    const high = Math.max(this.save.highScores[this.mode.modeId] ?? 0, this.mode.score);
    this.save = this.store.save({
      ...this.save,
      mode: this.mode.modeId,
      round: this.mode.round,
      score: this.mode.score,
      weapon: this.loadout.current,
      settings: this.settings,
      highScores: { ...this.save.highScores, [this.mode.modeId]: high },
      progress: {
        ...this.save.progress,
        kills: this.save.progress.kills + this.pendingKills,
        headshots: this.save.progress.headshots + this.pendingHeadshots,
        shotsFired: this.save.progress.shotsFired + this.pendingShots,
        shotsHit: this.save.progress.shotsHit + this.pendingHits,
        timePlayedMs: this.save.progress.timePlayedMs + played,
      },
    });
    this.settings = this.save.settings;
    this.pendingKills = 0;
    this.pendingHeadshots = 0;
    this.pendingShots = 0;
    this.pendingHits = 0;
    this.sessionStartedAt = performance.now();
    return this.save;
  }

  get highScore() {
    return Math.max(this.save.highScores[this.mode.modeId] ?? 0, this.mode.score);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.save.settings = this.settings;
    if (patch.masterVolume !== undefined) this.audio.setVolume(patch.masterVolume);
    if (patch.sfxEnabled !== undefined) this.audio.setEnabled(patch.sfxEnabled);
    if (patch.quality !== undefined) {
      this.autoQuality = patch.quality === 'auto';
      this.applyQuality(this.autoQuality ? (this.embedded ? 'low' : 'medium') : patch.quality);
    }
    this.store.save(this.save);
  }

  applyQuality(name) {
    const preset = QUALITY_PRESETS[name] ?? QUALITY_PRESETS.medium;
    this.activeQuality = name;
    this.renderer.renderScale = preset.renderScale;
    this.renderer.pixelRatioCap = preset.pixelRatioCap;
    this.far = preset.far;
    this.fogStart = preset.fogStart;
    this.particleQuality = preset.particles;
  }

  // ── Round setup ───────────────────────────────────────────────────────────

  restart(modeId = this.mode.modeId, { round = 1 } = {}) {
    this.mode = createModeRuntime(modeId, { round });
    this.player = createPlayer({ ...this.arena.playerSpawn, y: this.arena.playerSpawn.y + PLAYER.standHeight });
    this.loadout = createLoadout(this.save.weapon);
    this.bots = [];
    this.effects.clear();
    this.resetPickups();
    this.syncModeWeapon();
    this.spawnBotsForMode();
    this.gameOverAt = 0;
    this.hud.banner(getMode(modeId).name, 1200);
    this.persist();
  }

  resetPickups() {
    this.pickups = this.arena.pickupSpots.map((spot) => ({ ...spot, active: true, respawnAt: 0 }));
    this.pendingKills = 0;
    this.pendingHeadshots = 0;
    this.pendingShots = 0;
    this.pendingHits = 0;
  }

  spawnBotsForMode() {
    const mode = getMode(this.mode.modeId);
    const want = mode.concurrentBots(this.mode.round);
    while (this.bots.length < want) {
      const spawn = pickSpawn(this.arena, this.player, this.rng, this.bots);
      this.bots.push(createBot(spawn, this.settings.difficulty, this.rng));
    }
    this.bots.length = Math.min(this.bots.length, want);
    this.mode.botsAlive = this.bots.filter((b) => b.alive).length;
  }

  /** Force the mode's weapon, if it has one. */
  syncModeWeapon() {
    const forced = modeWeapon(this.mode);
    if (forced && this.loadout.current !== forced) {
      this.loadout.current = forced;
      cancelReload(this.loadout.states[forced]);
    }
  }

  get currentWeapon() {
    const def = weaponDef(this.loadout.current);
    return { def, state: this.loadout.states[def.id] };
  }

  switchWeapon(id) {
    const mode = getMode(this.mode.modeId);
    if (mode.forcedWeapon || mode.weaponFor) return false;
    if (!this.loadout.states[id] || this.loadout.current === id) return false;
    cancelReload(this.currentWeapon.state);
    this.loadout.current = id;
    this.hud.toast(weaponDef(id).name, 900);
    return true;
  }

  // ── Input actions ─────────────────────────────────────────────────────────

  onInputAction(name, payload) {
    if (name === 'keydown' || name === 'mousedown' || name === 'requestLock') {
      this.userGestured = true;
    }
    if (name === 'requestLock') {
      if (this.running) this.input.requestLock();
      else this.resume();
      this.audio.resume();
      return;
    }
    if (name === 'pointerlockchange' && payload === false && this.running && !this.embedded) {
      // Losing the lock in a normal browser tab means the player alt-tabbed or
      // pressed Escape — pause rather than leave them shooting blind.
      this.pause('manual');
      return;
    }
    if (name !== 'keydown') return;

    switch (payload) {
      case 'Escape':
        this.togglePause();
        break;
      case 'KeyR': {
        const { def, state } = this.currentWeapon;
        if (this.running && startReload(def, state, performance.now())) this.audio.reload();
        break;
      }
      case 'Digit1': this.switchWeapon(WEAPONS[0].id); break;
      case 'Digit2': this.switchWeapon(WEAPONS[1].id); break;
      case 'Digit3': this.switchWeapon(WEAPONS[2].id); break;
      case 'KeyQ': this.switchWeapon(cycleWeapon(this.loadout.current, 1)); break;
      case 'KeyP': this.updateSettings({ showFps: !this.settings.showFps }); break;
      default: break;
    }
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  _loop(timestamp) {
    // A stale frame from before a pause must not restart the loop.
    if (!this.running) { this.rafId = null; return; }
    this.rafId = requestAnimationFrame(this._loop);

    const rawMs = Math.min(MAX_FRAME_MS, timestamp - this.lastFrameAt);
    this.lastFrameAt = timestamp;
    const dt = Math.min(FIXED_MAX_DT, Math.max(0, rawMs) / 1000);

    this.frameCount++;
    this.fpsAccum += rawMs;
    this.fpsFrames++;
    if (this.fpsAccum >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.maybeAdaptQuality(timestamp);
    }

    if (dt > 0) this.update(dt, timestamp);
    this.renderFrame(timestamp);

    // Cheap insurance against losing a long session to a browser crash.
    if (this.frameCount % 900 === 0) this.persist();
  }

  /** Auto quality: step down when sustained FPS is poor, step up when it is high. */
  maybeAdaptQuality(now) {
    if (!this.autoQuality || now - this.qualitySampleAt < 3000) return;
    this.qualitySampleAt = now;
    const order = ['low', 'medium', 'high'];
    const idx = order.indexOf(this.activeQuality);
    if (this.fps < 50 && idx > 0) this.applyQuality(order[idx - 1]);
    else if (this.fps > 110 && idx < order.length - 1) this.applyQuality(order[idx + 1]);
  }

  update(dt, now) {
    const mode = getMode(this.mode.modeId);

    // ── Look ────────────────────────────────────────────────────────────────
    const { dx, dy } = this.input.drainMouse();
    if (dx || dy) applyLook(this.player, dx, dy, this.settings.sensitivity, this.settings.invertY);
    const wheel = this.input.drainWheel();
    if (wheel) this.switchWeapon(cycleWeapon(this.loadout.current, wheel > 0 ? 1 : -1));

    // ── Movement ────────────────────────────────────────────────────────────
    const forward = (this.input.anyDown('KeyW', 'ArrowUp') ? 1 : 0) - (this.input.anyDown('KeyS', 'ArrowDown') ? 1 : 0);
    const strafe = (this.input.anyDown('KeyD', 'ArrowRight') ? 1 : 0) - (this.input.anyDown('KeyA', 'ArrowLeft') ? 1 : 0);
    const intent = {
      forward,
      strafe,
      jump: this.input.isDown('Space'),
      sprint: this.input.anyDown('ShiftLeft', 'ShiftRight'),
      crouch: this.input.anyDown('ControlLeft', 'ControlRight', 'KeyC'),
      now,
    };

    if (this.player.alive) {
      const step = stepPlayer(this.player, intent, this.arena, dt);
      if (step.padHit) this.audio.jumpPad();
      if (step.fellOut) {
        damagePlayer(this.player, PLAYER.maxHealth);
        this.onPlayerDied();
      }
    }

    // ── Weapons ─────────────────────────────────────────────────────────────
    const { def, state } = this.currentWeapon;
    if (finishReload(def, state, now)) this.hud.toast('Reloaded', 700);
    if (mode.infiniteAmmo) state.reserve = Math.max(state.reserve, def.reserve);

    const wantsFire = this.input.state.firing;
    if (wantsFire && this.player.alive && this.input.state.pointerLocked) {
      const gate = canFire(def, state, now);
      if (gate.ok) {
        this.shoot(def, state, now);
        if (!def.auto) this.input.state.firing = false;
      } else if (gate.reason === 'empty' && !isReloading(state, now)) {
        if (startReload(def, state, now)) this.audio.reload();
        else this.audio.empty();
      }
    }

    // ── Bots ────────────────────────────────────────────────────────────────
    const ctx = {
      arena: this.arena, player: this.player, now,
      difficulty: this.settings.difficulty, rng: this.rng,
    };
    for (const bot of this.bots) {
      if (!bot.alive) {
        if (mode.respawnBots && now - bot.diedAt > BOT.corpseMs) {
          respawnBot(bot, this.arena, this.player, this.settings.difficulty, this.rng,
            this.bots.filter((b) => b.alive));
        }
        continue;
      }
      const result = stepBot(bot, ctx, dt);
      if (result.shoot) this.onBotShot(bot, result.shoot);
    }
    this.mode.botsAlive = this.bots.filter((b) => b.alive).length;

    // ── Pickups ─────────────────────────────────────────────────────────────
    this.updatePickups(now);

    // ── Effects & mode timers ───────────────────────────────────────────────
    this.effects.update(dt);
    tickMode(this.mode, dt * 1000);

    if (this.mode.roundBanner) {
      this.hud.banner(this.mode.roundBanner, 1300);
      this.mode.roundBanner = null;
      this.syncModeWeapon();
      this.spawnBotsForMode();
    }

    if (this.mode.over && !this.gameOverAt) this.onGameOver(now);
  }

  shoot(def, state, now) {
    const p = this.player;
    const moving = Math.hypot(p.vx, p.vz) > 2.5;
    const shot = fire(def, state, now, { moving, airborne: !p.onGround, rng: this.rng });
    if (!shot) return;

    this.pendingShots += 1;
    this.audio.shot(def);
    addRecoil(p, shot.recoil);

    const eye = eyePosition(p);
    // The muzzle flash lives entirely in the viewmodel pass. Spawning world
    // particles at the muzzle looked like confetti: they inherit gravity and
    // bounce around the arena for a second after every shot.
    this.muzzleFlashUntil = now + 45;

    let anyHit = false;
    let anyHead = false;

    for (const ray of shot.rays) {
      const dir = forwardFrom(p.yaw + ray.yawOffset, clamp(p.pitch + ray.pitchOffset, -1.55, 1.55));
      const alive = this.bots.filter((b) => b.alive);

      const solidHit = raycastSolids(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], this.arena.solids, def.range);
      const botHit = raycastBots(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], alive, def.range);

      const wallDist = solidHit?.dist ?? def.range;
      const hitsBot = botHit && botHit.dist < wallDist;
      const endDist = Math.min(hitsBot ? botHit.dist : def.range, wallDist);

      // The railgun draws its full beam; everything else gets a short streak,
      // because a box can only yaw and a long one visibly misses the pitch.
      const trailEnd = def.id === 'railgun' ? endDist : Math.min(endDist, 9);
      this.effects.spawnTracer(
        eye[0] + dir[0] * 0.6, eye[1] + dir[1] * 0.6 - 0.08, eye[2] + dir[2] * 0.6,
        eye[0] + dir[0] * trailEnd, eye[1] + dir[1] * trailEnd - 0.08, eye[2] + dir[2] * trailEnd,
        def.color, def.id === 'railgun' ? 0.035 : 0.012, def.id === 'railgun' ? 0.16 : 0.045
      );

      if (hitsBot) {
        anyHit = true;
        if (botHit.headshot) anyHead = true;
        this.damageBotFromShot(def, botHit, dir, eye, now);
      } else if (solidHit) {
        const hx = eye[0] + dir[0] * solidHit.dist;
        const hy = eye[1] + dir[1] * solidHit.dist;
        const hz = eye[2] + dir[2] * solidHit.dist;
        const n = boxNormalAt(solidHit.box, hx, hy, hz);
        this.effects.spawnImpact(hx, hy, hz, n[0], n[1], n[2], [0.7, 0.75, 0.9], this.particleQuality === 'low' ? 2 : 5);
      }
    }

    if (anyHit) {
      this.pendingHits += 1;
      this.hud.hitmarker(anyHead);
      this.audio.hit(anyHead);
    }
  }

  damageBotFromShot(def, botHit, dir, eye, now) {
    const mode = getMode(this.mode.modeId);
    const { bot, headshot, dist } = botHit;
    const damage = mode.oneHitKills ? bot.maxHealth : damageAt(def, dist, headshot);

    const hx = eye[0] + dir[0] * dist;
    const hy = eye[1] + dir[1] * dist;
    const hz = eye[2] + dir[2] * dist;
    this.effects.spawnBlood(hx, hy, hz, bot.color, this.particleQuality === 'low' ? 3 : 8);

    const { killed } = damageBot(bot, damage);
    bot.flash = 1;
    if (!killed) return;

    bot.diedAt = now;
    this.pendingKills += 1;
    if (headshot) this.pendingHeadshots += 1;
    this.effects.spawnBurst(bot.x, bot.y, bot.z, bot.color, this.particleQuality === 'low' ? 6 : 18);
    this.audio.kill();

    const points = registerKill(this.mode, {
      headshot,
      difficulty: this.settings.difficulty,
      distance: dist,
    });
    this.hud.killfeed(`${headshot ? 'HEADSHOT' : 'ELIMINATED'} +${points}`);
    this.syncModeWeapon();
  }

  onBotShot(bot, shot) {
    const eye = eyePosition(this.player);
    this.effects.spawnTracer(
      shot.from.x, shot.from.y, shot.from.z,
      eye[0], eye[1], eye[2],
      [1, 0.5, 0.35], 0.012, 0.05
    );
    if (!shot.hitPlayer || !this.player.alive) return;

    const mode = getMode(this.mode.modeId);
    const damage = mode.oneHitDeaths ? PLAYER.maxHealth : shot.damage;
    damagePlayer(this.player, damage);
    this.hud.damageFlash();
    this.audio.hurt();
    this.mode.streak = 0;
    if (!this.player.alive) this.onPlayerDied();
  }

  onPlayerDied() {
    registerPlayerDeath(this.mode);
    const mode = getMode(this.mode.modeId);
    if (!mode.playerLives) {
      // Untimed-death modes just put the player back in play immediately.
      const spawn = pickSpawn(this.arena, { x: -this.player.x, z: -this.player.z }, this.rng);
      respawnPlayer(this.player, { ...spawn, y: spawn.y + PLAYER.standHeight });
      this.hud.banner('Respawned', 800);
    }
  }

  onGameOver(now) {
    this.gameOverAt = now;
    this.audio.gameOver();
    this.input.releaseLock();
    const isWin = this.mode.outcome === 'win';
    this.hud.banner(isWin ? 'CLEARED' : 'ROUND OVER', 2400);
    const record = this.mode.score > (this.save.highScores[this.mode.modeId] ?? 0);
    this.persist();
    this.menu?.showGameOver({
      score: this.mode.score,
      kills: this.mode.kills,
      headshots: this.mode.headshots,
      round: this.mode.round,
      bestStreak: this.mode.bestStreak,
      highScore: this.highScore,
      record,
      outcome: this.mode.outcome,
      modeName: getMode(this.mode.modeId).name,
    });
  }

  updatePickups(now) {
    const p = this.player;
    const { def, state } = this.currentWeapon;
    for (const pickup of this.pickups) {
      if (!pickup.active) {
        if (now >= pickup.respawnAt) pickup.active = true;
        continue;
      }
      const dx = p.x - pickup.x;
      const dy = (p.y - p.height / 2) - pickup.y;
      const dz = p.z - pickup.z;
      if (Math.hypot(dx, dy, dz) > PICKUP_RADIUS + PLAYER.radius) continue;

      let taken = false;
      if (pickup.type === 'health') {
        taken = healPlayer(p, 35) > 0;
      } else {
        taken = giveAmmo(state, def, Math.ceil(def.magazine * 1.5)) > 0;
      }
      if (!taken) continue;
      pickup.active = false;
      pickup.respawnAt = now + PICKUP_RESPAWN_MS;
      this.audio.pickup();
      this.hud.toast(pickup.type === 'health' ? '+35 HP' : '+AMMO', 700);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  renderFrame(now) {
    const p = this.player;
    const eye = eyePosition(p);
    const r = this.renderer;

    r.begin({
      eye,
      yaw: p.yaw,
      pitch: p.pitch,
      fovDeg: this.settings.fov + (Math.hypot(p.vx, p.vz) > PLAYER.walkSpeed + 1 ? 6 : 0),
      far: this.far,
      fogColor: FOG_COLOR,
      fogRange: [this.fogStart, this.far * 0.95],
    });

    for (const box of this.arena.solids) r.pushBox(box);
    for (const box of this.arena.decorations) {
      // Jump pads pulse so they read as interactive at a glance.
      const pulse = 0.75 + 0.25 * Math.sin(now / 260);
      r.push(box.x, box.y, box.z, box.hx, box.hy, box.hz,
        box.color[0] * pulse, box.color[1] * pulse, box.color[2] * pulse);
    }

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const flash = bot.flash;
      const cr = bot.color[0] + flash * (1 - bot.color[0]);
      const cg = bot.color[1] + flash * (1 - bot.color[1]);
      const cb = bot.color[2] + flash * (1 - bot.color[2]);
      const b = botBox(bot);
      r.push(b.x, b.y - 0.18, b.z, b.hx, b.hy * 0.72, b.hz, cr * 0.8, cg * 0.8, cb * 0.8, bot.yaw);
      // Head block — the visual cue for where the headshot box is.
      r.push(b.x, b.y + b.hy - 0.22, b.z, 0.26, 0.22, 0.26, cr, cg, cb, bot.yaw);
      // Health nub above the head.
      const frac = bot.health / bot.maxHealth;
      r.push(b.x, b.y + b.hy + 0.35, b.z, 0.3 * frac, 0.045, 0.045,
        1 - frac, frac, 0.25, bot.yaw);
    }

    for (const pickup of this.pickups) {
      if (!pickup.active) continue;
      const bobY = pickup.y + 0.42 + Math.sin(now / 400 + pickup.x) * 0.12;
      const color = pickup.type === 'health' ? [0.29, 0.87, 0.5] : [0.98, 0.78, 0.28];
      r.push(pickup.x, bobY, pickup.z, 0.22, 0.22, 0.22, color[0], color[1], color[2], now / 900);
    }

    this.effects.draw(r, this.particleQuality);
    r.flush();

    this.drawViewmodel(now);
    r.flush();

    this.updateHud(now);
  }

  /** Weapon viewmodel — a handful of boxes in camera space. */
  drawViewmodel(now) {
    const r = this.renderer;
    const { def, state } = this.currentWeapon;
    const p = this.player;

    r.beginViewmodel(48);

    const speed = Math.hypot(p.vx, p.vz);
    const sway = Math.sin(p.bob * 2) * 0.010 * Math.min(1, speed / 8);
    const bobY = Math.abs(Math.cos(p.bob * 2)) * 0.009 * Math.min(1, speed / 8);
    const reloading = isReloading(state, now);
    const reloadDip = reloading ? 0.14 : 0;
    const kick = Math.max(0, (this.muzzleFlashUntil ?? 0) - now) / 45;

    // Held well forward of the near plane. Closer than this and perspective
    // fans the weapon across the lower-right quadrant, eating the playfield.
    const bx = 0.22 + sway;
    const by = -0.23 - bobY - reloadDip;
    const bz = -0.95 + kick * 0.06;
    const tilt = reloading ? 0.45 : 0;
    const c = def.color;

    // Receiver, barrel, magazine, stock — four boxes read convincingly as a
    // weapon at this scale and cost nothing.
    r.pushView(bx, by, bz, 0.042, 0.052, 0.21, c[0] * 0.5, c[1] * 0.5, c[2] * 0.55, tilt);
    r.pushView(bx, by + 0.016, bz - 0.31, 0.018, 0.018, 0.12, c[0] * 0.8, c[1] * 0.8, c[2] * 0.85, tilt);
    r.pushView(bx, by - 0.082, bz + 0.04, 0.022, 0.042, 0.032, 0.15, 0.17, 0.24, tilt);
    r.pushView(bx, by - 0.006, bz + 0.24, 0.026, 0.034, 0.055, 0.14, 0.16, 0.22, tilt);

    if (def.id === 'shotgun') {
      // Under-barrel tube.
      r.pushView(bx, by - 0.034, bz - 0.27, 0.016, 0.016, 0.11, 0.42, 0.32, 0.24, tilt);
    } else if (def.id === 'railgun') {
      // Charge rail along the top.
      r.pushView(bx, by + 0.060, bz - 0.12, 0.012, 0.012, 0.19, 0.85, 0.65, 1.0, tilt);
    }

    if (kick > 0) {
      const f = kick;
      r.pushView(bx, by + 0.016, bz - 0.45, 0.05 * f, 0.05 * f, 0.05 * f, 1.0 * f, 0.85 * f, 0.4 * f);
    }
  }

  updateHud(now) {
    const { def, state } = this.currentWeapon;
    const reloading = isReloading(state, now);
    const p = this.player;
    const moving = Math.hypot(p.vx, p.vz) > 2.5;
    const spread = (def.spread + (moving ? def.moveSpread : 0)) * 900 + 4;

    this.hud.update({
      score: this.mode.score,
      highScore: this.highScore,
      modeName: getMode(this.mode.modeId).name,
      roundLabel: getMode(this.mode.modeId).id === 'survival' ? `ROUND ${this.mode.round}` : `${this.mode.kills} KILLS`,
      timeLeftMs: this.mode.timeLeftMs,
      health: p.health,
      weaponName: def.name,
      ammo: state.ammo,
      reserve: state.reserve,
      reloading,
      reloadProgress: reloading ? 1 - (state.reloadingUntil - now) / def.reloadMs : null,
      crosshairSpread: spread,
      streak: this.mode.streak,
      showFps: this.settings.showFps,
      fps: this.fps,
      instances: this.renderer.drawnInstances,
      quality: this.activeQuality,
    });
  }
}

export { DIFFICULTY, WEAPONS, playerBox };
