#!/usr/bin/env node
// Thinking Break — write the multiplayer configuration on the way to a deploy.
//
// Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment (repository
// secrets in CI) and substitutes them into fps/src/multiplayer/supabaseConfig.js
// so no key has to be committed.
//
// Why a script rather than `sed`: the anon key is a JWT full of `/`, `.` and
// `+`, which is exactly the input that turns a sed one-liner into a corrupted
// file or a shell-quoting bug. A literal string replacement cannot misread it.
//
// Missing values are not an error — they leave multiplayer switched off, which
// is the right state for a fork that has not set the secrets.
//
//   node tools/inject-supabase-config.js
//   node tools/inject-supabase-config.js --check   # verify only, write nothing

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGET = join(ROOT, 'fps/src/multiplayer/supabaseConfig.js');
const checkOnly = process.argv.includes('--check');

const url = (process.env.SUPABASE_URL ?? '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY ?? '').trim();

/**
 * The `role` claim of a Supabase JWT, or null if the value is not a JWT (the
 * newer `sb_publishable_…`/`sb_secret_…` keys are opaque, not JWTs).
 *
 * A JWT payload is base64, not encrypted — reading it needs no secret, which is
 * the entire reason a `service_role` key is unsafe to publish.
 */
function jwtRole(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Refuse anything that grants more than a browser should have. Today's incident
 * is the reason this exists: the publishable and secret keys sit next to each
 * other in the dashboard, one click apart, and shipping the wrong one publishes
 * full admin access to the project. Better a failed deploy than that.
 */
function rejectSecretKey(key) {
  if (!key) return null;
  if (key.startsWith('sb_secret_')) {
    return 'SUPABASE_ANON_KEY is a secret key (`sb_secret_…`).';
  }
  const role = jwtRole(key);
  if (role && role !== 'anon') {
    return `SUPABASE_ANON_KEY is a "${role}" JWT, not an "anon" one.`;
  }
  return null;
}

const problem = rejectSecretKey(anonKey);
if (problem) {
  console.error(`✗ ${problem}`);
  console.error('');
  console.error('  That key bypasses Row Level Security, and this file is served');
  console.error('  as plain text to every visitor — publishing it would hand full');
  console.error('  admin access to the project to anyone who views source.');
  console.error('');
  console.error('  Use the publishable key (`sb_publishable_…`) or the legacy');
  console.error('  anonymous JWT (`role: anon`) from Project Settings → API Keys,');
  console.error('  and rotate the key that was set here.');
  process.exit(1);
}

if (!url || !anonKey) {
  console.log('• SUPABASE_URL / SUPABASE_ANON_KEY not set — multiplayer stays off');
  console.log('  (single-player is unaffected; the panel says so and nothing breaks)');
  process.exit(0);
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|red)\/?$/i.test(url)) {
  console.error(`✗ SUPABASE_URL does not look like a Supabase project URL: ${url}`);
  console.error('  Expected something like https://yourproject.supabase.co');
  process.exit(1);
}

const source = readFileSync(TARGET, 'utf8');
const substitutions = [
  ['__SUPABASE_URL__', url.replace(/\/$/, '')],
  ['__SUPABASE_ANON_KEY__', anonKey],
];

let out = source;
for (const [placeholder, value] of substitutions) {
  if (!out.includes(placeholder)) {
    console.error(`✗ ${placeholder} is missing from supabaseConfig.js`);
    console.error('  The file and this script have drifted apart; deploying would');
    console.error('  silently ship a build with multiplayer switched off.');
    process.exit(1);
  }
  out = out.replaceAll(placeholder, value);
}

if (checkOnly) {
  console.log('✓ placeholders present and the key is browser-safe (nothing written)');
  process.exit(0);
}

writeFileSync(TARGET, out);
// Never print the key itself — CI logs are readable by anyone who can see the
// run, and a masked secret pasted into stdout defeats the masking.
const host = new URL(url).host;
console.log(`✓ multiplayer configured for ${host} (${anonKey.length}-char ${jwtRole(anonKey) ?? 'publishable'} key)`);
