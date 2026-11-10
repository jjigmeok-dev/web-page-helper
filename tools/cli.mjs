#!/usr/bin/env node
/**
 * `hf` — the no-build workflow tool.
 *
 *   hf list                      foundations and user components on disk
 *   hf new foundation <name>     scaffold a headless foundation
 *   hf new component <name>      scaffold a user component (markup + css + js)
 *   hf new page <name>           scaffold a demo page
 *   hf serve [--port 4173]       static dev server, no bundling
 *   hf studio [--port 4174]      visual editor: pick, edit layout, save
 *   hf validate                  enforce headless rules + check imports
 */
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOUNDATION_DIR = join(ROOT, 'foundation');
const COMPONENT_DIR = join(ROOT, 'components');
const PAGES_DIR = join(ROOT, 'pages');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const ok = (message) => console.log(`\x1b[32m✓\x1b[0m ${message}`);
const info = (message) => console.log(`\x1b[36m·\x1b[0m ${message}`);
const warn = (message) => console.log(`\x1b[33m!\x1b[0m ${message}`);
const dim = (message) => console.log(`  \x1b[2m·\x1b[0m ${message}`);
const fail = (message) => {
  console.error(`\x1b[31m✗\x1b[0m ${message}`);
  process.exitCode = 1;
};

async function listDir(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
}

function titleCase(name) {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function pascal(name) {
  const value = camel(name);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function writeNew(path, content, force) {
  if (existsSync(path) && !force) {
    warn(`skipped existing ${path.replace(`${ROOT}${sep}`, '')}`);
    return false;
  }
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf8');
  ok(`wrote ${path.replace(`${ROOT}${sep}`, '')}`);
  return true;
}

/* ------------------------------------------------------------------ new: foundation */

function foundationSource(name) {
  const id = camel(name);
  return `import { KEY, emit, isDisabled, needsId, options, part, setState } from './core.js';

/**
 * ${titleCase(name)}
 *
 * Markup:
 *   <div data-hf="${name}">
 *     <button data-hf-part="trigger">Label</button>
 *     <div data-hf-part="panel">…</div>
 *   </div>
 *
 * Headless contract: ARIA + state attributes only. No class, style, or CSS.
 */
export const meta = {
  name: '${name}',
  summary: 'TODO: one sentence about the interaction.',
  parts: { trigger: 'button', panel: 'any' },
  // Parts mount() throws without. Keep in sync with the guard below:
  // the studio's Suggestions use it to report a broken instance.
  required: ['trigger', 'panel'],
  options: { defaultOpen: false },
  events: ['hf:open', 'hf:close'],
};

export function mount(root) {
  const trigger = part(root, 'trigger');
  const panel = part(root, 'panel');
  if (!trigger || !panel) throw new Error('[hf] ${name} needs trigger and panel parts');

  const opts = options(root, meta.options);
  const panelId = needsId(panel, 'hf-${name}-panel');
  trigger.setAttribute('aria-controls', panelId);
  trigger.setAttribute('aria-expanded', 'false');

  let open = false;

  function render(next, reason) {
    open = next;
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    setState(root, open ? 'open' : 'closed');
    emit(root, open ? 'hf:open' : 'hf:close', { reason, open });
  }

  const onClick = () => {
    if (isDisabled(trigger)) return;
    render(!open, 'trigger');
  };

  trigger.addEventListener('click', onClick);
  render(Boolean(opts.defaultOpen), 'initial');

  return {
    get open() {
      return open;
    },
    setOpen(next, reason = 'api') {
      render(Boolean(next), reason);
    },
    destroy() {
      trigger.removeEventListener('click', onClick);
    },
  };
}
`;
}

async function newFoundation(args) {
  const [name, ...rest] = args;
  const force = rest.includes('--force');
  if (!name) return fail('usage: hf new foundation <name>');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return fail('foundation name must be kebab-case (e.g. "segmented-control")');
  const file = join(FOUNDATION_DIR, `${name}.js`);
  if (!(await writeNew(file, foundationSource(name), force))) return;

  const indexFile = join(FOUNDATION_DIR, 'index.js');
  if (existsSync(indexFile)) {
    let source = await readFile(indexFile, 'utf8');
    if (source.includes(`from './${name}.js'`)) return;
    const id = camel(name);
    source = source.replace(
      /^import \* as (\w+) from '\.\/[\w-]+\.js';$/m,
      (line) => `${line}\nimport * as ${id} from './${name}.js';`,
    );
    source = source.replace(/const modules = \{/, `const modules = {\n  '${name}': ${id},`);
    await writeFile(indexFile, source, 'utf8');
    ok(`registered "${name}" in foundation/index.js`);
  } else {
    warn('foundation/index.js missing — register the module manually');
  }
  info(`use it: <div data-hf="${name}"> … </div>`);
}

/* ------------------------------------------------------------------ new: component */

function componentJs(name) {
  return `import { defineComponent } from '../../compose/component.js';
import { use } from '../../runtime/index.js';

/**
 * <hf-${name}> — a user component assembled from foundations.
 *
 *   <hf-${name} title="Hello"></hf-${name}>
 */
export default defineComponent({
  name: '${name}',
  baseUrl: import.meta.url,
  styles: './${name}.css',
  props: {
    title: '${titleCase(name)}',
    open: false,
  },
  template: /* html */ \`
    <section class="hf-${name}" data-hf-part="root">
      <header class="hf-${name}__header">
        <h2 class="hf-${name}__title">{{ title }}</h2>
      </header>

      <div data-hf="disclosure" data-hf-part="disclosure">
        <button class="hf-${name}__trigger" data-hf-part="trigger">Details</button>
        <div class="hf-${name}__panel" data-hf-part="panel">
          <div data-hf-slot="default"></div>
        </div>
      </div>
    </section>\`,
  setup({ root, props, on }) {
    const controller = use(root.querySelector('[data-hf]'));
    return {
      update(next) {
        controller.setOpen(next.open, 'prop');
      },
      destroy() {
        controller.destroy?.();
      },
    };
  },
});
`;
}

function componentCss(name) {
  return `/* <hf-${name}> — appearance only. Foundations ship behavior. */
.hf-${name} {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--hf-border, #d4d4d8);
  border-radius: 0.75rem;
  background: var(--hf-surface, #fff);
}

.hf-${name}__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hf-${name}__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.hf-${name}__trigger {
  font: inherit;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--hf-border, #d4d4d8);
  border-radius: 0.5rem;
  background: transparent;
  cursor: pointer;
}

.hf-${name}__trigger[aria-expanded="true"] {
  background: var(--hf-accent, #6366f1);
  border-color: var(--hf-accent, #6366f1);
  color: #fff;
}

.hf-${name}__panel {
  padding-block-start: 0.5rem;
}
`;
}

async function newComponent(args) {
  const [name, ...rest] = args;
  const force = rest.includes('--force');
  if (!name) return fail('usage: hf new component <name>');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return fail('component name must be kebab-case (e.g. "media-card")');
  const dir = join(COMPONENT_DIR, name);
  await writeNew(join(dir, `${name}.js`), componentJs(name), force);
  await writeNew(join(dir, `${name}.css`), componentCss(name), force);
  info(`use it: import './components/${name}/${name}.js' then <hf-${name} title="…">…</hf-${name}>`);
}

/* ------------------------------------------------------------------ new: page */

function pageHtml(name) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titleCase(name)}</title>
    <link rel="stylesheet" href="/styles/base.css" />
    <link rel="stylesheet" href="/styles/demo.css" />
  </head>
  <body>
    <main class="page">
      <h1>${titleCase(name)}</h1>
    </main>

    <script type="module">
      import { start } from '/runtime/index.js';
      import '/components/example-card/example-card.js';
      start();
    </script>
  </body>
</html>
`;
}

async function newPage(args) {
  const [name, ...rest] = args;
  const force = rest.includes('--force');
  if (!name) return fail('usage: hf new page <name>');
  await writeNew(join(PAGES_DIR, `${name}.html`), pageHtml(name), force);
  info(`open http://localhost:4173/pages/${name}.html after \`hf serve\``);
}

/* --------------------------------------------------------------- projects */

/**
 * `hf projects` is the registry: register a frontend you edit often, then
 * reopen it by name instead of remembering a path. Registration writes only to
 * `~/.hf/projects.json`, never into the project.
 */
async function projects(args) {
  const [sub, ...rest] = args;
  const registry = await import('./studio/registry.mjs');

  if (!sub || sub === 'list') {
    const entries = await registry.listProjects();
    if (!entries.length) {
      console.log('\nNo projects registered.');
      info('hf projects add <dir>    register a frontend directory');
      console.log('');
      return;
    }
    console.log('\nRegistered projects');
    for (const entry of entries) {
      const profile = entry.profile?.summary;
      const facts = profile
        ? `${profile.editablePages}/${profile.pages} pages · ${profile.styles} css · ${profile.scripts} js`
        : 'not scanned yet';
      console.log(`  ${entry.name.padEnd(22)} ${facts}`);
      console.log(`  ${''.padEnd(22)} ${entry.root}`);
      console.log(`  ${''.padEnd(22)} id ${entry.id}`);
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    const dir = rest.find((arg) => !arg.startsWith('-')) ?? '.';
    const root = resolve(dir);
    if (!existsSync(root)) return fail(`no such directory: ${root}`);
    const { profileProject } = await import('./studio/profile.mjs');
    const profile = await profileProject(root);
    if (!profile.pages.length) {
      return fail(`no HTML pages under ${root} — point at the directory that holds index.html`);
    }
    const entry = await registry.addProject(root, { profile: summarizeProfile(profile) });
    ok(`registered ${entry.name}`);
    info(`${entry.root}`);
    printProfile(profile);
    info(`next: hf projects up ${entry.name}`);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const reference = rest.find((arg) => !arg.startsWith('-'));
    if (!reference) return fail('usage: hf projects remove <name|id|dir>');
    const removed = await registry.removeProject(reference);
    if (!removed) return fail(`no registered project matches "${reference}"`);
    ok(`removed ${removed.name}`);
    return;
  }

  if (sub === 'show') {
    const reference = rest.find((arg) => !arg.startsWith('-'));
    if (!reference) return fail('usage: hf projects show <name|id|dir>');
    const entry = await resolveProject(reference);
    const { profileProject } = await import('./studio/profile.mjs');
    const profile = await profileProject(entry.root);
    await registry.recordProfile(entry.root, summarizeProfile(profile));
    printProfile(profile, { verbose: true });
    return;
  }

  if (sub === 'up' || sub === 'studio') {
    const reference = rest.find((arg) => !arg.startsWith('-'));
    if (!reference) return fail('usage: hf projects up <name|id|dir> [--port 4174]');
    const entry = await resolveProject(reference);
    const { profileProject } = await import('./studio/profile.mjs');
    const profile = await profileProject(entry.root);
    if (!profile.pages.length) return fail(`no HTML pages under ${entry.root}`);
    await registry.recordProfile(entry.root, summarizeProfile(profile));
    printProfile(profile);
    // Passing the proxy through here is what `up` is for: profile, then open
    // the editor with the backend already wired up.
    const passthrough = rest.filter((arg) => arg !== reference);
    await studio([entry.root, ...passthrough]);
    return;
  }

  return fail(`unknown projects command "${sub}" — use list, add, show, up, remove`);
}

/** Resolves a registry reference, falling back to a plain directory. */
async function resolveProject(reference) {
  const registry = await import('./studio/registry.mjs');
  const found = await registry.findProject(reference);
  if (found) return found;
  const asPath = resolve(reference);
  if (existsSync(asPath)) return { id: null, name: asPath.split(sep).filter(Boolean).at(-1), root: asPath };
  throw new Error(`no registered project matches "${reference}"`);
}

/** The compact slice stored on the registry entry. */
function summarizeProfile(profile) {
  return {
    kind: profile.kind,
    stack: profile.stack,
    summary: profile.summary,
    warnings: profile.warnings.length,
    scannedAt: new Date().toISOString(),
  };
}

function printProfile(profile, { verbose = false } = {}) {
  const { summary, stack } = profile;
  console.log('');
  console.log(`${profile.name}  ·  ${profile.kind}${stack.framework ? ` (${stack.framework})` : ''}`);
  console.log(`  ${summary.editablePages}/${summary.pages} editable pages · ${summary.styles} stylesheets · ${summary.scripts} scripts · ${summary.assets} assets`);
  console.log(`  ${summary.components} components · ${summary.foundations} foundations · ${summary.tokens} design tokens`);
  if (profile.externalOrigins.length) {
    console.log(`  external: ${profile.externalOrigins.map((entry) => entry.origin).join(', ')}`);
  }
  if (profile.warnings.length) {
    console.log('');
    for (const warning of profile.warnings) {
      const where = warning.file ? `${warning.file}: ` : '';
      const mark =
        warning.level === 'error' ? '\x1b[31m✗\x1b[0m' : warning.level === 'info' ? '\x1b[36m·\x1b[0m' : '\x1b[33m!\x1b[0m';
      console.log(`  ${mark} ${where}${warning.message}`);
    }
  }
  if (verbose) {
    console.log('');
    console.log('Pages');
    for (const page of profile.pages) {
      const state = page.editable ? 'editable' : 'BLOCKED';
      console.log(`  ${page.file.padEnd(34)} ${state.padEnd(9)} ${page.nodes} nodes`);
    }
    if (profile.styles.length) {
      console.log('');
      console.log('Stylesheets');
      for (const sheet of profile.styles) {
        console.log(`  ${sheet.file.padEnd(34)} ${sheet.rules} rules  ${Math.round(sheet.bytes / 1024)} KB${sheet.editable ? '' : '  BLOCKED'}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ serve */

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(base, decoded));
  if (!target.startsWith(base + sep) && target !== base) return null;
  return target;
}

/**
 * `--root <dir>` (or a bare positional path) points the server at a project.
 * The default is the current directory, so `hf studio` works from a user's own
 * project instead of always editing the toolkit.
 */
/** Flags that consume the next argument; their value is not a path. */
const VALUE_FLAGS = new Set(['--root', '-r', '--port', '-p', '--proxy', '--host', '--token', '--browse-root']);

function rootArg(args) {
  const index = args.findIndex((arg) => arg === '--root' || arg === '-r');
  if (index !== -1) {
    if (!args[index + 1]) throw new Error('--root needs a directory');
    return resolve(args[index + 1]);
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-') || /^\d+$/.test(arg)) continue;
    return resolve(arg);
  }
  return process.cwd();
}

/** `--host 0.0.0.0` binds beyond loopback; `--host` alone is a usage error. */
function hostArg(args) {
  const index = args.findIndex((arg) => arg === '--host');
  if (index === -1) return '127.0.0.1';
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error('--host needs an address (e.g. 0.0.0.0)');
  return value;
}

/** `--token <value>` pins the access token; omitted on a LAN bind generates one. */
function tokenArg(args) {
  const index = args.findIndex((arg) => arg === '--token');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error('--token needs a value');
  return value;
}

/** `--browse-root <dir>` replaces the default picker root (the user's home). */
function browseRootArg(args) {
  const index = args.findIndex((arg) => arg === '--browse-root');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error('--browse-root needs a directory');
  return resolve(value);
}

/** `--proxy http://127.0.0.1:8000` forwards unknown routes to the app backend. */
function proxyArg(args) {
  const index = args.findIndex((arg) => arg === '--proxy');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error('--proxy needs a URL');
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error('--proxy must be an http(s) URL');
  return url.origin;
}

async function serve(args) {
  const portFlag = args.indexOf('--port');
  const port = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.PORT) || 4173;
  const root = rootArg(args);
  const { isLoopback, lanAddresses, resolveToken, tokenMatches } = await import('./studio/server.mjs');
  const host = hostArg(args);
  const token = resolveToken(host, tokenArg(args));

  const server = createServer(async (req, res) => {
    // Same rule as the studio: a network bind is token-gated so an accidental
    // `--host 0.0.0.0` does not publish the project to the whole LAN.
    if (token) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
      const provided = url.searchParams.get('token') ?? req.headers['x-hf-token'];
      if (!tokenMatches(token, provided)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('401 token required');
        return;
      }
    }
    let target = safeJoin(root, req.url === '/' ? '/index.html' : req.url);
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      let stats = await stat(target);
      if (stats.isDirectory()) {
        target = join(target, 'index.html');
        stats = await stat(target);
      }
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[extname(target)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 ${req.url}`);
    }
  });

  server.listen(port, host, () => {
    const query = token ? `?token=${token}` : '';
    ok(`dev server http://${host}:${port}/${query}`);
    if (!isLoopback(host)) {
      for (const address of lanAddresses()) dim(`lan http://${address}:${port}/${query}`);
    }
    info('edit files and reload — no build step, no watcher');
  });
}

/* ------------------------------------------------------------------ validate */

const FORBIDDEN = [
  { pattern: /\.className\s*=/, message: 'assigns className (foundations must not style)' },
  { pattern: /\.classList\.(add|remove|toggle)/, message: 'mutates classList' },
  { pattern: /\.style\.[a-zA-Z]+\s*=/, message: 'writes inline style' },
  { pattern: /createElement\(['"]style['"]\)/, message: 'creates a <style> element' },
  { pattern: /insertAdjacentHTML/, message: 'injects HTML' },
  { pattern: /document\.write/, message: 'uses document.write' },
];

async function validate() {
  const files = (await readdir(FOUNDATION_DIR)).filter((file) => file.endsWith('.js') && file !== 'core.js' && file !== 'index.js');
  let issues = 0;

  for (const file of files) {
    const source = await readFile(join(FOUNDATION_DIR, file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          fail(`foundation/${file}:${index + 1} ${rule.message}`);
          issues += 1;
        }
      }
      if (/<style\b/.test(line)) {
        fail(`foundation/${file}:${index + 1} ships a <style> tag`);
        issues += 1;
      }
    });
    if (!/export const meta/.test(source)) {
      fail(`foundation/${file} has no exported meta`);
      issues += 1;
    }
    if (!/export function mount/.test(source)) {
      fail(`foundation/${file} has no exported mount`);
      issues += 1;
    }
    const controller = /destroy\s*\(/.test(source);
    if (!controller) {
      fail(`foundation/${file} mount returns no destroy()`);
      issues += 1;
    }
  }

  const registryFile = join(FOUNDATION_DIR, 'index.js');
  if (!existsSync(registryFile)) {
    fail('foundation/index.js is missing');
    issues += 1;
  } else {
    const registry = await readFile(registryFile, 'utf8');
    for (const file of files) {
      const name = file.replace(/\.js$/, '');
      if (!registry.includes(`'./${name}.js'`)) {
        fail(`foundation/${name}.js is not imported by foundation/index.js`);
        issues += 1;
      }
    }
  }

  const components = await listDir(COMPONENT_DIR);
  for (const component of components) {
    const js = join(COMPONENT_DIR, component, `${component}.js`);
    const css = join(COMPONENT_DIR, component, `${component}.css`);
    if (!existsSync(js)) {
      fail(`components/${component} has no ${component}.js`);
      issues += 1;
      continue;
    }
    const source = await readFile(js, 'utf8');
    if (!/name:\s*['"]/.test(source)) {
      fail(`components/${component}/${component}.js defines no name`);
      issues += 1;
    }
    if (source.includes('styles:') && !existsSync(css)) {
      fail(`components/${component} declares styles but ${component}.css is missing`);
      issues += 1;
    }
    for (const [, tag] of source.matchAll(/data-hf="([\w-]+)"/g)) {
      if (!existsSync(join(FOUNDATION_DIR, `${tag}.js`)) && !['switch'].includes(tag)) {
        fail(`components/${component} uses unknown foundation "${tag}"`);
        issues += 1;
      }
    }
  }

  if (!issues) ok(`${files.length} foundations and ${components.length} components pass the headless rules`);
  else fail(`${issues} issue(s) found`);
}

/* ------------------------------------------------------------------ list */

async function list() {
  const foundationFiles = (await readdir(FOUNDATION_DIR)).filter(
    (file) => file.endsWith('.js') && file !== 'core.js' && file !== 'index.js',
  );
  console.log('\nFoundations (behavior + ARIA only)');
  for (const file of foundationFiles.sort()) {
    const source = await readFile(join(FOUNDATION_DIR, file), 'utf8');
    const summary = source.match(/summary:\s*'([^']+)'/)?.[1] ?? '';
    console.log(`  ${file.replace(/\.js$/, '').padEnd(16)} ${summary}`);
  }
  const components = await listDir(COMPONENT_DIR);
  console.log('\nUser components (assembled)');
  if (!components.length) console.log('  (none yet — hf new component <name>)');
  for (const component of components.sort()) console.log(`  <hf-${component}>`);
  // Same discovery the studio uses, so `hf list` never disagrees with the
  // editor about which files are pages.
  const { pageList } = await import('./studio/discover.mjs');
  const pages = await pageList(ROOT);
  console.log('\nPages');
  if (!pages.length) console.log('  (none yet — hf new page <name>)');
  for (const page of pages.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  /${page.file.padEnd(24)} ${page.title || ''}`.trimEnd());
  }
  console.log('');
}

/* ----------------------------------------------------------------- studio */

async function studio(args) {
  const portArg = args.findIndex((arg) => arg === '--port' || arg === '-p');
  const port = portArg !== -1 ? Number(args[portArg + 1]) : 4174;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('--port must be an integer 0-65535');
  const { startStudio } = await import('./studio/server.mjs');
  const root = rootArg(args);
  if (!existsSync(root)) return fail(`no such directory: ${root}`);
  const proxy = proxyArg(args);
  const host = hostArg(args);
  const browseRoot = browseRootArg(args);
  if (browseRoot && !existsSync(browseRoot)) return fail(`no such browse root: ${browseRoot}`);
  const instance = await startStudio({ root, port, host, proxy, token: tokenArg(args), browseRoot });
  info('pick an element, edit it, then Save — nothing is written until you confirm the diff');
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ------------------------------------------------------------------ main */

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`\nhf — headless foundations, composed into user components, built never.

  hf list                        list foundations, components and pages
  hf new foundation <name>       scaffold a headless foundation
  hf new component <name>        scaffold a user component
  hf new page <name>             scaffold a demo page
  hf serve [--port 4173]         static dev server
  hf serve --host 0.0.0.0        serve on the network (phone / another machine)
  hf studio [--port 4174]        visual editor (select, edit, save)
  hf studio --host 0.0.0.0       also listen on the network (LAN / phone testing)
  hf studio --token <value>      pin the access token instead of generating one
  hf studio --browse-root <dir>  start the folder picker elsewhere (default: ~)
  hf studio --proxy <url>        also forward unknown routes to the app backend
  hf projects add <dir>          register a frontend and profile it
  hf projects list               list registered projects
  hf projects show <name>        full frontend profile
  hf projects up <name>          profile + start the editor for it
  hf projects remove <name>      forget a project
  hf validate                    enforce headless rules

Docs: README.md · Demo: http://localhost:4173 after \`hf serve\`
`);
    return;
  }

  if (command === 'list') return list();
  if (command === 'serve') return serve(process.argv.slice(3));
  if (command === 'studio') return studio(process.argv.slice(3));
  if (command === 'validate') return validate();
  if (command === 'projects' || command === 'project') return projects(process.argv.slice(3));
  if (command === 'new') {
    if (sub === 'foundation') return newFoundation(rest);
    if (sub === 'component') return newComponent(rest);
    if (sub === 'page') return newPage(rest);
    return fail(`unknown kind "${sub ?? ''}" — use foundation, component or page`);
  }
  return fail(`unknown command "${command}" — try \`hf help\``);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
