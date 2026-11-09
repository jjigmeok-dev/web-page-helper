/**
 * Project discovery: classify the files the studio may edit.
 *
 * Scope is fixed to the project root (no `--root`), so every path is
 * validated against that root and a conservative deny-list.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Never read, never write. */
export const DENY_DIRS = new Set([
  'node_modules', '.git', '.hf', 'dist', 'build', 'coverage', '.next', '.cache',
]);

/**
 * Directories that hold tooling or fixtures rather than the app the user
 * edits. `vendor`/`examples` are common in real projects and would otherwise
 * flood the page picker with files nobody wants to edit.
 */
const NON_PAGE_DIRS = new Set([
  'studio', 'tests', 'test', '__tests__', 'spec', 'docs', 'examples',
  'example', 'fixtures', 'vendor', 'third_party', 'tools', 'scripts',
]);

const ASSET_EXT = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm',
]);

const SCRIPT_EXT = new Set(['.js', '.mjs']);

const IGNORED_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

export class StudioError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.detail = detail;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export function hashOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Normalizes a client-supplied relative path and rejects escapes. */
export function safeRelPath(root, input) {
  if (typeof input !== 'string' || !input) {
    throw new StudioError('BAD_PATH', 'a file path is required');
  }
  if (input.includes('\0')) throw new StudioError('BAD_PATH', 'path contains a NUL byte');
  if (input.startsWith('/') || input.startsWith('\\')) {
    throw new StudioError('BAD_PATH', `paths must be project-relative: ${input}`);
  }
  const normalized = posix.normalize(input.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized === '' || /^[a-zA-Z]:/.test(normalized)) {
    throw new StudioError('OUT_OF_ROOT', `path is outside the project: ${input}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => DENY_DIRS.has(part))) {
    throw new StudioError('DENY_PATH', `path is not editable: ${normalized}`);
  }
  // `root` may be relative ('.' when the CLI is run from the project); resolve
  // it before the containment check or every path looks like an escape.
  const base = resolve(root);
  const absolute = resolve(base, normalized);
  if (absolute !== base && !absolute.startsWith(base + sep)) {
    throw new StudioError('OUT_OF_ROOT', `path is outside the project: ${input}`);
  }
  return { rel: normalized, abs: absolute };
}

/** Reads a UTF-8 text file under the root, with size and encoding guards. */
export async function readSource(root, input) {
  const { rel, abs } = safeRelPath(root, input);
  let stats;
  try {
    stats = await stat(abs);
  } catch {
    throw new StudioError('MISSING', `file not found: ${rel}`);
  }
  if (!stats.isFile()) throw new StudioError('NOT_A_FILE', `not a file: ${rel}`);
  if (stats.size > MAX_FILE_BYTES) {
    throw new StudioError('TOO_LARGE', `${rel} is larger than 2 MB`);
  }
  const buffer = await readFile(abs);
  let text;
  try {
    text = decoder.decode(buffer);
  } catch {
    throw new StudioError('NOT_UTF8', `${rel} is not valid UTF-8`);
  }
  if (text.includes('\r\n')) {
    // CRLF is supported for reading; writes preserve the original EOL.
  }
  return { rel, abs, text, eol: text.includes('\r\n') ? '\r\n' : '\n', version: hashOf(text), bytes: buffer };
}

/**
 * Every `.html` under the root is a candidate page. Real projects nest them
 * (`app/dashboard.html`, `web/views/x.html`), so a `pages/`-only rule misses
 * most of the app; tooling directories are excluded instead.
 */
function isPage(rel) {
  if (!rel.endsWith('.html')) return false;
  return !rel.split('/').some((part) => NON_PAGE_DIRS.has(part));
}

function isStyle(rel) {
  if (!rel.endsWith('.css')) return false;
  return !rel.split('/').some((part) => NON_PAGE_DIRS.has(part) || part === 'components');
}

async function walk(root, dir = '', out = []) {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') {
      if (entry.isDirectory()) continue;
    }
    if (DENY_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await walk(root, rel, out);
    } else if (!IGNORED_FILES.has(entry.name) && !entry.name.startsWith('.')) {
      out.push(rel);
    }
  }
  return out;
}

/** Extracts `<link rel="stylesheet" href>` and `<script src>` from raw HTML. */
export function externalRefs(html) {
  const links = [];
  const scripts = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (href) links.push(href[1] ?? href[2] ?? href[3]);
  }
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) {
    scripts.push(match[1] ?? match[2] ?? match[3]);
  }
  return { links, scripts };
}

/** Resolves a document-relative URL to a project-relative path. */
export function resolveRef(pageRel, href) {
  if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith('data:')) return null;
  const clean = href.split('?')[0].split('#')[0];
  const base = clean.startsWith('/') ? clean.slice(1) : posix.join(posix.dirname(pageRel), clean);
  const normalized = posix.normalize(base);
  if (normalized.startsWith('..')) return null;
  return normalized;
}

/**
 * Turns a module URL (or a path inside the project) into a project-relative
 * path, or null when it lives outside the project — the studio must never
 * claim it can edit a file it is not allowed to write.
 */
function moduleFile(root, url) {
  if (!url) return null;
  let abs;
  try {
    abs = url.startsWith('file:') ? fileURLToPath(url) : resolve(root, url);
  } catch {
    return null;
  }
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return null;
  return rel.split(sep).join('/');
}

/**
 * @param {string} root absolute project root
 * @returns {Promise<{root: string, pages: object[], styles: string[], components: object[], foundations: object[]}>}
 */
export async function discover(root) {
  const resolvedRoot = resolve(root);
  const files = await walk(resolvedRoot);

  const pages = [];
  for (const rel of files.filter(isPage).sort()) {
    let html;
    try {
      html = (await readSource(resolvedRoot, rel)).text;
    } catch {
      continue;
    }
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? rel;
    const { links, scripts } = externalRefs(html);
    pages.push({
      file: rel,
      url: `/${rel}`,
      title,
      styles: links.map((href) => resolveRef(rel, href)).filter(Boolean),
      scripts: scripts.map((src) => resolveRef(rel, src)).filter(Boolean),
    });
  }

  const styles = files.filter(isStyle).sort();
  const scripts = files
    .filter((rel) => SCRIPT_EXT.has(extname(rel)) && !rel.split('/').some((part) => NON_PAGE_DIRS.has(part)))
    .sort();
  const assets = files.filter((rel) => ASSET_EXT.has(extname(rel).toLowerCase())).sort();

  const componentDirs = existsSync(join(resolvedRoot, 'components'))
    ? (await readdir(join(resolvedRoot, 'components'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const components = [];
  for (const name of componentDirs.sort()) {
    const js = `components/${name}/${name}.js`;
    if (!existsSync(join(resolvedRoot, js))) continue;
    let definition = null;
    try {
      const module = await import(join(resolvedRoot, js));
      definition = module.default ?? null;
    } catch (error) {
      components.push({ name, tag: `hf-${name}`, file: js, error: String(error.message ?? error).split('\n')[0] });
      continue;
    }
    const meta = definition?.__hfDefinition ? definition : { props: {}, template: '', styles: null };
    const props = meta?.props && typeof meta.props === 'object' ? meta.props : {};
    components.push({
      name,
      tag: `hf-${name}`,
      file: js,
      // The definition is the source of truth for the stylesheet it links:
      // a component may point anywhere, and the convention alone would lie.
      styles: moduleFile(resolvedRoot, meta?.styles ? new URL(meta.styles, pathToFileURL(join(resolvedRoot, js)).href).href : null) ??
        (existsSync(join(resolvedRoot, 'components', name, `${name}.css`)) ? `components/${name}/${name}.css` : null),
      template: typeof meta?.template === 'string' ? meta.template : '',
      props: Object.fromEntries(Object.entries(props).map(([key, value]) => [key, describeType(value)])),
      defaults: props,
      slots: collectSlots(meta?.template ?? ''),
      usage: `<hf-${name}${Object.entries(props)
        .slice(0, 2)
        .map(([key, value]) => (value === false ? '' : ` ${kebab(key)}="${escapeAttr(String(value))}"`))
        .join('')}></hf-${name}>`,
    });
  }

  let foundations = [];
  try {
    const module = await import(join(resolvedRoot, 'foundation/index.js'));
    foundations = Object.values(module.foundations ?? {}).map((entry) => ({
      name: entry.name,
      summary: entry.meta?.summary ?? '',
      parts: entry.meta?.parts ?? {},
      // What mount() actually refuses to run without. `parts` is the full list.
      required: entry.meta?.required ?? [],
      options: entry.meta?.options ?? {},
      events: entry.meta?.events ?? [],
      usage: `<div data-hf="${entry.name}"></div>`,
      // `meta.file` is an absolute `file://` URL: the studio must name the
      // exact file to edit, not just the foundation's display name.
      file: moduleFile(resolvedRoot, entry.meta?.file),
    }));
  } catch {
    foundations = [];
  }

  return { root: resolvedRoot, pages, styles, scripts, assets, components, foundations };
}

function describeType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

export function escapeAttr(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** Only the slot names a component template declares. */
function collectSlots(template) {
  const slots = new Set();
  for (const match of template.matchAll(/data-hf-slot="([\w-]+)"/g)) slots.add(match[1]);
  return Array.from(slots);
}

/** Directory listing for the "open a page" picker. */
export async function pageList(root) {
  const { pages } = await discover(root);
  return pages.map((page) => ({ file: page.file, url: page.url, title: page.title }));
}

export { relative };
