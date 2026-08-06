#!/usr/bin/env node
// Thinking Break — build.
//
// The site itself needs no build: it is hand-written HTML/CSS and native ES
// modules, served as-is by GitHub Pages. "Building" therefore means verifying
// that what is already in the repo is deployable, and compiling the editor
// extensions.
//
//   node tools/build.js              full build
//   node tools/build.js --site-only  skip the extensions

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteOnly = process.argv.includes('--site-only');

function step(name, fn) {
  process.stdout.write(`▸ ${name}\n`);
  const ok = fn();
  if (!ok) {
    console.error(`✗ ${name} failed`);
    process.exit(1);
  }
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return result.status === 0;
}

step('verify paths and branding', () => run([join(ROOT, 'tools', 'verify-paths.js')]));

step('parse every game module', () => {
  // A syntax error in an ES module only surfaces when a browser loads it.
  // Importing them here turns that into a build failure instead.
  return true; // performed below, asynchronously
});

const MODULES = [
  'fps/src/core/math.js', 'fps/src/core/renderer.js', 'fps/src/core/input.js',
  'fps/src/core/audio.js', 'fps/src/core/storage.js',
  'fps/src/game/collision.js', 'fps/src/game/arena.js', 'fps/src/game/weapons.js',
  'fps/src/game/modes.js', 'fps/src/game/player.js', 'fps/src/game/bots.js',
  'fps/src/game/effects.js', 'fps/src/game/game.js',
  'fps/src/ui/hud.js', 'fps/src/ui/menu.js',
  'fps/src/lifecycle/agentState.js', 'fps/src/lifecycle/bridge.js',
  // game.js imports protocol.js statically, so it ships with every session;
  // it's pure logic with no SDK behind it, which is why it stays cheap.
  'fps/src/multiplayer/protocol.js',
];

// Only reached via a dynamic import() when a player opens the Multiplayer
// panel — single-player never fetches these, so they are parsed for syntax
// but excluded from the "always loaded" payload budget below.
const LAZY_MODULES = ['fps/src/multiplayer/connection.js', 'fps/src/multiplayer/firebaseConfig.js'];

for (const rel of [...MODULES, ...LAZY_MODULES]) {
  try {
    // `game.js` and the UI modules touch DOM/WebGL globals at call time only,
    // so importing them in Node is a genuine syntax and import-graph check.
    // connection.js's CDN imports are dynamic and only evaluated inside
    // joinRoom(), so importing the module itself needs no network access.
    await import(`file://${join(ROOT, rel)}`);
  } catch (err) {
    console.error(`✗ ${rel} failed to load: ${err.message}`);
    process.exit(1);
  }
}
console.log(`  ✓ ${MODULES.length + LAZY_MODULES.length} modules parse and resolve`);

step('report payload size', () => {
  const bytes = (rel) => {
    try { return statSync(join(ROOT, rel)).size; } catch { return 0; }
  };
  const js = MODULES.reduce((sum, rel) => sum + bytes(rel), 0) + bytes('fps/src/main.js');
  const lazyJs = LAZY_MODULES.reduce((sum, rel) => sum + bytes(rel), 0);
  const shell = bytes('fps/index.html') + bytes('fps/style.css');
  const total = js + shell + bytes('assets/favicon.svg');
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`  game JavaScript  ${kb(js)}`);
  console.log(`  html + css       ${kb(shell)}`);
  console.log(`  total game page  ${kb(total)} (uncompressed, no dependencies)`);
  console.log(`  + multiplayer    ${kb(lazyJs)} local, plus the Firebase SDK — fetched only on Join`);
  // A hard ceiling: the whole point of the hand-rolled renderer is that the
  // page stays small enough to open instantly.
  const LIMIT = 250 * 1024;
  if (total > LIMIT) {
    console.error(`  payload exceeds the ${kb(LIMIT)} budget`);
    return false;
  }
  return true;
});

step('check the game page loads its entry module', () => {
  const html = readFileSync(join(ROOT, 'fps/index.html'), 'utf8');
  if (!html.includes('type="module"') || !html.includes('./src/main.js')) {
    console.error('  fps/index.html does not load ./src/main.js as a module');
    return false;
  }
  return true;
});

if (!siteOnly) {
  step('compile the editor extensions', () => run([join(ROOT, 'tools', 'build-extensions.js')]));
}

console.log('\n✓ build complete');
