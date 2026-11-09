import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileProject } from '../tools/studio/profile.mjs';
import { addProject, findProject, listProjects, removeProject, registryFile } from '../tools/studio/registry.mjs';
import { createApi } from '../tools/studio/api.mjs';
import { instrumentHtml } from '../tools/studio/server.mjs';

/** Isolates the registry so tests never touch the developer's `~/.hf`. */
async function withRegistry(run) {
  const home = await mkdtemp(join(tmpdir(), 'hf-registry-'));
  const previous = process.env.HF_HOME;
  process.env.HF_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.HF_HOME;
    else process.env.HF_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/** A minimal static frontend: one page, one stylesheet, one script. */
async function makeProject(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hf-project-'));
  await writeFile(
    join(root, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
  <title>Demo</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
</head>
<body>
  <h1 data-hf="disclosure">Hello</h1>
  <p>Body</p>
  <script src="/app.js"></script>
</body>
</html>
`,
    'utf8',
  );
  await writeFile(join(root, 'style.css'), ':root { --brand: #087e71; --space-2: 8px; }\nh1 { color: var(--brand); }\n', 'utf8');
  await writeFile(join(root, 'app.js'), 'export const ready = true;\n', 'utf8');
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), body, 'utf8');
  }
  return root;
}

test('profile reports a plain static frontend without warnings', async () => {
  const root = await makeProject();
  try {
    const profile = await profileProject(root);
    assert.equal(profile.kind, 'static');
    assert.equal(profile.summary.pages, 1);
    assert.equal(profile.summary.editablePages, 1);
    assert.equal(profile.summary.styles, 1);
    assert.equal(profile.summary.scripts, 1);
    assert.equal(profile.summary.components, 0);
    assert.equal(profile.summary.foundations, 1);
    assert.deepEqual(profile.warnings, []);
    assert.equal(profile.summary.registeredFoundations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile collects design tokens grouped by their first segment', async () => {
  const root = await makeProject();
  try {
    const profile = await profileProject(root);
    const groups = Object.fromEntries(profile.tokens.map((group) => [group.group, group.tokens.map((token) => token.name)]));
    assert.deepEqual(groups.brand, ['--brand']);
    assert.deepEqual(groups.space, ['--space-2']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile names external origins from markup and CSS @import', async () => {
  const root = await makeProject();
  try {
    await writeFile(join(root, 'style.css'), '@import url("https://cdn.example.com/base.css");\n:root { --a: 1px; }\n', 'utf8');
    const profile = await profileProject(root);
    const origins = profile.externalOrigins.map((entry) => entry.origin).sort();
    assert.deepEqual(origins, ['https://cdn.example.com', 'https://fonts.googleapis.com']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile marks a page with unclosed markup as not editable', async () => {
  const root = await makeProject({ 'broken.html': '<html><body><div><p>x</span></body></html>' });
  try {
    const profile = await profileProject(root);
    const page = profile.pages.find((entry) => entry.file === 'broken.html');
    assert.equal(page.editable, false);
    assert.ok(page.problems.length > 0);
    assert.ok(profile.warnings.some((warning) => warning.file === 'broken.html' && warning.level === 'error'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile flags pages that call a backend so the preview can proxy it', async () => {
  const root = await makeProject();
  try {
    await writeFile(
      join(root, 'app.js'),
      "const r = await fetch('/api/market'); if (r.status) fetch(`/api/stock?symbol=${'x'}`);\n",
      'utf8',
    );
    const profile = await profileProject(root);
    assert.deepEqual(profile.apiPrefixes, ['/api']);
    const note = profile.warnings.find((warning) => warning.level === 'info');
    assert.ok(note);
    assert.match(note.message, /--proxy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile warns when a directory has no HTML at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-empty-'));
  try {
    await writeFile(join(root, 'style.css'), 'h1 { color: red }\n', 'utf8');
    const profile = await profileProject(root);
    assert.equal(profile.summary.pages, 0);
    assert.ok(profile.warnings.some((warning) => /no HTML pages/.test(warning.message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registry registers, finds by name and path, and removes a project', async () => {
  await withRegistry(async () => {
    const root = await makeProject();
    try {
      const entry = await addProject(root, { profile: { summary: { pages: 1 } } });
      assert.equal(entry.root, root);
      assert.equal(entry.name, root.split('/').at(-1));

      assert.equal((await findProject(entry.id))?.root, root);
      assert.equal((await findProject(root))?.id, entry.id);
      assert.equal((await findProject(entry.name))?.id, entry.id);
      assert.equal((await listProjects()).length, 1);

      // Re-registering refreshes in place instead of duplicating.
      const again = await addProject(root, { profile: { summary: { pages: 2 } } });
      assert.equal(again.id, entry.id);
      assert.equal((await listProjects()).length, 1);
      assert.equal((await listProjects())[0].profile.summary.pages, 2);

      assert.equal((await removeProject(entry.name))?.id, entry.id);
      assert.equal(await findProject(entry.id), null);
      assert.equal(await removeProject(entry.name), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('registry writes outside the project and survives a corrupt file', async () => {
  await withRegistry(async (home) => {
    const root = await makeProject();
    try {
      await addProject(root, {});
      const registry = JSON.parse(await readFile(registryFile(), 'utf8'));
      assert.equal(registry.projects.length, 1);
      // Nothing may be written into the project itself.
      const { readdir } = await import('node:fs/promises');
      const inside = await readdir(root);
      assert.ok(!inside.some((name) => name.startsWith('.hf') || name === 'projects.json'));

      await writeFile(registryFile(), '{not json', 'utf8');
      await assert.rejects(() => listProjects(), /not valid JSON/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('api exposes the profile alongside the project inventory', async () => {
  const root = await makeProject();
  try {
    const api = createApi(root);
    const result = await api.handle('profile');
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.summary.pages, 1);
    assert.equal(result.body.rootDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('instrumentHtml never rewrites script contents', () => {
  const source = `<!doctype html><html><body><p>a</p><script>const x = "</div>";</script></body></html>`;
  const { html, instrumented } = instrumentHtml(source);
  assert.equal(instrumented, true);
  assert.ok(html.includes(`const x = "</div>";`));
  assert.ok(html.includes('/__studio/bridge.js'));
});

test('insert position and CSS declaration inputs are validated at the edge', async () => {
  const root = await makeProject();
  try {
    const { planEdits } = await import('../tools/studio/edit.mjs');
    await assert.rejects(
      () => planEdits(root, [{ op: 'insertNode', file: 'index.html', position: 'sideways', html: '<p>x</p>' }]),
      (error) => error.code === 'BAD_OP',
    );
    await assert.rejects(
      () => planEdits(root, [{ op: 'setDecl', file: 'style.css', selector: '', property: 'gap', value: '1px' }]),
      (error) => error.code === 'BAD_SELECTOR',
    );
    await assert.rejects(
      () => planEdits(root, [{ op: 'setDecl', file: 'style.css', selector: 'h1', property: 'gap;color:red', value: '1px' }]),
      (error) => error.code === 'BAD_PROPERTY',
    );
    // Custom properties stay legal.
    const ok = await planEdits(root, [{ op: 'setDecl', file: 'style.css', selector: 'h1', property: '--accent', value: 'red' }]);
    // Spacing follows the file's own convention, so match the declaration only.
    assert.match(ok.files.get('style.css').after, /--accent:\s*red;/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
