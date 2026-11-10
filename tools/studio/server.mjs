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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { scanHtml } from '../scan/html.mjs';
import { createApi } from './api.mjs';
import { readSource, StudioError } from './discover.mjs';
import { planEdits } from './edit.mjs';
import { buildPageModel } from './model.mjs';

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

// A module script is deferred: putting it in <head> lets the browser start the
// fetch immediately instead of discovering it after the last body element,
// which on a slow link moved it to the end of the preview's request queue.
const BRIDGE_TAG = '<script type="module" src="/__studio/bridge.js"></script>';

/**
 * A module graph costs one round trip per depth level, and the preview graph
 * is four deep: page -> runtime -> foundation/index -> the twelve foundations.
 * On a 400 ms link that is 1.6 s of pure waiting before the first component
 * mounts. `modulepreload` names the whole graph up front so the browser
 * fetches it in one wave.
 *
 * Resolution is textual on purpose: the preview only loads local module
 * files, and a full parser would cost more than the round trips it saves.
 * Results are cached per file version, so a page render is not paying for
 * a graph walk every time.
 */
const MODULE_PRELOAD_LIMIT = 40;
const preloadCache = new Map();
/**
 * Dry-run previews, keyed by a per-request token.
 *
 * The studio cannot apply a structural edit (move/insert/delete) to a loaded
 * document, so it asks for a plan and loads the result instead. The bytes live
 * here for one render; the page URL, and therefore every relative path inside
 * it, stays the same as on disk.
 */
const previewCache = new Map();

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Static `import ... from '...'` and `import '...'` specifiers. */
function staticImports(code) {
  const found = [];
  const pattern = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(code)) !== null) found.push(match[1]);
  return found;
}

/** Only same-origin relative modules inside the project are followed. */
function resolveModule(fromPath, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const base = fromPath.split('/').slice(0, -1).join('/') || '/';
  const joined = specifier.startsWith('/') ? specifier : `${base}/${specifier}`;
  const parts = [];
  for (const piece of joined.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') parts.pop();
    else parts.push(piece);
  }
  return `/${parts.join('/')}`;
}

/**
 * Walks the module graph reachable from `entry` entries and returns the
 * modules worth preloading (everything except the entries themselves, which
 * the browser already knows about).
 */
async function collectModules(root, entries, read) {
  const seen = new Set();
  const queue = [];
  for (const entry of entries) {
    const path = resolveModule('/page.html', entry);
    if (path && !seen.has(path)) {
      seen.add(path);
      queue.push(path);
    }
  }
  const modules = [];
  const styles = [];
  while (queue.length && modules.length < MODULE_PRELOAD_LIMIT) {
    const path = queue.shift();
    let text;
    try {
      text = await read(root, path);
    } catch {
      continue;
    }
    if (text === null) continue;
    modules.push(path);
    const code = stripComments(text);
    // A component's `styles:` file is a stylesheet, not a module, so it needs
    // `rel=preload as=style` rather than `modulepreload`.
    for (const href of styleHints(code)) {
      const next = resolveModule(path, href);
      if (next && !seen.has(next)) {
        seen.add(next);
        styles.push(next);
      }
    }
    for (const specifier of staticImports(code)) {
      const next = resolveModule(path, specifier);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return { modules, styles };
}

/**
 * Adds `data-hf-node` to every element open tag, using exact source offsets.
 * `preloads` are module paths injected as `rel="modulepreload"` into `<head>`.
 */
export function instrumentHtml(source, { preloads = [], styles = [] } = {}) {
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

  if (preloads.length || styles.length) {
    const tags = [
      ...preloads.map((href) => `<link rel="modulepreload" href="${href}">`),
      ...styles.map((href) => `<link rel="preload" as="style" href="${href}">`),
    ].join('');
    const closeHead = out.lastIndexOf('</head>');
    if (closeHead !== -1) out = `${out.slice(0, closeHead)}${tags}\n${out.slice(closeHead)}`;
    else out = `${tags}\n${out}`;
  }

  const closeHead = out.lastIndexOf('</head>');
  if (closeHead !== -1) out = `${out.slice(0, closeHead)}${BRIDGE_TAG}\n${out.slice(closeHead)}`;
  else {
    const closeBody = out.lastIndexOf('</body>');
    if (closeBody !== -1) out = `${out.slice(0, closeBody)}${BRIDGE_TAG}\n${out.slice(closeBody)}`;
    else out += `\n${BRIDGE_TAG}\n`;
  }
  return { html: out, instrumented: true, problems: [] };
}



/**
 * Module specifiers the page itself loads: `<script type="module" src>` and
 * inline module imports. Only the first level is read here; the walker
 * expands the rest.
 */
function moduleEntries(html) {
  const entries = [];
  const tagPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const attrs = match[1];
    if (!/type\s*=\s*['"]module['"]/i.test(attrs)) continue;
    const src = attrs.match(/src\s*=\s*['"]([^'"]+)['"]/i);
    if (src) {
      entries.push(src[1]);
      continue;
    }
    for (const specifier of staticImports(stripComments(match[2]))) {
      entries.push(specifier);
    }
  }
  return entries;
}

/** `styles: './x.css'` in a component definition is fetched at runtime, long
 * after the module graph is parsed. Naming it up front makes it part of the
 * same wave. */
function styleHints(code) {
  const found = [];
  const pattern = /styles\s*:\s*['"]([^'"]+\.css)['"]/g;
  let match;
  while ((match = pattern.exec(code)) !== null) found.push(match[1]);
  return found;
}

/** Caches the walk per (root, page version): a save changes `version`. */
async function preloadsFor(root, entries, version) {
  if (!entries.length) return { modules: [], styles: [] };
  const key = `${root}\0${version}\0${entries.join(',')}`;
  const cached = preloadCache.get(key);
  if (cached) return cached;
  const read = async (projectRoot, path) => {
    try {
      return (await readSource(projectRoot, path.slice(1))).text;
    } catch {
      return null;
    }
  };
  const preloads = await collectModules(root, entries, read);
  if (preloadCache.size > 64) preloadCache.clear();
  preloadCache.set(key, preloads);
  return preloads;
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

/**
 * Transport for every response the studio generates.
 *
 * Two things dominated load time before this existed:
 * - nothing was compressed, so `/__api/page` (174 KiB) crossed the wire whole
 * - everything carried `no-store`, so a reload re-downloaded all of it
 *
 * Brotli at quality 5 costs ~0.9 ms on the largest payload and lands within
 * 13% of quality 11 (which costs 90 ms), so it is the default for text.
 */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;
const MIN_COMPRESS = 1024;

/** Cheap validator: a body hash. The API responses are deterministic. */
function etagOf(buffer) {
  return `"${createHash('sha1').update(buffer).digest('base64url').slice(0, 20)}"`;
}

function acceptsEncoding(header, encoding) {
  if (!header) return false;
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if (name !== encoding && name !== '*') return false;
    const q = params.find((p) => p.trim().startsWith('q='));
    return !q || Number(q.split('=')[1]) > 0;
  });
}

/**
 * Sends `body` with compression, a validator and a cache policy.
 *
 * `cache: 'revalidate'` means the browser may keep the body but must confirm
 * it with an `If-None-Match` request; `etag` is then answered with a 304 that
 * carries no body at all. That keeps an editor honest (a save invalidates the
 * model) without paying the download again on every reload.
 */
function send(req, res, status, body, { type, cache = 'revalidate', extra = {}, maxAge = 0 } = {}) {
  let buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = { 'Content-Type': type, Vary: 'Accept-Encoding', ...extra };

  if (cache === 'no-store') headers['Cache-Control'] = 'no-store';
  else if (maxAge > 0) headers['Cache-Control'] = `private, max-age=${maxAge}, must-revalidate`;
  else headers['Cache-Control'] = 'no-cache';

  const compressible = COMPRESSIBLE.test(type) && buffer.length >= MIN_COMPRESS;
  if (compressible) {
    const etag = etagOf(buffer);
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      delete headers['Content-Type'];
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const accept = req.headers['accept-encoding'];
    if (acceptsEncoding(accept, 'br')) {
      buffer = brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
      headers['Content-Encoding'] = 'br';
    } else if (acceptsEncoding(accept, 'gzip')) {
      buffer = gzipSync(buffer, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
    }
  } else if (status === 200 && buffer.length) {
    // Small or binary bodies still get a validator so repeat loads are 304s.
    const etag = etagOf(buffer);
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      delete headers['Content-Type'];
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }

  headers['Content-Length'] = buffer.length;
  res.writeHead(status, headers);
  res.end(buffer);
}

function json(req, res, status, body, options = {}) {
  send(req, res, status, JSON.stringify(body), {
    type: 'application/json; charset=utf-8',
    ...options,
  });
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
        json(req, res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'a valid ?token= is required' });
        return;
      }
    }

    try {
      // --- studio UI assets
      if (path === '/__studio' || path === '/__studio/') {
        let body = await readFile(join(STUDIO_DIR, 'index.html'));
        // Inline the inventory the shell would otherwise fetch right after
        // parsing. The scan is cheap (one directory walk) and it removes a
        // round trip from the critical path of every cold start.
        try {
          const { status, body: inventory } = await api.handle('project', {});
          if (status === 200) {
            const boot = JSON.stringify(inventory).replace(/</g, '\\u003c');
            body = Buffer.from(
              String(body).replace(
                '</head>',
                `<script type="application/json" id="hf-boot">${boot}</script>\n</head>`,
              ),
              'utf8',
            );
          }
        } catch {
          // Falls back to the JSON API: the shell still boots.
        }
        const extra = {};
        // The shell is loaded with ?token=..., but its own script, stylesheet
        // and preview iframe cannot carry a query. Hand them a cookie once the
        // URL proved the token, so the editor is usable over a LAN bind.
        if (state.token && url.searchParams.get('token')) {
          extra['Set-Cookie'] = `${TOKEN_COOKIE}=${encodeURIComponent(state.token)}; Path=/; SameSite=Strict; HttpOnly`;
        }
        send(req, res, 200, body, { type: MIME['.html'], extra });
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
          // Studio assets change only when the tool itself is edited, and the
          // ETag proves it. A short private max-age skips even the
          // revalidation round trip on a reload while still picking up a local
          // edit within a minute.
          send(req, res, 200, body, {
            type: MIME[extname(file)] ?? 'application/octet-stream',
            maxAge: 60,
          });
        } catch {
          res.writeHead(404).end('not found');
        }
        return;
      }

      // --- live preview for structural edits
      //
      // Declaration, attribute and text edits can be applied to the loaded
      // document in place, but the studio never re-parses HTML: a move, insert
      // or delete has no CSSOM equivalent. Instead the pending ops are applied
      // to an in-memory copy and served back as a real page, so the preview
      // shows the result before anything is written. Nothing touches disk.
      if (path === '/__api/preview' && req.method === 'POST') {
        const body = await readBody(req);
        const file = String(body.file ?? '').replace(/^\/+/, '');
        const ops = Array.isArray(body.ops) ? body.ops : [];
        let html;
        try {
          const { files } = await planEdits(state.root, ops);
          const entry = files.get(file) ?? files.values().next().value;
          if (!entry) throw new StudioError('BAD_OP', 'the plan produced no files');
          html = entry.after;
        } catch (error) {
          json(req, res, 400, {
            ok: false,
            code: error instanceof StudioError ? error.code : 'INTERNAL',
            message: String(error?.message ?? error),
          });
          return;
        }
        const entries = moduleEntries(html);
        const { modules, styles } = await preloadsFor(state.root, entries, `${file}:${createHash('sha1').update(html).digest('base64url')}`);
        const preview = instrumentHtml(html, { preloads: modules, styles });
        // Served back at the page's own path so relative links, module URLs and
        // fetch() keep resolving exactly as they do on the real page.
        const key = randomBytes(9).toString('base64url');
        if (previewCache.size > 32) previewCache.clear();
        previewCache.set(key, { rel: file, html: preview.html, at: Date.now() });
        // The tree must describe the same document as the preview, otherwise a
        // moved element stays under its old parent in the sidebar.
        let model = null;
        try {
          model = await buildPageModel(state.root, file, { text: html });
        } catch {
          /* the preview is still usable without a refreshed tree */
        }
        json(req, res, 200, {
          ok: true,
          url: `/${file}?hf-preview=${key}`,
          model,
          instrumented: preview.instrumented,
        });
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
          json(req, res, status, body);
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const { status, body: result } = await api.handle(action, { body });
          json(req, res, status, result);
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
      // Project files are re-read from disk on every request, so the ETag
      // follows the file: an edited file gets a new hash and a 200, an
      // untouched one gets a body-less 304.
      // A dry-run document requested by the preview (`?hf-preview=…`): the
      // bytes come from the cache, not from disk, and are not written back.
      const previewKey = url.searchParams.get('hf-preview');
      if (previewKey && rel.endsWith('.html')) {
        const entry = previewCache.get(previewKey);
        if (entry && entry.rel === rel) {
          send(req, res, 200, entry.html, {
            type: MIME['.html'],
            // Never store a speculative document: the next plan has a new key.
            extra: { 'Cache-Control': 'no-store' },
          });
          return;
        }
      }

      if (rel.endsWith('.html')) {
        const entries = moduleEntries(source.text);
        const { modules, styles } = await preloadsFor(state.root, entries, source.version);
        const preview = instrumentHtml(source.text, { preloads: modules, styles });
        send(req, res, 200, preview.html, { type: MIME['.html'] });
        return;
      }
      send(req, res, 200, source.text, {
        type: MIME[extname(rel)] ?? 'application/octet-stream',
      });
    } catch (error) {
      if (error instanceof StudioError) {
        json(req, res, 400, { ok: false, code: error.code, message: error.message });
        return;
      }
      json(req, res, 500, { ok: false, code: 'INTERNAL', message: String(error?.message ?? error) });
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
