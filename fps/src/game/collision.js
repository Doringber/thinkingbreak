// Thinking Break — axis-aligned collision + raycasting.
// Pure functions with no DOM/WebGL dependency so they can be unit-tested in Node.

/**
 * A "box" here is `{ x, y, z, hx, hy, hz }` — centre plus half-extents.
 * The arena is built entirely from these, which keeps every query a few
 * comparisons instead of a mesh traversal.
 */
export function makeBox(x, y, z, hx, hy, hz, extra = {}) {
  return { x, y, z, hx, hy, hz, ...extra };
}

/** Build a box from min/max corners — friendlier when laying out an arena. */
export function boxFromBounds(minX, minY, minZ, maxX, maxY, maxZ, extra = {}) {
  return makeBox(
    (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
    (maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2,
    extra
  );
}

export function overlaps(a, b) {
  return (
    Math.abs(a.x - b.x) < a.hx + b.hx &&
    Math.abs(a.y - b.y) < a.hy + b.hy &&
    Math.abs(a.z - b.z) < a.hz + b.hz
  );
}

const SKIN = 1e-4;   // gap left between resolved surfaces
const EPS = 1e-9;

const halfOn = (box, axis) => (axis === 'x' ? box.hx : axis === 'y' ? box.hy : box.hz);
const halfKey = (axis) => (axis === 'x' ? 'hx' : axis === 'y' ? 'hy' : 'hz');

/**
 * Move an AABB along one axis and stop it at the first thing in the way.
 *
 * The test is against the *swept* volume, not just the destination: a fast
 * fall or a slide can cover more ground in one frame than a thin step is deep,
 * and a destination-only test would let the body tunnel straight through.
 *
 * Resolving one axis at a time is what makes wall-sliding feel right and keeps
 * the player from catching on the seams between adjacent arena blocks.
 *
 * @returns {{ value: number, hit: boolean }} corrected centre on that axis.
 */
export function sweepAxis(body, axis, delta, solids) {
  const half = halfOn(body, axis);
  const start = body[axis];
  if (delta === 0) return { value: start, hit: false };

  let value = start + delta;
  let hit = false;

  // Box covering the whole path travelled this step.
  const swept = { ...body, [axis]: (start + value) / 2 };
  swept[halfKey(axis)] = half + Math.abs(delta) / 2;

  const bodyMin = start - half;
  const bodyMax = start + half;

  for (const solid of solids) {
    if (!overlaps(swept, solid)) continue;

    const solidHalf = halfOn(solid, axis);
    const solidMin = solid[axis] - solidHalf;
    const solidMax = solid[axis] + solidHalf;
    // Already interpenetrating at the start of the step — push out rather than
    // treating it as a clean stop, so a body nudged into geometry escapes.
    const penetrating = bodyMin < solidMax - EPS && bodyMax > solidMin + EPS;

    if (delta > 0) {
      // Skip anything already behind the leading face; only what lies ahead
      // can block. Without this, resting on a surface would block a jump.
      if (!penetrating && solidMin < bodyMax - EPS) continue;
      const stop = solidMin - half - SKIN;
      if (stop < value) { value = stop; hit = true; }
    } else {
      if (!penetrating && solidMax > bodyMin + EPS) continue;
      const stop = solidMax + half + SKIN;
      if (stop > value) { value = stop; hit = true; }
    }
  }
  return { value, hit };
}

/**
 * Slab test: ray vs AABB.
 * @returns {number|null} distance along the ray, or null when there is no hit.
 */
export function rayBox(ox, oy, oz, dx, dy, dz, box, maxDist = Infinity) {
  let tmin = 0;
  let tmax = maxDist;

  const axis = (o, d, c, h) => {
    const lo = c - h, hi = c + h;
    if (Math.abs(d) < 1e-8) return o >= lo && o <= hi;
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };

  if (!axis(ox, dx, box.x, box.hx)) return null;
  if (!axis(oy, dy, box.y, box.hy)) return null;
  if (!axis(oz, dz, box.z, box.hz)) return null;
  return tmin <= tmax ? tmin : null;
}

/** Which face of `box` a hit at (px,py,pz) landed on — used for impact decals. */
export function boxNormalAt(box, px, py, pz) {
  const dx = (px - box.x) / box.hx;
  const dy = (py - box.y) / box.hy;
  const dz = (pz - box.z) / box.hz;
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (ax >= ay && ax >= az) return [Math.sign(dx), 0, 0];
  if (ay >= az) return [0, Math.sign(dy), 0];
  return [0, 0, Math.sign(dz)];
}

/** Nearest solid along a ray. Returns `{ dist, box }` or null. */
export function raycastSolids(ox, oy, oz, dx, dy, dz, solids, maxDist = 200) {
  let best = null;
  for (const box of solids) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, box, maxDist);
    if (t !== null && (best === null || t < best.dist)) best = { dist: t, box };
  }
  return best;
}

/** True when nothing solid blocks the straight line between two points. */
export function hasLineOfSight(ax, ay, az, bx, by, bz, solids) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const hit = raycastSolids(ax, ay, az, dx / dist, dy / dist, dz / dist, solids, dist);
  return hit === null || hit.dist >= dist - 1e-3;
}
