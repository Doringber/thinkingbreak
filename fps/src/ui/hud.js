// Thinking Break — HUD and overlay wiring.
//
// The HUD is plain DOM on top of the canvas: text, bars and the crosshair cost
// nothing on the GPU there, and the browser only repaints the elements that
// actually changed. Every setter short-circuits on an unchanged value so a
// 240 Hz loop does not thrash layout.

const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    root: $('hud'),
    score: $('hud-score'),
    highScore: $('hud-high'),
    mode: $('hud-mode'),
    round: $('hud-round'),
    timer: $('hud-timer'),
    healthFill: $('health-fill'),
    healthValue: $('health-value'),
    weaponName: $('weapon-name'),
    ammo: $('ammo-current'),
    reserve: $('ammo-reserve'),
    reloadBar: $('reload-bar'),
    reloadFill: $('reload-fill'),
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    damageFlash: $('damage-flash'),
    banner: $('banner'),
    toast: $('toast'),
    agentStatus: $('agent-status'),
    agentStatusText: $('agent-status-text'),
    fps: $('fps-counter'),
    killfeed: $('killfeed'),
    streak: $('streak'),
  };

  const cache = new Map();
  const setText = (node, value) => {
    if (!node) return;
    const key = node.id;
    if (cache.get(key) === value) return;
    cache.set(key, value);
    node.textContent = value;
  };
  const setStyle = (node, prop, value) => {
    if (!node) return;
    const key = `${node.id}:${prop}`;
    if (cache.get(key) === value) return;
    cache.set(key, value);
    node.style.setProperty(prop, value);
  };

  let hitmarkerTimer = null;
  let bannerTimer = null;
  let toastTimer = null;
  let flashTimer = null;

  function formatTime(ms) {
    if (!Number.isFinite(ms)) return '∞';
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  }

  return {
    el,

    update(snapshot) {
      setText(el.score, String(snapshot.score));
      setText(el.highScore, `BEST ${snapshot.highScore}`);
      setText(el.mode, snapshot.modeName);
      setText(el.round, snapshot.roundLabel);
      setText(el.timer, formatTime(snapshot.timeLeftMs));
      setText(el.healthValue, String(Math.ceil(snapshot.health)));
      setStyle(el.healthFill, 'width', `${Math.max(0, Math.min(100, snapshot.health))}%`);
      setStyle(el.healthFill, 'background', snapshot.health > 60 ? 'var(--green)' : snapshot.health > 25 ? 'var(--yellow)' : 'var(--red)');
      setText(el.weaponName, snapshot.weaponName);
      setText(el.ammo, snapshot.reloading ? '--' : String(snapshot.ammo));
      setText(el.reserve, String(snapshot.reserve));
      setText(el.streak, snapshot.streak >= 2 ? `${snapshot.streak}× STREAK` : '');

      if (el.reloadBar) {
        const show = snapshot.reloadProgress !== null;
        setStyle(el.reloadBar, 'opacity', show ? '1' : '0');
        if (show) setStyle(el.reloadFill, 'width', `${Math.round(snapshot.reloadProgress * 100)}%`);
      }
      if (el.crosshair) {
        setStyle(el.crosshair, '--spread', `${snapshot.crosshairSpread.toFixed(1)}px`);
        setStyle(el.crosshair, 'opacity', snapshot.ammo === 0 && !snapshot.reloading ? '0.4' : '1');
      }
      if (el.fps) {
        setStyle(el.fps, 'display', snapshot.showFps ? 'block' : 'none');
        if (snapshot.showFps) setText(el.fps, `${snapshot.fps} FPS · ${snapshot.instances} obj · ${snapshot.quality}`);
      }
    },

    hitmarker(headshot) {
      if (!el.hitmarker) return;
      el.hitmarker.classList.remove('show', 'headshot');
      // Force a reflow so the animation restarts on rapid consecutive hits.
      void el.hitmarker.offsetWidth;
      el.hitmarker.classList.add('show');
      if (headshot) el.hitmarker.classList.add('headshot');
      clearTimeout(hitmarkerTimer);
      hitmarkerTimer = setTimeout(() => el.hitmarker.classList.remove('show', 'headshot'), 160);
    },

    damageFlash() {
      if (!el.damageFlash) return;
      el.damageFlash.classList.add('show');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => el.damageFlash.classList.remove('show'), 180);
    },

    banner(text, ms = 1400) {
      if (!el.banner || !text) return;
      el.banner.textContent = text;
      el.banner.classList.add('show');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => el.banner.classList.remove('show'), ms);
    },

    toast(text, ms = 1600) {
      if (!el.toast || !text) return;
      el.toast.textContent = text;
      el.toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
    },

    killfeed(text) {
      if (!el.killfeed) return;
      const line = document.createElement('div');
      line.className = 'killfeed-line';
      line.textContent = text;
      el.killfeed.prepend(line);
      while (el.killfeed.childElementCount > 4) el.killfeed.lastElementChild.remove();
      setTimeout(() => line.remove(), 3200);
    },

    /** The "Agent working" pill. `null` hides it. */
    agentStatus(state) {
      if (!el.agentStatus) return;
      if (state === null) {
        el.agentStatus.classList.remove('show', 'busy', 'idle');
        return;
      }
      el.agentStatus.classList.add('show');
      el.agentStatus.classList.toggle('busy', state === 'busy');
      el.agentStatus.classList.toggle('idle', state !== 'busy');
      setText(el.agentStatusText, state === 'busy' ? 'Agent working' : 'Agent idle — paused');
    },

    setVisible(visible) {
      el.root?.classList.toggle('hidden', !visible);
    },

    dispose() {
      clearTimeout(hitmarkerTimer);
      clearTimeout(bannerTimer);
      clearTimeout(toastTimer);
      clearTimeout(flashTimer);
    },
  };
}
