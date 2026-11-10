import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, dirname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/**
 * Real-browser test harness. Chromium is the only dependency of the test
 * path; linkedom cannot emulate focus, activeElement or layout.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function findChrome() {
  if (process.env.HF_CHROME) return process.env.HF_CHROME;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  
  const candidates = [];
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('chromium')) continue;
    for (const bin of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = join(cache, entry, bin);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  return candidates[0] ?? null;
}

function serve(root) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = normalize(join(root, urlPath));
    if (!target.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const stats = await stat(target);
      const file = stats.isDirectory() ? join(target, 'index.html') : target;
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

/**
 * Loads playwright-core lazily. It is the only test dependency, and a plain
 * `node --test tests/*.test.mjs` on a machine without `npm ci` must still run
 * every other suite instead of dying at import time.
 */
async function loadChromium() {
  try {
    return (await import('playwright-core')).chromium;
  } catch {
    return null;
  }
}

export async function withPage(fn) {
  const chromium = await loadChromium();
  const executablePath = chromium ? findChrome() : null;
  if (!chromium) {
    const { skip } = await import('node:test');
    skip('playwright-core is not installed (npm ci)');
    return;
  }
  if (!executablePath) {
    const { skip } = await import('node:test');
    skip('no Chromium found; set HF_CHROME or run `npx playwright install chromium`');
    return;
  }
  const server = await serve(ROOT);
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/tests/fixture.html`);
  await page.waitForFunction(() => window.__hfReady === true);

  try {
    await fn({ page, port, errors, base: `http://127.0.0.1:${port}` });
  } finally {
    await browser.close();
    server.close();
  }
}
