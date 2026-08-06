// Thinking Break — pooled visual effects.
//
// Every particle, tracer and decal comes from a fixed-size ring buffer that is
// allocated once at startup. Nothing is created or discarded during play, so
// sustained automatic fire produces zero garbage and no GC hitches.

const PARTICLE_POOL = 320;
const TRACER_POOL = 48;
const DECAL_POOL = 64;

export function createEffects() {
  const particles = Array.from({ length: PARTICLE_POOL }, () => ({
    active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    life: 0, maxLife: 1, size: 0.05, r: 1, g: 1, b: 1, gravity: 1,
  }));
  const tracers = Array.from({ length: TRACER_POOL }, () => ({
    active: false, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0,
    life: 0, maxLife: 0.08, r: 1, g: 1, b: 1, width: 0.02,
  }));
  const decals = Array.from({ length: DECAL_POOL }, () => ({
    active: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, life: 0, maxLife: 6,
  }));

  let pIdx = 0, tIdx = 0, dIdx = 0;

  const nextParticle = () => { const p = particles[pIdx]; pIdx = (pIdx + 1) % PARTICLE_POOL; return p; };
  const nextTracer = () => { const t = tracers[tIdx]; tIdx = (tIdx + 1) % TRACER_POOL; return t; };
  const nextDecal = () => { const d = decals[dIdx]; dIdx = (dIdx + 1) % DECAL_POOL; return d; };

  return {
    particles, tracers, decals,

    spawnImpact(x, y, z, nx, ny, nz, color = [0.85, 0.85, 0.95], count = 5) {
      for (let i = 0; i < count; i++) {
        const p = nextParticle();
        p.active = true;
        p.x = x; p.y = y; p.z = z;
        const spread = 2.6;
        p.vx = nx * 2.4 + (Math.random() - 0.5) * spread;
        p.vy = ny * 2.4 + (Math.random() - 0.5) * spread + 1.2;
        p.vz = nz * 2.4 + (Math.random() - 0.5) * spread;
        p.life = p.maxLife = 0.28 + Math.random() * 0.2;
        p.size = 0.028 + Math.random() * 0.03;
        p.r = color[0]; p.g = color[1]; p.b = color[2];
        p.gravity = 1;
      }
      const d = nextDecal();
      d.active = true;
      d.x = x + nx * 0.012; d.y = y + ny * 0.012; d.z = z + nz * 0.012;
      d.nx = nx; d.ny = ny; d.nz = nz;
      d.life = d.maxLife;
    },

    spawnBlood(x, y, z, color = [0.95, 0.32, 0.42], count = 8) {
      for (let i = 0; i < count; i++) {
        const p = nextParticle();
        p.active = true;
        p.x = x; p.y = y; p.z = z;
        p.vx = (Math.random() - 0.5) * 4;
        p.vy = Math.random() * 3.4;
        p.vz = (Math.random() - 0.5) * 4;
        p.life = p.maxLife = 0.35 + Math.random() * 0.25;
        p.size = 0.04 + Math.random() * 0.04;
        p.r = color[0]; p.g = color[1]; p.b = color[2];
        p.gravity = 1.4;
      }
    },

    spawnBurst(x, y, z, color, count = 18) {
      for (let i = 0; i < count; i++) {
        const p = nextParticle();
        p.active = true;
        p.x = x; p.y = y; p.z = z;
        const a = Math.random() * Math.PI * 2;
        const s = 3 + Math.random() * 5;
        p.vx = Math.cos(a) * s;
        p.vy = Math.random() * 6;
        p.vz = Math.sin(a) * s;
        p.life = p.maxLife = 0.5 + Math.random() * 0.35;
        p.size = 0.06 + Math.random() * 0.06;
        p.r = color[0]; p.g = color[1]; p.b = color[2];
        p.gravity = 1.1;
      }
    },

    spawnTracer(x1, y1, z1, x2, y2, z2, color = [1, 0.92, 0.6], width = 0.018, life = 0.07) {
      const t = nextTracer();
      t.active = true;
      t.x1 = x1; t.y1 = y1; t.z1 = z1;
      t.x2 = x2; t.y2 = y2; t.z2 = z2;
      t.life = t.maxLife = life;
      t.r = color[0]; t.g = color[1]; t.b = color[2];
      t.width = width;
    },

    update(dt) {
      for (const p of particles) {
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) { p.active = false; continue; }
        p.vy -= 14 * p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < 0.02) { p.y = 0.02; p.vy *= -0.28; p.vx *= 0.7; p.vz *= 0.7; }
      }
      for (const t of tracers) {
        if (!t.active) continue;
        t.life -= dt;
        if (t.life <= 0) t.active = false;
      }
      for (const d of decals) {
        if (!d.active) continue;
        d.life -= dt;
        if (d.life <= 0) d.active = false;
      }
    },

    /** Drop every live effect — used when a round restarts. */
    clear() {
      for (const p of particles) p.active = false;
      for (const t of tracers) t.active = false;
      for (const d of decals) d.active = false;
    },

    /** Queue everything into the renderer. Tracers become thin stretched boxes. */
    draw(renderer, quality) {
      const particleBudget = quality === 'low' ? 90 : quality === 'medium' ? 200 : PARTICLE_POOL;
      let drawn = 0;
      for (const p of particles) {
        if (!p.active) continue;
        if (drawn++ >= particleBudget) break;
        const fade = p.life / p.maxLife;
        const s = p.size * (0.35 + fade * 0.65);
        renderer.push(p.x, p.y, p.z, s, s, s, p.r * fade, p.g * fade, p.b * fade);
      }
      for (const t of tracers) {
        if (!t.active) continue;
        const cx = (t.x1 + t.x2) / 2, cy = (t.y1 + t.y2) / 2, cz = (t.z1 + t.z2) / 2;
        const dx = t.x2 - t.x1, dy = t.y2 - t.y1, dz = t.z2 - t.z1;
        const len = Math.hypot(dx, dy, dz);
        if (len < 0.01) continue;
        // A yaw-only box cannot follow an arbitrary 3D direction, so the tracer
        // is drawn as a horizontal sliver aligned in XZ with vertical span
        // covering the shot — close enough at the speed it flickers past.
        const yaw = Math.atan2(dx, dz);
        const fade = t.life / t.maxLife;
        renderer.push(
          cx, cy, cz,
          t.width, Math.max(t.width, Math.abs(dy) / 2), len / 2,
          t.r * fade, t.g * fade, t.b * fade,
          yaw
        );
      }
      if (quality !== 'low') {
        for (const d of decals) {
          if (!d.active) continue;
          const fade = Math.min(1, d.life / 1.5);
          const thin = 0.012;
          renderer.push(
            d.x, d.y, d.z,
            d.nx !== 0 ? thin : 0.09,
            d.ny !== 0 ? thin : 0.09,
            d.nz !== 0 ? thin : 0.09,
            0.06 * fade, 0.06 * fade, 0.09 * fade
          );
        }
      }
    },
  };
}
