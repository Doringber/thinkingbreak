// Thinking Break — minimal math helpers.
// Only what the renderer and physics actually need; no general-purpose library.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;

/** Deterministic PRNG (mulberry32) so bot spawns can be replayed in tests. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mat4Perspective(out, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4Multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * View matrix for a yaw/pitch FPS camera at `eye`.
 * Yaw rotates around +Y (0 = looking down -Z), pitch around the local X axis.
 */
export function mat4View(out, eye, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // Camera basis in world space.
  const rx = cy, ry = 0, rz = -sy;              // right
  const ux = sy * sp, uy = cp, uz = cy * sp;    // up
  const fx = -sy * cp, fy = sp, fz = -cy * cp;  // forward (camera -Z)

  // Rows of R^T, then -R^T * eye.
  out[0] = rx; out[4] = ry; out[8] = rz;
  out[1] = ux; out[5] = uy; out[9] = uz;
  out[2] = -fx; out[6] = -fy; out[10] = -fz;
  out[3] = 0; out[7] = 0; out[11] = 0;
  out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  out[15] = 1;
  return out;
}

/** Unit forward vector for a yaw/pitch pair (matches mat4View). */
export function forwardFrom(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/** Extract the 6 world-space frustum planes from a view-projection matrix. */
export function frustumFromViewProj(m, out = new Float32Array(24)) {
  const set = (i, a, b, c, d) => {
    const inv = 1 / (Math.hypot(a, b, c) || 1);
    out[i] = a * inv; out[i + 1] = b * inv; out[i + 2] = c * inv; out[i + 3] = d * inv;
  };
  set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);   // left
  set(4, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);   // right
  set(8, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);   // bottom
  set(12, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);  // top
  set(16, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]); // near
  set(20, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]); // far
  return out;
}

/** Conservative sphere-vs-frustum test used for per-box culling. */
export function sphereInFrustum(planes, x, y, z, radius) {
  for (let i = 0; i < 24; i += 4) {
    if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -radius) {
      return false;
    }
  }
  return true;
}
