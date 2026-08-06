#!/usr/bin/env node
// Thinking Break — verify a deployed site with a real browser.
//
// A green `deploy-pages` only means files synced. It does not mean the page
// loads, the modules resolve under the base path, or the game actually boots.
// This drives a real Chromium at a URL and asserts all three, so a broken
// deployment fails loudly instead of sitting there looking fine.
//
//   node tools/verify-live.js                              # production
//   node tools/verify-live.js http://localhost:8080/thinkingbreak/
//   node tools/verify-live.js --browser /path/to/chrome
//
// Needs a Chromium and `playwright` (or `playwright-core`); neither is a
// runtime dependency of the game.

const DEFAULT_BASE = 'https://doringber.github.io/thinkingbreak/';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = (process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? DEFAULT_BASE).replace(/\/?$/, '/');
const executablePath = arg('browser') ?? process.env.CHROMIUM_PATH;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.error('Install a driver first:  npm i -D playwright  (then npx playwright install chromium)');
    process.exit(2);
  }
}

const failures = [];
const note = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

/** Collect console errors and failed subresource requests for one page. */
function watch(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

try {
  // ── Installation page ─────────────────────────────────────────────────────
  console.log(`\nInstallation page — ${base}`);
  const site = await context.newPage();
  const siteErrors = watch(site);
  const siteResp = await site.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });

  note(siteResp?.status() === 200, 'HTTP 200', `got ${siteResp?.status()}`);
  note(site.url().startsWith(base), 'no unexpected redirect', `landed on ${site.url()}`);
  note((await site.title()).includes('Thinking Break'), 'title mentions Thinking Break');
  note(await site.locator('a[href$="fps/"]').first().isVisible(), 'links to the game');
  note(siteErrors.length === 0, 'no console errors', siteErrors.slice(0, 4).join(' | '));

  // ── Game ──────────────────────────────────────────────────────────────────
  const gameUrl = `${base}fps/`;
  console.log(`\nGame — ${gameUrl}`);
  const game = await context.newPage();
  const gameErrors = watch(game);
  const gameResp = await game.goto(gameUrl, { waitUntil: 'networkidle', timeout: 60_000 });

  note(gameResp?.status() === 200, 'HTTP 200', `got ${gameResp?.status()}`);
  note(await game.locator('#scene').count() > 0, 'canvas is present');

  // Give the module graph time to load and the loop time to spin up.
  await game.waitForFunction(() => globalThis.thinkingBreak !== undefined, { timeout: 30_000 })
    .catch(() => {});
  await game.waitForTimeout(2500);

  const state = await game.evaluate(() => {
    const tb = globalThis.thinkingBreak;
    if (!tb) {
      return { booted: false, fatal: document.getElementById('fatal-message')?.textContent ?? null };
    }
    return {
      booted: true,
      running: tb.game.running,
      frames: tb.game.frameCount,
      instances: tb.game.renderer.drawnInstances,
      bots: tb.game.bots.length,
      agent: tb.bridge.machine.state,
    };
  });

  note(state.booted, 'game booted (ES modules resolved under the base path)', state.fatal ?? '');
  if (state.booted) {
    note(state.running, 'render loop running');
    note(state.frames > 30, 'frames are advancing', `${state.frames} frames`);
    note(state.instances > 20, 'world geometry is drawing', `${state.instances} instances`);
    note(state.bots > 0, 'bots spawned', `${state.bots} bots`);
    note(state.agent === 'busy', 'standalone visit boots straight into play', `agent=${state.agent}`);

    // Pause/resume across the lifecycle bridge, on the live build.
    await game.evaluate(() => globalThis.thinkingBreak.bridge.machine.handle('idle'));
    await game.waitForTimeout(1600);
    const paused = await game.evaluate(() => {
      const g = globalThis.thinkingBreak.game;
      return { running: g.running, rafCancelled: g.rafId === null, frames: g.frameCount };
    });
    note(!paused.running && paused.rafCancelled, 'agent idle pauses and cancels the render loop');

    await game.evaluate(() => globalThis.thinkingBreak.bridge.machine.handle('busy'));
    await game.waitForTimeout(900);
    const resumed = await game.evaluate(() => {
      const g = globalThis.thinkingBreak.game;
      return { running: g.running, frames: g.frameCount };
    });
    note(resumed.running && resumed.frames > paused.frames, 'agent busy resumes it');
  }
  note(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 4).join(' | '));
} catch (err) {
  failures.push(`navigation: ${err.message.split('\n')[0]}`);
  console.error(`  ✗ ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

console.log();
if (failures.length > 0) {
  console.error(`✗ ${failures.length} check(s) failed against ${base}`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
}
console.log(`✓ ${base} is live and the game runs`);
