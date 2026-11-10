/**
 * Studio server: static project serving + JSON API + preview instrumentation.
 *
 * Preview instrumentation (served copy only — never written to disk):
 * - every element gets `data-hf-node="<path id>"` so clicks map to source nodes
 * - `/__studio/bridge.js` is injected before `</body>`
 *
 * Binding:
 * - default `127.0.0.1` (loopback only)
 * - `--host 0.0.0.0` exposes it on the network for LAN/device testing. There is
 *   no user system, so a network bind requires a token: every request must
 *   carry `?token=` (set once, then the studio keeps it in the URL).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanHtml } from '../scan/html.mjs';
import { createApi } from './api.mjs';
import { readSource, StudioError } from './discover.mjs';

const STUDIO_DIR = fileURLToPath(new URL('../../studio/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const BRIDGE_TAG = '<script type="module" src="/__studio/bridge.js"></script>';

/** Adds `data-hf-node` to every element open tag, using exact source offsets. */
export function instrumentHtml(source) {
  const tree = scanHtml(source);
  if (tree.problems.length) return { html: source, instrumented: false, problems: tree.problems };
  const edits = [];
  for (const node of tree.nodes) {
    if (node.tag === '#document' || node.tag === 'html' || node.tag === 'head' || node.tag === 'body') continue;
    if (node.attrs.some((entry) => entry.name === 'data-hf-node')) continue;
    // Self-closing tags: insert before the `/`, and eat its leading space so
    // `<meta ... />` stays `<meta ... data-hf-node="…" />`.
    const tagEnd = node.open.end - 1; // index of '>'
    const text = ` data-hf-node="${node.id}"`;
    if (node.selfClosing) {
      const slash = source.lastIndexOf('/', tagEnd);
      const insertAt = slash > node.open.start ? slash : tagEnd;
      const spaced = source[insertAt - 1] === ' ';
      edits.push({ start: insertAt, end: insertAt, text: spaced ? `${text.slice(1)} ` : `${text} ` });
    } else {
      edits.push({ start: tagEnd, end: tagEnd, text });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);

  const closeBody = out.lastIndexOf('</body>');
  if (closeBody !== -1) out = `${out.slice(0, closeBody)}${BRIDGE_TAG}\n${out.slice(closeBody)}`;
  else out += `\n${BRIDGE_TAG}\n`;
  return { html: out, instrumented: true, problems: [] };
}



/**
 * The folder picker's reachable roots.
 *
 * Home is always included: "open a project" means "find it on my machine".
 * The project is added separately rather than by widening to its parent,
 * because the parent of a checkout in `/srv/app` would be all of `/srv`, and
 * the parent of `/tmp/x` would be all of `/tmp`.
 */
export function browseRootsFor(configured, projectRoot) {
  const roots = [];
  const add = (dir) => {
    const resolved = resolve(dir);
    // A root nested in another adds nothing: containment already covers it.
    if (roots.some((existing) => resolved === existing || resolved.startsWith(existing + sep))) return;
    // Drop roots that the new one now covers.
    for (let i = roots.length - 1; i >= 0; i -= 1) {
      if (roots[i].startsWith(resolved + sep)) roots.splice(i, 1);
    }
    roots.push(resolved);
  };

  if (configured) {
    add(configured);
    if (projectRoot) add(projectRoot);
    return roots;
  }
  add(homedir());
  if (projectRoot) add(projectRoot);
  return roots;
}

/* ------------------------------------------------------------------ host */

/** Loopback check: `localhost`, `127.0.0.1`, `::1` never leave the machine. */
export function isLoopback(host) {
  const value = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '0:0:0:0:0:0:0:1';
}

/** Every non-internal IPv4 address, so the CLI can print a LAN URL. */
export function lanAddresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out;
}

/**
 * Compares a request token without leaking length or content through timing.
 * Returns false for an absent/malformed token rather than throwing.
 */
export function tokenMatches(expected, provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reads a cookie value from a request. The studio sets one after the URL token
 * checks out, so its own subresources (`/__studio/panel.js`, stylesheets, the
 * preview iframe) authenticate without the token being appended to every URL.
 */
export function cookieValue(header, name) {
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/** Cookie name for the studio session token. */
export const TOKEN_COOKIE = 'hf_token';

/**
 * A token is required whenever the bind is reachable from another machine.
 * Generating one instead of refusing keeps `--host 0.0.0.0` a single flag, but
 * the user has to be told what it is, or they cannot open the studio.
 */
export function resolveToken(host, requested) {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (isLoopback(host)) return null;
  return randomBytes(16).toString('hex');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new StudioError('TOO_LARGE', 'request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new StudioError('BAD_JSON', 'request body is not valid JSON');
  }
}

function safeStatic(base, urlPath) {
  // `base` may carry a trailing slash (fileURLToPath of a directory URL);
  // normalize first or `base + sep` becomes a double separator and every
  // asset looks like an escape.
  const root = normalize(base).replace(/[\\/]+$/, '');
  const target = normalize(join(root, urlPath));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * Forwards a request to the project's own backend (Flask, Express, …).
 * The preview must behave like the real app: a page that fetches `/api/…`
 * gets a JSON 404 from the static server otherwise, and its UI renders an
 * error instead of the thing the user came to restyle.
 */
async function proxyRequest(req, res, target, pathname, search) {
  const origin = new URL(target);
  const url = new URL(pathname + search, origin);
  const headers = { ...req.headers, host: origin.host };
  delete headers.connection;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: 'manual',
    });
  } catch (error) {
    res
      .writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(`proxy failed: ${url.origin}${url.pathname} (${error.message})`);
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders = {};
  for (const [name, value] of upstream.headers) {
    if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') continue;
    responseHeaders[name] = value;
  }
  res.writeHead(upstream.status, { ...responseHeaders, 'Content-Length': body.length });
  res.end(body);
}

/**
 * @param {{root: string, port?: number, host?: string, quiet?: boolean, proxy?: string,
 *          token?: string|null, browseRoot?: string|null}} options
 *
 * `browseRoot` is the highest directory the folder picker may reach (a single
 * path, or a list). It defaults to the user's home directory, plus the
 * project itself when the project lives elsewhere - a project checked out in
 * `/srv` or `/tmp` must stay reachable without making all of `/` browsable.
 */
export async function startStudio({
  root,
  port = 4174,
  host = '127.0.0.1',
  quiet = false,
  proxy = null,
  token = null,
  browseRoot = null,
}) {
  // The project root is switchable at runtime, so it lives in one mutable
  // state object instead of being captured by every helper.
  const projectRoot = resolve(root);
  const state = {
    root: projectRoot,
    // Roots are compared for containment, so they are absolute and unique.
    browseRoots: browseRootsFor(browseRoot, projectRoot),
    token: resolveToken(host, token),
    host,
  };
  const api = createApi(() => state.root, { browseRoots: () => state.browseRoots, state });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const path = decodeURIComponent(url.pathname);

    // A network bind is unauthenticated by design only for loopback. The token
    // is checked before any routing so no handler can leak a file listing.
    if (state.token) {
      const provided =
        url.searchParams.get('token') ??
        req.headers['x-hf-token'] ??
        cookieValue(req.headers.cookie, TOKEN_COOKIE);
      if (!tokenMatches(state.token, provided)) {
        json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'a valid ?token= is required' });
        return;
      }
    }

    try {
      // --- studio UI assets
      if (path === '/__studio' || path === '/__studio/') {
        const body = await readFile(join(STUDIO_DIR, 'index.html'));
        const headers = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' };
        // The shell is loaded with ?token=..., but its own script, stylesheet
        // and preview iframe cannot carry a query. Hand them a cookie once the
        // URL proved the token, so the editor is usable over a LAN bind.
        if (state.token && url.searchParams.get('token')) {
          headers['Set-Cookie'] = `${TOKEN_COOKIE}=${encodeURIComponent(state.token)}; Path=/; SameSite=Strict; HttpOnly`;
        }
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      if (path.startsWith('/__studio/')) {
        const file = safeStatic(STUDIO_DIR, path.slice('/__studio/'.length));
        if (!file) {
          res.writeHead(403).end();
          return;
        }
        try {
          const body = await readFile(file);
          res.writeHead(200, {
            'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch {
          res.writeHead(404).end('not found');
        }
        return;
      }

      // --- API
      if (path.startsWith('/__api/')) {
        const action = path.slice('/__api/'.length).replace(/\/$/, '');
        if (req.method === 'GET') {
          const query = Object.fromEntries(url.searchParams);
          // The token is a transport concern, not an argument.
          delete query.token;
          const { status, body } = await api.handle(action, { query });
          json(res, status, body);
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const { status, body: result } = await api.handle(action, { body });
          json(res, status, result);
          return;
        }
        res.writeHead(405).end();
        return;
      }

      // --- project files
      const rel = path.replace(/^\/+/, '');
      if (!rel) {
        res.writeHead(302, { Location: '/__studio' }).end();
        return;
      }
      let source;
      try {
        source = await readSource(state.root, rel);
      } catch (error) {
        // A project that also runs an API server keeps those routes working:
        // the studio serves files, the backend serves data.
        if (proxy && error?.code === 'MISSING') {
          await proxyRequest(req, res, proxy, path, url.search);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`404 ${path}`);
        return;
      }
      if (rel.endsWith('.html')) {
        const preview = instrumentHtml(source.text);
        const body = Buffer.from(preview.html, 'utf8');
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      const body = Buffer.from(source.text, 'utf8');
      res.writeHead(200, {
        'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      if (error instanceof StudioError) {
        json(res, 400, { ok: false, code: error.code, message: error.message });
        return;
      }
      json(res, 500, { ok: false, code: 'INTERNAL', message: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address().port;
  const query = state.token ? `?token=${state.token}` : '';
  if (!quiet) {
    console.log(`\x1b[32m✓\x1b[0m studio http://${host}:${actual}/__studio${query}`);
    if (!isLoopback(host)) {
      for (const address of lanAddresses()) {
        console.log(`\x1b[2m· lan\x1b[0m http://${address}:${actual}/__studio${query}`);
      }
      if (state.token) console.log(`\x1b[2m· token required on every request\x1b[0m`);
    }
    if (proxy) console.log(`\x1b[2m· proxy ${proxy}\x1b[0m`);
    console.log(`\x1b[36m·\x1b[0m project ${state.root}`);
    console.log(`\x1b[36m·\x1b[0m browse ${state.browseRoots.join(', ')}`);
  }

  return {
    port: actual,
    host,
    token: state.token,
    get root() {
      return state.root;
    },
    url: `http://${host}:${actual}/__studio${query}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    server,
  };
}

export { existsSync, stat };
