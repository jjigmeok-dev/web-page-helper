import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../tools/studio/api.mjs';
import { browseRootsFor, isLoopback, resolveToken, startStudio, tokenMatches } from '../tools/studio/server.mjs';

/**
 * Two sibling projects under one browsable parent, which is the layout the
 * picker is built for: switch projects without leaving the parent directory.
 */
async function makeTree() {
  const base = await mkdtemp(join(tmpdir(), 'hf-hosting-'));
  await mkdir(join(base, 'alpha'));
  await mkdir(join(base, 'beta'));
  await mkdir(join(base, 'empty'));
  await writeFile(join(base, 'alpha', 'index.html'), '<!doctype html><html><head><title>Alpha</title></head><body><p>A</p></body></html>\n', 'utf8');
  await writeFile(join(base, 'beta', 'home.html'), '<!doctype html><html><head><title>Beta</title></head><body><p>B</p></body></html>\n', 'utf8');
  return base;
}

/** Runs `fn` against a live server and always closes it. */
async function withServer(options, fn) {
  const instance = await startStudio({ quiet: true, port: 0, ...options });
  try {
    return await fn(instance);
  } finally {
    await instance.close();
  }
}

/* ------------------------------------------------------------------ token */

test('isLoopback covers the addresses that never leave the machine', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopback(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.0.10', '10.0.0.5']) {
    assert.equal(isLoopback(host), false, host);
  }
});

test('a network bind always ends up with a token, a loopback bind does not', () => {
  assert.equal(resolveToken('127.0.0.1', null), null);
  assert.equal(resolveToken('127.0.0.1', 'pinned'), 'pinned');
  const generated = resolveToken('0.0.0.0', null);
  assert.match(generated, /^[0-9a-f]{32}$/);
  assert.equal(resolveToken('0.0.0.0', 'pinned'), 'pinned');
  // Every bind gets its own token: reusing one would defeat the point.
  assert.notEqual(resolveToken('0.0.0.0', null), resolveToken('0.0.0.0', null));
});

test('tokenMatches rejects absent, empty and wrong-length tokens without throwing', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc123', 'abc124'), false);
  assert.equal(tokenMatches('abc123', ''), false);
  assert.equal(tokenMatches('abc123', null), false);
  assert.equal(tokenMatches('abc123', 'abc1234'), false);
});

test('a loopback bind needs no token', async () => {
  const base = await makeTree();
  try {
    await withServer({ root: join(base, 'alpha'), browseRoot: base }, async (instance) => {
      assert.equal(instance.token, null);
      const response = await fetch(`http://127.0.0.1:${instance.port}/__api/project`);
      assert.equal(response.status, 200);
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a token gates the API, the studio shell and project files alike', async () => {
  const base = await makeTree();
  try {
    const options = { root: join(base, 'alpha'), browseRoot: base, token: 'secret-token' };
    await withServer(options, async (instance) => {
      const origin = `http://127.0.0.1:${instance.port}`;
      // A missing token must not fall through to any handler: a 200 here would
      // mean a page on the LAN can read the project without the printed URL.
      for (const path of ['/__api/project', '/__studio', '/index.html']) {
        assert.equal((await fetch(origin + path)).status, 401, path);
      }
      assert.equal((await fetch(`${origin}/__api/project?token=wrong`)).status, 401);
      assert.equal((await fetch(`${origin}/__api/project?token=secret-token`)).status, 200);
      // The header form keeps the token out of logs and Referer.
      const viaHeader = await fetch(`${origin}/__api/project`, { headers: { 'x-hf-token': 'secret-token' } });
      assert.equal(viaHeader.status, 200);
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------------- browse */

test('browse lists directories under the browse root and marks openable ones', async () => {
  const base = await makeTree();
  const api = createApi(join(base, 'alpha'), { browseRoots: () => [base] });
  try {
    const rootListing = await api.handle('browse', { query: {} });
    assert.equal(rootListing.status, 200);
    assert.equal(rootListing.body.path, base);
    assert.equal(rootListing.body.parent, null, 'the browse root has no parent to go up to');
    assert.equal(rootListing.body.root, base);
    assert.deepEqual(rootListing.body.roots.map((r) => r.path), [base]);
    assert.deepEqual(rootListing.body.dirs.map((d) => d.name), ['alpha', 'beta', 'empty']);
    assert.equal(rootListing.body.openable, false, 'the parent itself holds no pages');

    const beta = await api.handle('browse', { query: { dir: join(base, 'beta') } });
    assert.equal(beta.body.path, join(base, 'beta'));
    assert.equal(beta.body.parent, base);
    assert.equal(beta.body.openable, true);
    assert.deepEqual(beta.body.pages, ['home.html']);

    const empty = await api.handle('browse', { query: { dir: 'empty' } });
    assert.equal(empty.body.path, join(base, 'empty'));
    assert.equal(empty.body.openable, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('browse refuses every path that escapes the browse root', async () => {
  const base = await makeTree();
  const api = createApi(join(base, 'alpha'), { browseRoots: () => [base] });
  try {
    for (const dir of ['/', '/etc', '..', '../..', 'alpha/../..', join(base, '..'), join(base, 'alpha', '..', '..')]) {
      const result = await api.handle('browse', { query: { dir } });
      assert.equal(result.body.code, 'OUT_OF_ROOT', `escaped via ${dir}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a browse root equal to the project keeps siblings out of reach', async () => {
  const base = await makeTree();
  const api = createApi(join(base, 'alpha'), { browseRoots: () => [join(base, 'alpha')] });
  try {
    const own = await api.handle('browse', { query: {} });
    assert.equal(own.body.openable, true);
    assert.deepEqual(own.body.dirs, []);
    const sibling = await api.handle('browse', { query: { dir: join(base, 'beta') } });
    assert.equal(sibling.body.code, 'OUT_OF_ROOT');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------- open */

test('open switches the served project without a restart', async () => {
  const base = await makeTree();
  try {
    await withServer({ root: join(base, 'alpha'), browseRoot: base }, async (instance) => {
      const origin = `http://127.0.0.1:${instance.port}`;
      assert.match(await (await fetch(`${origin}/index.html`)).text(), /Alpha/);
      assert.equal((await fetch(`${origin}/home.html`)).status, 404);

      const opened = await (
        await fetch(`${origin}/__api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: join(base, 'beta') }),
        })
      ).json();
      assert.equal(opened.ok, true);
      assert.equal(opened.root, join(base, 'beta'));
      assert.deepEqual(opened.pages.map((p) => p.file), ['home.html']);
      assert.equal(instance.root, join(base, 'beta'), 'the server exposes its live root');

      // The static server reads the live root, not the one captured at start.
      assert.match(await (await fetch(`${origin}/home.html`)).text(), /Beta/);
      assert.equal((await fetch(`${origin}/index.html`)).status, 404);
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('open refuses directories outside the browse root and leaves the root intact', async () => {
  const base = await makeTree();
  try {
    await withServer({ root: join(base, 'alpha'), browseRoot: base }, async (instance) => {
      const origin = `http://127.0.0.1:${instance.port}`;
      const post = (dir) =>
        fetch(`${origin}/__api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir }),
        }).then((r) => r.json());

      assert.equal((await post('/etc')).code, 'OUT_OF_ROOT');
      assert.equal((await post(join(base, '..'))).code, 'OUT_OF_ROOT');
      // A directory with no HTML is not a project; saying so beats an empty editor.
      assert.equal((await post(join(base, 'empty'))).code, 'NO_PAGES');
      assert.equal((await post(join(base, 'alpha', 'index.html'))).code, 'NOT_A_DIR');
      assert.equal(instance.root, join(base, 'alpha'));
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('open edits are confined to the newly opened project', async () => {
  const base = await makeTree();
  const state = { root: join(base, 'alpha') };
  const api = createApi(() => state.root, { browseRoots: () => [base], state });
  try {
    // Before switching, a beta path is an escape from alpha.
    const before = await api.handle('source', { query: { file: 'home.html' } });
    assert.equal(before.body.code, 'MISSING');

    await api.handle('open', { body: { dir: join(base, 'beta') } });
    assert.equal(state.root, join(base, 'beta'));
    // The same relative path now resolves inside beta.
    const after = await api.handle('source', { query: { file: 'home.html' } });
    assert.equal(after.status, 200);
    assert.match(after.body.text, /Beta/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- multiple roots */

test('the picker can reach the home directory and the project', () => {
  const project = '/srv/apps/site';
  const roots = browseRootsFor(null, project);
  assert.equal(roots[0], homedir(), 'home is the default starting point');
  assert.ok(roots.includes(project), 'a project outside home stays reachable');

  // A project inside home adds no second root: home already covers it.
  assert.deepEqual(browseRootsFor(null, join(homedir(), 'work', 'site')), [homedir()]);

  // An explicit --browse-root replaces home but keeps the project reachable.
  const explicit = browseRootsFor('/data', '/srv/app');
  assert.deepEqual(explicit, ['/data', '/srv/app']);
});

test('browsing starts at home and reaches a project outside it', async () => {
  const base = await makeTree();
  const api = createApi(join(base, 'alpha'), { browseRoots: () => [homedir(), base] });
  try {
    const listing = await api.handle('browse', { query: {} });
    assert.equal(listing.body.path, homedir(), 'the picker opens at home by default');
    assert.deepEqual(listing.body.roots.map((r) => r.path), [homedir(), base]);
    // Home is above the project, so it is its own stopping point.
    assert.equal(listing.body.parent, null);

    // A path outside both roots is refused, and inside home is allowed.
    const outside = await api.handle('browse', { query: { dir: join(base, '..', '..') } });
    assert.equal(outside.body.code, 'OUT_OF_ROOT');
    const inHome = await api.handle('browse', { query: { dir: homedir() } });
    assert.equal(inHome.status, 200);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('parent stops at the root that contains the current directory', async () => {
  const base = await makeTree();
  const api = createApi(join(base, 'alpha'), { browseRoots: () => [base] });
  try {
    const listing = await api.handle('browse', { query: { dir: join(base, 'beta') } });
    assert.equal(listing.body.parent, base);
    // From the root itself there is nowhere to go up to.
    const atRoot = await api.handle('browse', { query: { dir: base } });
    assert.equal(atRoot.body.parent, null);
    assert.equal(atRoot.body.root, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a relative dir resolves against the directory being shown', async () => {
  const base = await makeTree();
  const api = createApi(join(base, 'alpha'), { browseRoots: () => [base] });
  try {
    // `base` tells the server where the picker currently is; without it a
    // relative name would resolve from the root and miss the sibling.
    const fromBeta = await api.handle('browse', { query: { dir: '../alpha', base: join(base, 'beta') } });
    assert.equal(fromBeta.body.path, join(base, 'alpha'));
    assert.equal(fromBeta.body.openable, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
