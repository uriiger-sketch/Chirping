// Shared Playwright harness: a throw-away static server for the repo, Playwright resolution that
// works with or without `npm install`, and deterministic networking (third-party hosts aborted,
// GBIF / iNaturalist answered from fixtures when a test supplies them).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav' };

export async function startServer(root = ROOT) {
  const server = createServer(async (req, res) => {
    try {
      const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
      const file = join(root, p || 'index.html');
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) };
}

export async function loadPlaywright() {
  const tries = ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/node-tools/node_modules/playwright/index.mjs', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) {
    try { return await import(t.startsWith('/') ? pathToFileURL(t).href : t); } catch { /* next */ }
  }
  throw new Error('Playwright not found — run `npm install` or set PLAYWRIGHT_PATH');
}

export function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

// Block everything off-origin except what `mocks` answers ({ hostSubstring: (url) => json }).
export async function routeNetwork(page, origin, mocks = {}) {
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    for (const [host, fn] of Object.entries(mocks)) if (u.includes(host)) {
      const body = fn(u); return body === null ? route.abort() : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.abort();
  });
}

// Open the app with the synthesiser (and optionally the legacy v3.2 classifier) injected.
export async function openApp(browser, { legacy = false, mocks = {}, contextOptions = {} } = {}) {
  const srv = await startServer();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await routeNetwork(page, srv.url, mocks);
  await page.goto(srv.url + 'index.html', { waitUntil: 'load' });
  await page.addScriptTag({ url: srv.url + 'tests/lib/synth.js' });
  if (legacy) await page.addScriptTag({ url: srv.url + 'tests/lib/legacy.js' });
  return { page, context, errors, srv, close: async () => { await context.close(); await srv.close(); } };
}
