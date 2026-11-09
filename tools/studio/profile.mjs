/**
 * Frontend profile.
 *
 * Answers one question: what does this project's frontend consist of, and what
 * does the editor need to know before it can safely serve and edit it?
 *
 * Everything here is read-only. It reports facts about the project instead of
 * guessing: a stack is only named when its files are actually present, and a
 * warning is only raised when the editor would genuinely fail on that file.
 *
 * Shape:
 *   rootDir, name, kind, stack, entryPoints, urlBase,
 *   pages[], styles[], scripts[], assets[],
 *   components[], foundations[], tokens[], externalOrigins[],
 *   warnings[], summary{}
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { discover, readSource } from './discover.mjs';
import { scanHtml } from '../scan/html.mjs';
import { scanCss } from '../scan/css.mjs';

const FRAMEWORK_MARKERS = [
  { stack: 'next', files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  { stack: 'vite', files: ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'] },
  { stack: 'webpack', files: ['webpack.config.js', 'webpack.config.mjs', 'webpack.config.ts'] },
  { stack: 'astro', files: ['astro.config.mjs'] },
  { stack: 'nuxt', files: ['nuxt.config.js', 'nuxt.config.ts'] },
  { stack: 'svelte', files: ['svelte.config.js'] },
  { stack: 'angular', files: ['angular.json'] },
  { stack: 'parcel', files: ['.parcelrc'] },
];

/** Files that mean "this is a built/bundled app, not hand-written source". */
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'out', '.next', '.nuxt', '.output', 'public/build']);

/**
 * @param {string} input project root
 * @param {{maxFiles?: number}} [options]
 */
export async function profileProject(input, options = {}) {
  const root = resolve(input);
  const warnings = [];
  const project = await discover(root);

  const stack = await detectStack(root);
  const kind = classifyKind(project, stack);

  // Every page is modelled once: the editor needs to know which files are
  // editable before the user clicks anything, and one broken page must not
  // prevent listing the rest.
  const pages = [];
  for (const page of project.pages) {
    const entry = {
      file: page.file,
      url: page.url,
      title: page.title,
      styles: page.styles,
      scripts: page.scripts,
      editable: true,
      problems: [],
      nodes: 0,
      components: [],
      foundationCount: 0,
    };
    try {
      const source = await readSource(root, page.file);
      const tree = scanHtml(source.text);
      entry.problems = tree.problems;
      entry.nodes = tree.nodes.length;
      entry.editable = tree.problems.length === 0;
      if (tree.problems.length) {
        warnings.push({
          file: page.file,
          level: 'error',
          message: `cannot be edited: ${tree.problems[0].message}`,
        });
      }
      // External refs are resolved to project paths by `discover`, so collect
      // the raw href/src from the markup itself: a Google Fonts link is a real
      // dependency even though it is not an editable file.
      for (const match of source.text.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const ref = match[1] ?? match[2] ?? match[3];
        if (!ref || !/^(?:[a-z]+:)?\/\//i.test(ref)) continue;
        try {
          const origin = new URL(ref.startsWith('//') ? `https:${ref}` : ref).origin;
          entry.external = entry.external ?? [];
          if (!entry.external.includes(origin)) entry.external.push(origin);
        } catch {
          /* unparsable ref: ignore */
        }
      }

      const componentNames = new Set();
      for (const node of tree.nodes) {
        if (node.tag.startsWith('hf-')) componentNames.add(node.tag.slice(3));
        if (node.tag === 'template') continue;
      }
      entry.components = [...componentNames].sort();
      entry.foundationCount = tree.nodes.filter(
        (node) => node.attrs?.some?.((attr) => attr.name === 'data-hf'),
      ).length;
    } catch (error) {
      entry.editable = false;
      entry.problems = [{ message: error.message }];
      warnings.push({ file: page.file, level: 'error', message: error.message });
    }
    pages.push(entry);
  }

  // Stylesheets: size, rule count, and whether the editor can rewrite them.
  const styles = [];
  const cssOrigins = new Set();
  for (const file of project.styles) {
    const entry = { file, bytes: 0, rules: 0, customProps: 0, editable: true, problems: [] };
    try {
      const source = await readSource(root, file);
      entry.bytes = source.bytes.length;
      const css = scanCss(source.text);
      entry.rules = css.rules.filter((rule) => !rule.block).length;
      entry.customProps = css.customProps.length;
      entry.problems = css.problems;
      entry.editable = css.problems.length === 0;
      // `@import url(https://fonts.googleapis.com/…)` is a real runtime
      // dependency (and the source of very long unbreakable tokens).
      for (const match of source.text.matchAll(/@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
        try {
          cssOrigins.add(new URL(match[1].startsWith('//') ? `https:${match[1]}` : match[1]).origin);
        } catch {
          /* unparsable import: ignore */
        }
      }
      if (css.problems.length) {
        warnings.push({ file, level: 'error', message: `CSS cannot be rewritten: ${css.problems[0].message}` });
      }
    } catch (error) {
      entry.editable = false;
      warnings.push({ file, level: 'error', message: error.message });
    }
    styles.push(entry);
  }

  // Design tokens, grouped the way the panel shows them.
  const tokens = [];
  const tokenMap = new Map();
  for (const file of project.styles) {
    try {
      const source = await readSource(root, file);
      const css = scanCss(source.text);
      for (const prop of css.customProps) {
        const group = prop.name.replace(/^--/, '').split('-')[0] || 'base';
        if (!tokenMap.has(group)) tokenMap.set(group, new Map());
        tokenMap.get(group).set(prop.name, { value: prop.value, file });
      }
    } catch {
      /* already reported on the stylesheet entry */
    }
  }
  for (const [group, map] of tokenMap) {
    tokens.push({ group, count: map.size, tokens: [...map].map(([name, meta]) => ({ name, ...meta })) });
  }

  const scripts = project.scripts.map((file) => ({
    file,
    module: file.endsWith('.mjs'),
    bytes: 0,
    apiPrefixes: [],
  }));
  const apiPrefixes = new Set();
  for (const entry of scripts) {
    try {
      const source = await readSource(root, entry.file);
      entry.bytes = source.bytes.length;
      // A page that fetches `/api/…` needs that backend running, or the
      // preview shows a JSON parse error instead of the app. The calls are
      // usually `fetch(path)` with the path built elsewhere, so look for the
      // route literals rather than the fetch call itself.
      for (const match of source.text.matchAll(/['"`](\/(?:api|graphql|rest)\b[^'"`\s]*)/g)) {
        entry.apiPrefixes.push(`/${match[1].split('/').filter(Boolean)[0]}`);
      }
      entry.apiPrefixes = [...new Set(entry.apiPrefixes)];
      for (const prefix of entry.apiPrefixes) apiPrefixes.add(prefix);
    } catch {
      entry.bytes = 0;
    }
  }

  const externalOrigins = collectExternalOrigins(pages, cssOrigins);

  const summary = {
    pages: pages.length,
    editablePages: pages.filter((page) => page.editable).length,
    styles: styles.length,
    scripts: scripts.length,
    assets: project.assets.length,
    components: project.components.length,
    // Instances found in pages, not modules the project happens to register:
    // for a user's frontend "foundations" means the `data-hf` attributes.
    foundations: pages.reduce((total, page) => total + page.foundationCount, 0),
    registeredFoundations: project.foundations.length,
    tokens: tokens.reduce((total, group) => total + group.count, 0),
    bytes: 0,
  };
  summary.bytes =
    styles.reduce((total, entry) => total + entry.bytes, 0) +
    scripts.reduce((total, entry) => total + entry.bytes, 0);

  if (!pages.length) {
    warnings.push({
      file: null,
      level: 'error',
      message: 'no HTML pages found — point the tool at the directory that holds index.html',
    });
  }
  if (styles.some((entry) => entry.file === '')) {
    warnings.push({ file: null, level: 'warn', message: 'a page has inline <style>; those rules are editable but not extracted to a file' });
  }
  if (apiPrefixes.size) {
    const list = [...apiPrefixes].sort().join(', ');
    warnings.push({
      file: null,
      level: 'info',
      message: `pages call ${list}; start the app backend and pass --proxy <url> so the preview gets real data`,
    });
  }
  if (stack.framework && !stack.bundled) {
    warnings.push({
      file: null,
      level: 'warn',
      message: `this looks like a ${stack.framework} project; sources may not be plain HTML the studio can rewrite`,
    });
  }

  return {
    rootDir: root,
    name: root.split('/').filter(Boolean).at(-1) ?? 'project',
    kind,
    stack,
    urlBase: '/',
    pages,
    styles,
    scripts,
    apiPrefixes: [...apiPrefixes].sort(),
    assets: project.assets,
    components: project.components,
    foundations: project.foundations,
    tokens,
    externalOrigins,
    warnings,
    summary,
  };
}

async function readPackageJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function detectStack(root) {
  const found = [];
  for (const marker of FRAMEWORK_MARKERS) {
    if (marker.files.some((file) => existsSync(join(root, file)))) found.push(marker.stack);
  }
  const pkg = join(root, 'package.json');
  const pkgJson = await readPackageJson(pkg);
  const dependencies = { ...(pkgJson?.dependencies ?? {}), ...(pkgJson?.devDependencies ?? {}) };
  const hasBundler = found.length > 0 || Boolean(dependencies.vite || dependencies.webpack || dependencies.parcel);
  return {
    framework: found.length ? found[found.length - 1] : null,
    frameworks: found,
    bundled: hasBundler,
    packageManager: existsSync(join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(root, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(root, 'package-lock.json'))
          ? 'npm'
          : null,
    type: pkgJson?.type ?? null,
  };
}

function classifyKind(project, stack) {
  if (project.foundations.length) return 'toolkit';
  if (stack.bundled) return 'bundled';
  if (project.components.length) return 'component-based';
  return 'static';
}

/** Origins a page loads from, so the editor can warn about offline failures. */
function collectExternalOrigins(pages, cssOrigins = new Set()) {
  const origins = new Map();
  for (const page of pages) {
    for (const origin of page.external ?? []) {
      origins.set(origin, (origins.get(origin) ?? 0) + 1);
    }
  }
  for (const origin of cssOrigins) {
    if (!origins.has(origin)) origins.set(origin, 0);
  }
  return [...origins].map(([origin, count]) => ({ origin, pages: count }));
}

/** Files the editor will never touch, for the bootstrap report. */
export function describeSkipDirs() {
  return [...BUILD_OUTPUT_DIRS];
}
