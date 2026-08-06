#!/usr/bin/env node
// Thinking Break — static checks that catch the two mistakes most likely to
// break the GitHub Pages deployment:
//
//   1. A root-absolute asset path (`/fps/...`), which resolves correctly on a
//      local server at `/` and 404s under `/thinkingbreak/`.
//   2. A leftover reference to the project this was migrated from.
//
// Also verifies that every local file an HTML page references actually exists.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.github']);
const BASE_URL = 'https://doringber.github.io/thinkingbreak/';

const problems = [];
const fail = (file, message) => problems.push(`${relative(ROOT, file)}: ${message}`);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const text = files.filter((f) => /\.(html|css|js|mjs|json|webmanifest|md|sh|ts)$/.test(f));

// ── 1. Stale references to the source project ───────────────────────────────
//
// Naming the project this was adapted from is *required* attribution, so
// comments and the attribution documents are allowed to do it. What must not
// survive is a stale reference in live code: an identifier, a URL, a path, or
// user-facing text.
const ATTRIBUTION_OK = new Set([
  join(ROOT, 'MIGRATION.md'),
  join(ROOT, 'LICENSE'),
  join(ROOT, 'README.md'),
  join(ROOT, 'tools', 'verify-paths.js'), // this file names them by definition
]);

const STALE = [
  { pattern: /pango[-\s]?snack/i, what: 'the old product name' },
  { pattern: /pangoSnack/, what: 'the old settings namespace' },
  { pattern: /Doringber\/creativity/i, what: 'the old repository' },
  { pattern: /doringber\.github\.io\/creativity/i, what: 'the old Pages URL' },
  { pattern: /amplifyapp\.com/i, what: 'the old hosting URL' },
];

/**
 * Blank out comment lines so only live code is scanned. Deliberately does not
 * strip trailing `//` — that would also swallow the `https://` in a URL
 * literal, which is exactly the kind of stale reference this check is for.
 */
function stripComments(body, file) {
  const blockCommented = /\.(js|mjs|ts|css)$/.test(file);
  let inBlock = false;
  return body.split('\n').map((line) => {
    const trimmed = line.trim();
    if (blockCommented) {
      const opens = trimmed.includes('/*');
      const closes = trimmed.includes('*/');
      if (inBlock) {
        const wasInBlock = true;
        if (closes) inBlock = false;
        return wasInBlock ? '' : line;
      }
      if (opens && !closes) { inBlock = true; return ''; }
      if (opens && closes) return '';
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
    }
    if (/\.(sh|py)$/.test(file) && trimmed.startsWith('#')) return '';
    if (/\.(html|md)$/.test(file) && (trimmed.startsWith('<!--') || trimmed.startsWith('#'))) return '';
    return line;
  });
}

for (const file of text) {
  if (ATTRIBUTION_OK.has(file)) continue;
  // Generated copies of extensions/shared — checked at their real source.
  if (/extensions[\\/][^\\/]+[\\/]src[\\/]shared[\\/]/.test(file)) continue;

  const lines = stripComments(readFileSync(file, 'utf8'), file);
  lines.forEach((line, index) => {
    for (const { pattern, what } of STALE) {
      if (pattern.test(line)) {
        fail(file, `line ${index + 1} still references ${what} in live code: ${line.trim().slice(0, 90)}`);
      }
    }
  });
}

// ── 2. Root-absolute local paths in HTML ────────────────────────────────────
const ATTR = /(?:src|href)\s*=\s*["']([^"']+)["']/g;

for (const file of files.filter((f) => f.endsWith('.html'))) {
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(ATTR)) {
    const url = match[1].trim();
    if (!url || url.startsWith('#') || url.startsWith('data:') || url.startsWith('mailto:')) continue;
    if (/^[a-z]+:\/\//i.test(url)) continue; // absolute external URL

    if (url.startsWith('/')) {
      fail(file, `root-absolute path "${url}" breaks under the /thinkingbreak/ base path`);
      continue;
    }

    // Resolve the reference and confirm the file is really there.
    const [path] = url.split(/[?#]/);
    if (!path) continue;
    const target = resolve(dirname(file), path);
    const candidates = [target, join(target, 'index.html')];
    if (!candidates.some((c) => existsSync(c) && statSync(c).isFile())) {
      fail(file, `references "${url}", which does not exist`);
    }
  }
}

// ── 3. url(...) in CSS ──────────────────────────────────────────────────────
for (const file of files.filter((f) => f.endsWith('.css'))) {
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const url = match[1].trim();
    if (url.startsWith('data:') || /^[a-z]+:\/\//i.test(url)) continue;
    if (url.startsWith('/')) fail(file, `root-absolute CSS url("${url}")`);
  }
}

// ── 4. ES module specifiers must be relative ────────────────────────────────
for (const file of files.filter((f) => f.startsWith(join(ROOT, 'fps')) && f.endsWith('.js'))) {
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec.startsWith('.')) continue;
    fail(file, `bare module specifier "${spec}" will not resolve in a browser without a bundler`);
  }
}

// ── 5. The deployment URL is consistent everywhere it appears ───────────────
const URL_FILES = ['index.html', 'install.sh', 'install-terminal.sh', 'uninstall.sh', 'README.md'];
for (const name of URL_FILES) {
  const file = join(ROOT, name);
  if (!existsSync(file)) continue;
  const body = readFileSync(file, 'utf8');
  const urls = body.match(/https:\/\/doringber\.github\.io\/[^\s"'`)<]+/gi) ?? [];
  for (const url of urls) {
    if (!url.toLowerCase().startsWith(BASE_URL)) {
      fail(file, `Pages URL "${url}" is not under ${BASE_URL}`);
    }
  }
}

// ── 6. Required files exist ─────────────────────────────────────────────────
for (const required of [
  '.nojekyll', 'index.html', 'fps/index.html', 'fps/src/main.js',
  'assets/favicon.svg', 'install.sh', 'uninstall.sh', 'LICENSE', 'README.md',
]) {
  if (!existsSync(join(ROOT, required))) problems.push(`missing required file: ${required}`);
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} path/branding problem(s):\n`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`✓ paths and branding verified across ${text.length} files`);
