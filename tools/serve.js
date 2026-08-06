#!/usr/bin/env node
// Thinking Break — zero-dependency static server for local development.
//
// Serves the repository root under a configurable base path so local URLs
// match production exactly. GitHub Pages hosts this project at
// /thinkingbreak/, and the default here mirrors that, which is how base-path
// mistakes get caught before they ship.
//
//   node tools/serve.js                 → http://localhost:8080/thinkingbreak/
//   node tools/serve.js --base / --port 3000

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT ?? 8080));
const RAW_BASE = arg('base', '/thinkingbreak/');
const BASE = RAW_BASE.endsWith('/') ? RAW_BASE : `${RAW_BASE}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (BASE !== '/') {
    if (pathname === BASE.slice(0, -1)) {
      res.writeHead(302, { Location: BASE });
      res.end();
      return;
    }
    if (!pathname.startsWith(BASE)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found. The site is served from ${BASE}`);
      return;
    }
    pathname = `/${pathname.slice(BASE.length)}`;
  }

  // Reject anything that escapes the repo root after normalization.
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(ROOT, relative);
  if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 — ${pathname}`);
  }
});

server.listen(PORT, () => {
  console.log(`Thinking Break dev server`);
  console.log(`  site  http://localhost:${PORT}${BASE}`);
  console.log(`  game  http://localhost:${PORT}${BASE}fps/`);
  console.log(`  test  http://localhost:${PORT}${BASE}fps/?embed=1&debug=1`);
});
