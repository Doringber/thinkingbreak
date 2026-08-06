#!/usr/bin/env node
// Thinking Break — regenerate the README screenshots.
//
// Requires a Chromium and `playwright-core`, neither of which is a project
// dependency — this is a maintenance script, not part of the build.
//
//   npm i -D playwright-core
//   npm run serve &
//   node tools/screenshots.js [--browser /path/to/chrome]
//
// Positions the player at a scripted vantage point rather than wherever the
// simulation happens to be, so the images are reproducible.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'docs', 'screenshots');
const BASE = process.env.TB_BASE_URL ?? 'http://localhost:8080/thinkingbreak';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run: npm i -D playwright-core');
  process.exit(1);
}

const executablePath = arg('browser', process.env.CHROMIUM_PATH);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

// ── Gameplay ────────────────────────────────────────────────────────────────
const game = await context.newPage();
await game.goto(`${BASE}/fps/`, { waitUntil: 'networkidle' });
await game.waitForTimeout(900);

await game.evaluate(async () => {
  const g = globalThis.thinkingBreak.game;
  // High quality for the still, regardless of what auto picked on this machine.
  g.autoQuality = false;
  g.applyQuality('high');

  // Stand on the north high deck looking south down the arena: it puts the
  // elevation change, the cover blocks and the pillars all in one frame.
  g.player.x = -3; g.player.y = 7 + 1.8; g.player.z = -12.6;
  g.player.yaw = Math.PI; g.player.pitch = -0.22;
  g.player.vx = g.player.vy = g.player.vz = 0;

  const spots = [[-2, 2], [7, -1], [-9, 7]];
  g.bots.forEach((bot, i) => {
    const [x, z] = spots[i % spots.length];
    bot.x = x; bot.y = 0.9; bot.z = z; bot.alive = true; bot.health = bot.maxHealth;
    bot.yaw = 2.2;
  });

  // Fire once so the HUD shows a live state rather than a pristine one.
  g.input.state.pointerLocked = true;
  g.mode.score = 1480;
  g.mode.round = 4;
  g.currentWeapon.state.ammo = 23;
  await new Promise((r) => setTimeout(r, 400));
});
await game.waitForTimeout(700);
await game.screenshot({ path: join(OUT, 'gameplay.png') });
console.log('wrote docs/screenshots/gameplay.png');

// ── Installation page ───────────────────────────────────────────────────────
const site = await context.newPage();
await site.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await site.waitForTimeout(500);
await site.setViewportSize({ width: 1280, height: 900 });
await site.screenshot({ path: join(OUT, 'install-page.png') });
console.log('wrote docs/screenshots/install-page.png');

await browser.close();
