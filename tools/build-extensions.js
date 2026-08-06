#!/usr/bin/env node
// Thinking Break — compile the editor extensions.
//
// The three extensions share `extensions/shared/`. TypeScript's `rootDir`
// cannot span sibling directories cleanly, so the shared sources are synced
// into each extension's `src/shared/` (git-ignored) before `tsc` runs. That
// keeps one source of truth without a bundler.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT_ROOT = join(ROOT, 'extensions');
const SHARED = join(EXT_ROOT, 'shared');
const TARGETS = ['claude', 'cursor', 'codex'];

const args = new Set(process.argv.slice(2));
const syncOnly = args.has('--sync-only');

function syncShared(target) {
  const dest = join(EXT_ROOT, target, 'src', 'shared');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(SHARED)) {
    if (!file.endsWith('.ts')) continue;
    cpSync(join(SHARED, file), join(dest, file));
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status ?? 1;
}

let failures = 0;
for (const target of TARGETS) {
  const dir = join(EXT_ROOT, target);
  process.stdout.write(`\n▸ ${target}\n`);
  syncShared(target);
  if (syncOnly) continue;

  // `tsc` from the repo root's devDependencies; each extension declares it too
  // for standalone builds, but installing three copies here is wasteful.
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('  typescript is not installed — run `npm install` at the repo root first.');
    failures++;
    continue;
  }
  const status = run(tsc, ['-p', dir], ROOT);
  if (status !== 0) {
    console.error(`  ✗ ${target} failed to compile`);
    failures++;
  } else {
    console.log(`  ✓ ${target} compiled to extensions/${target}/out`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} extension(s) failed to build.`);
  process.exit(1);
}
console.log('\nAll extensions compiled.');
