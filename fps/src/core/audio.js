// Thinking Break — fully synthesised audio.
//
// Every sound is generated with Web Audio primitives, so there are no audio
// files to download and nothing to license. The whole graph hangs off one gain
// node that gets ramped to zero and the context suspended when the agent
// finishes, which is what keeps a paused tab off the CPU.

const NOISE_SECONDS = 0.5;

export function createAudio({ volume = 0.6, enabled = true } = {}) {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let settings = { volume, enabled };
  let suspended = false;

  function ensure() {
    if (!settings.enabled) return null;
    if (ctx) return ctx;
    const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      ctx = new AudioCtor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);

    // One shared noise buffer for every impact/shot — allocating per shot would
    // churn the GC during sustained automatic fire.
    const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  const now = () => (ctx ? ctx.currentTime : 0);

  function env(node, t, attack, decay, peak) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(master);
    return g;
  }

  function noise(t, { duration = 0.12, peak = 0.3, filterType = 'bandpass', freq = 1200, q = 1 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, t);
    filter.Q.value = q;
    src.connect(filter);
    env(filter, t, 0.004, duration, peak);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  function tone(t, { freq = 440, endFreq = null, duration = 0.1, peak = 0.2, type = 'square' } = {}) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + duration);
    env(osc, t, 0.005, duration, peak);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  const api = {
    get enabled() { return settings.enabled; },
    get contextState() { return ctx?.state ?? 'none'; },

    /** Must be called from a user gesture the first time. */
    resume() {
      const c = ensure();
      if (!c) return;
      suspended = false;
      if (c.state === 'suspended') c.resume().catch(() => {});
      if (master) master.gain.setTargetAtTime(settings.volume, c.currentTime, 0.02);
    },

    /** Ramp to silence, then suspend so the audio thread stops entirely. */
    suspend() {
      if (!ctx || suspended) return;
      suspended = true;
      try {
        master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02);
        setTimeout(() => {
          if (suspended && ctx?.state === 'running') ctx.suspend().catch(() => {});
        }, 120);
      } catch { /* context already closed */ }
    },

    setVolume(v) {
      settings.volume = Math.max(0, Math.min(1, v));
      if (master && !suspended) master.gain.value = settings.volume;
    },

    setEnabled(on) {
      settings.enabled = !!on;
      if (!settings.enabled) api.suspend();
      else api.resume();
    },

    shot(weapon) {
      if (!ensure() || suspended) return;
      const t = now();
      const pitch = weapon?.pitch ?? 420;
      if (weapon?.id === 'shotgun') {
        noise(t, { duration: 0.22, peak: 0.42, filterType: 'lowpass', freq: 900 });
        tone(t, { freq: 150, endFreq: 45, duration: 0.18, peak: 0.28, type: 'sawtooth' });
      } else if (weapon?.id === 'railgun') {
        tone(t, { freq: 1400, endFreq: 220, duration: 0.35, peak: 0.24, type: 'sine' });
        noise(t, { duration: 0.3, peak: 0.16, filterType: 'highpass', freq: 2600 });
      } else {
        noise(t, { duration: 0.07, peak: 0.3, filterType: 'bandpass', freq: 1800, q: 0.8 });
        tone(t, { freq: pitch, endFreq: pitch * 0.35, duration: 0.06, peak: 0.16, type: 'square' });
      }
    },

    hit(headshot = false) {
      if (!ensure() || suspended) return;
      const t = now();
      tone(t, { freq: headshot ? 1500 : 900, endFreq: headshot ? 2400 : 1200, duration: 0.06, peak: 0.16, type: 'triangle' });
    },

    kill() {
      if (!ensure() || suspended) return;
      const t = now();
      tone(t, { freq: 520, endFreq: 900, duration: 0.1, peak: 0.18, type: 'square' });
      tone(t + 0.08, { freq: 780, endFreq: 1300, duration: 0.12, peak: 0.15, type: 'square' });
    },

    hurt() {
      if (!ensure() || suspended) return;
      const t = now();
      noise(t, { duration: 0.18, peak: 0.3, filterType: 'lowpass', freq: 420 });
      tone(t, { freq: 210, endFreq: 90, duration: 0.16, peak: 0.16, type: 'sawtooth' });
    },

    reload() {
      if (!ensure() || suspended) return;
      const t = now();
      noise(t, { duration: 0.05, peak: 0.2, filterType: 'bandpass', freq: 700 });
      noise(t + 0.2, { duration: 0.05, peak: 0.22, filterType: 'bandpass', freq: 1100 });
    },

    empty() {
      if (!ensure() || suspended) return;
      noise(now(), { duration: 0.04, peak: 0.14, filterType: 'highpass', freq: 3000 });
    },

    pickup() {
      if (!ensure() || suspended) return;
      const t = now();
      tone(t, { freq: 660, endFreq: 990, duration: 0.09, peak: 0.14, type: 'sine' });
    },

    jumpPad() {
      if (!ensure() || suspended) return;
      tone(now(), { freq: 300, endFreq: 1200, duration: 0.22, peak: 0.14, type: 'sine' });
    },

    gameOver() {
      if (!ensure() || suspended) return;
      const t = now();
      tone(t, { freq: 420, endFreq: 120, duration: 0.6, peak: 0.2, type: 'sawtooth' });
    },

    dispose() {
      try { ctx?.close(); } catch { /* already closed */ }
      ctx = null; master = null; noiseBuffer = null;
    },
  };

  return api;
}
