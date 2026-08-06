// Thinking Break — "Cache Line", the single compact arena.
//
// Everything is an axis-aligned box, which buys three things at once: the whole
// map is a few hundred bytes of data (no model download), collision is a slab
// test, and the renderer can draw it in one instanced call.
//
// Layout, 48 x 48 units, roughly:
//
//        -Z (north)
//     +--------------------+
//     |  RAMP    HIGH DECK |     high deck   y = 7
//     |     \_____________ |     mid ledges  y = 3.5
//     |  [ ]   PIT   [ ]   |     floor       y = 0
//     |  CORRIDOR  ___ [ ] |
//     +--------------------+
//        +Z (south)

import { boxFromBounds, makeBox } from './collision.js';

export const ARENA_HALF = 24;
export const ARENA_NAME = 'Cache Line';

/** Palette — shared so the renderer only ever uploads a handful of colours. */
export const ZONE = {
  floor: [0.17, 0.19, 0.27],
  floorAlt: [0.22, 0.24, 0.35],
  wall: [0.21, 0.24, 0.35],
  deck: [0.26, 0.31, 0.46],
  ramp: [0.31, 0.38, 0.58],
  cover: [0.36, 0.26, 0.50],
  accent: [0.30, 0.40, 0.96],
  jumpPad: [0.29, 0.87, 0.50],
  hazard: [0.95, 0.36, 0.48],
};

function wall(minX, minZ, maxX, maxZ, height, color) {
  return boxFromBounds(minX, 0, minZ, maxX, height, maxZ, { color });
}

/**
 * Build the arena. Returns plain data so tests can inspect it without a canvas.
 */
export function buildArena() {
  const solids = [];
  const H = ARENA_HALF;

  // ── Ground ────────────────────────────────────────────────────────────────
  // The floor is a thin slab rather than an infinite plane so the same
  // raycast/collision code handles it with no special case.
  solids.push(boxFromBounds(-H, -2, -H, H, 0, H, { color: ZONE.floor, kind: 'floor' }));

  // Contrasting inlay marks the central duel space — a purely visual zone cue.
  solids.push(boxFromBounds(-8, -0.02, -8, 8, 0.02, 8, { color: ZONE.floorAlt, kind: 'floor' }));

  // ── Perimeter ─────────────────────────────────────────────────────────────
  const WALL_H = 12;
  solids.push(wall(-H - 2, -H - 2, H + 2, -H, WALL_H, ZONE.wall));
  solids.push(wall(-H - 2, H, H + 2, H + 2, WALL_H, ZONE.wall));
  solids.push(wall(-H - 2, -H, -H, H, WALL_H, ZONE.wall));
  solids.push(wall(H, -H, H + 2, H, WALL_H, ZONE.wall));

  // ── High deck (north) with a ramp up from the west ────────────────────────
  solids.push(boxFromBounds(-16, 6.5, -22, 16, 7, -12, { color: ZONE.deck, kind: 'deck' }));
  // Deck lip so players can peek without falling off instantly.
  solids.push(boxFromBounds(-16, 7, -12.6, 16, 7.9, -12, { color: ZONE.accent }));

  // Ramp: a staircase of shallow steps. Stepping beats a rotated plane here —
  // it stays axis-aligned, so it costs nothing extra in collision.
  for (let i = 0; i < 14; i++) {
    const y = (i + 1) * 0.5;
    const z = -12 + i * 0.75;
    solids.push(boxFromBounds(-22, y - 0.5, z - 0.75, -16.5, y, z, { color: ZONE.ramp, kind: 'ramp' }));
  }

  // ── Mid ledges (east) reachable by jump pad ───────────────────────────────
  solids.push(boxFromBounds(12, 3.2, -4, 22, 3.5, 8, { color: ZONE.deck, kind: 'deck' }));
  solids.push(boxFromBounds(12, 3.5, -4.6, 22, 4.4, -4, { color: ZONE.accent }));

  // ── Corridor (south-west), tight and roofed ───────────────────────────────
  solids.push(wall(-22, 10, -6, 11.2, 5, ZONE.wall));
  solids.push(wall(-22, 16, -6, 17.2, 5, ZONE.wall));
  solids.push(boxFromBounds(-22, 4.6, 11.2, -6, 5, 16, { color: ZONE.deck })); // roof

  // ── Cover blocks — the actual gunfight geometry ───────────────────────────
  const cover = [
    [-6, -6, 2.0, 1.6, 2.0], [6, -6, 2.0, 1.6, 2.0],
    [-6, 6, 2.0, 1.1, 2.0], [6, 6, 2.0, 1.1, 2.0],
    // Split into two flanking blocks rather than one across the middle. A
    // single crate at (0, 10) sat squarely between `playerSpawn` (0, 18) and
    // the arena, so a player who had not moved yet could not see anything and
    // nothing could see them.
    [0, -14, 3.0, 2.2, 1.2], [-4.2, 11, 1.5, 1.4, 1.5], [4.2, 11, 1.5, 1.4, 1.5],
    [-15, 0, 1.2, 2.6, 4.0], [15, 0, 1.2, 2.6, 4.0],
    [10, 18, 2.4, 1.8, 2.4], [-10, 19, 2.4, 1.8, 2.4],
    [18, -14, 2.6, 3.0, 2.6],
  ];
  for (const [x, z, hx, hy, hz] of cover) {
    solids.push(makeBox(x, hy, z, hx, hy, hz, { color: ZONE.cover, kind: 'cover' }));
  }

  // Two pillars flanking the centre, tall enough to break long sightlines.
  solids.push(makeBox(-3.5, 4, 0, 0.6, 4, 0.6, { color: ZONE.accent, kind: 'cover' }));
  solids.push(makeBox(3.5, 4, 0, 0.6, 4, 0.6, { color: ZONE.accent, kind: 'cover' }));

  // ── Jump pads ─────────────────────────────────────────────────────────────
  // Kept clear of `playerSpawn` — spawning on a pad would launch the player
  // before they had touched the mouse.
  const jumpPads = [
    { x: 17, z: 14, hx: 1.6, hz: 1.6, power: 16 },  // → east ledge
    { x: -17, z: -4, hx: 1.6, hz: 1.6, power: 19 }, // → high deck
    { x: -9, z: 20, hx: 1.6, hz: 1.6, power: 14 },  // → centre lob
  ].map((p) => ({ ...p, y: 0.12 }));
  for (const p of jumpPads) {
    solids.push(makeBox(p.x, 0.06, p.z, p.hx, 0.06, p.hz, { color: ZONE.jumpPad, kind: 'pad', solid: false }));
  }

  // ── Pickups ───────────────────────────────────────────────────────────────
  const pickupSpots = [
    { x: -18, z: 18, type: 'health' },
    { x: 18, z: -18, type: 'health' },
    { x: 0, z: 0, type: 'health' },
    { x: -18, z: -18, type: 'ammo' },
    { x: 18, z: 18, type: 'ammo' },
    { x: 0, z: -17, type: 'ammo' },
    { x: 17, z: 2, type: 'ammo', y: 4.6 },
    { x: 0, z: -16, type: 'health', y: 8.1 },
  ];

  // ── Spawns ────────────────────────────────────────────────────────────────
  // `y` is the ground level at that point; actors offset upward by their own
  // height, so the same list works for the player and for bots.
  // yaw 0 looks down -Z, i.e. straight into the arena.
  const playerSpawn = { x: 0, y: 0, z: 18, yaw: 0 };
  const spawnPoints = [
    { x: -18, y: 0, z: 0 }, { x: 18, y: 0, z: 0 },
    { x: -12, y: 0, z: -18 }, { x: 12, y: 0, z: -18 },
    { x: -14, y: 0, z: 14 }, { x: 14, y: 0, z: 14 },
    { x: 0, y: 7, z: -17 }, { x: 17, y: 3.5, z: 2 },
    { x: -20, y: 0, z: 13.5 },
  ];

  return {
    name: ARENA_NAME,
    half: ARENA_HALF,
    solids: solids.filter((b) => b.solid !== false),
    decorations: solids.filter((b) => b.solid === false),
    jumpPads,
    pickupSpots: pickupSpots.map((p) => ({ y: 0.8, ...p })),
    playerSpawn,
    spawnPoints,
    /** Y below which anything is considered to have fallen out of the world. */
    killFloor: -6,
  };
}

/**
 * Pick a spawn far from `avoid` (normally the player) and not already crowded.
 * @param {object[]} [occupied] Points to stay away from — other live actors.
 */
export function pickSpawn(arena, avoid, rng, occupied = []) {
  let best = arena.spawnPoints[0];
  let bestScore = -Infinity;
  for (const sp of arena.spawnPoints) {
    let score = Math.hypot(sp.x - avoid.x, sp.z - avoid.z) + rng() * 6;
    for (const other of occupied) {
      // Heavy penalty for stacking spawns, so a wave never appears as one blob.
      if (Math.hypot(sp.x - other.x, sp.z - other.z) < 4) score -= 60;
    }
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  return best;
}
