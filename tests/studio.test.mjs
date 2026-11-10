import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../tools/studio/api.mjs';
import { instrumentHtml } from '../tools/studio/server.mjs';
import { scanHtml } from '../tools/scan/html.mjs';
import { buildPageModel } from '../tools/studio/model.mjs';
import { diffLines } from '../tools/studio/edit.mjs';

const SOURCE = new URL('.', import.meta.url).pathname;

/** Depth-first node lookup on a serialized tree. */
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** Copies the demo project into a temp dir so writes never touch the repo. */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'hf-studio-'));
  for (const entry of ['index.html', 'styles', 'foundation', 'components']) {
    await cp(join(SOURCE, '..', entry), join(root, entry), { recursive: true });
  }
  return root;
}

test('api: project inventory lists pages, foundations and components', async () => {
  const root = await project();
  const api = createApi(root);
  const { status, body } = await api.handle('project');
  assert.equal(status, 200);
  assert.ok(body.pages.some((page) => page.file === 'index.html'));
  assert.ok(body.foundations.some((entry) => entry.name === 'disclosure'));
  assert.ok(body.components.some((entry) => entry.name === 'example-card'));
  await rm(root, { recursive: true, force: true });
});

test('api: page model carries tree, sheet versions and matched rules', async () => {
  const root = await project();
  const api = createApi(root);
  const { status, body } = await api.handle('page', { query: { file: '/index.html' } });
  assert.equal(status, 200);
  assert.equal(body.file, 'index.html');
  assert.equal(body.tree.tag, '#document');
  assert.ok(body.tree.children.length > 0);
  assert.ok(body.sheets.every((sheet) => typeof sheet.version === 'string' && sheet.version.startsWith('sha256:')));
  const h1 = find(body.tree, (node) => node.tag === 'h1');
  assert.ok(body.matched[h1.id].some((rule) => rule.selector === '.page__title'));
  await rm(root, { recursive: true, force: true });
});

test('api: unknown action is a 404 with a code', async () => {
  const root = await project();
  const { status, body } = await createApi(root).handle('nope');
  assert.equal(status, 404);
  assert.equal(body.code, 'NO_ROUTE');
  await rm(root, { recursive: true, force: true });
});

test('api: plan reports a diff and apply writes it, then undo restores', async () => {
  const root = await project();
  const api = createApi(root);
  const before = await readFile(join(root, 'styles/demo.css'), 'utf8');
  const model = (await api.handle('page', { query: { file: 'index.html' } })).body;
  const sheet = model.sheets.find((entry) => entry.file === 'styles/demo.css');

  const ops = [
    { op: 'setDecl', file: 'styles/demo.css', selector: '.page__title', property: 'gap', value: '3rem', version: sheet.version },
  ];

  const plan = await api.handle('plan', { body: { ops } });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.files[0].changed, true);
  assert.ok(plan.body.files[0].diff.some((line) => line.type === 'add' && line.line.includes('gap: 3rem')));
  assert.equal(await readFile(join(root, 'styles/demo.css'), 'utf8'), before, 'plan must not write');

  const applied = await api.handle('apply', { body: { ops, label: 'unit test' } });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body.written, ['styles/demo.css']);
  const after = await readFile(join(root, 'styles/demo.css'), 'utf8');
  assert.match(after, /letter-spacing: -0\.02em;\n {2}gap: 3rem;\n\}/);

  const history = await api.handle('history');
  assert.equal(history.body.snapshots[0].label, 'unit test');

  const undone = await api.handle('undo', { body: { id: applied.body.undo } });
  assert.equal(undone.status, 200);
  assert.equal(await readFile(join(root, 'styles/demo.css'), 'utf8'), before);
  await rm(root, { recursive: true, force: true });
});

test('api: a stale version is rejected with 409 and no write', async () => {
  const root = await project();
  const api = createApi(root);
  const before = await readFile(join(root, 'styles/demo.css'), 'utf8');
  const { status, body } = await api.handle('apply', {
    body: {
      ops: [{ op: 'setDecl', file: 'styles/demo.css', selector: '.page__title', property: 'gap', value: '1px', version: 'sha256:stale' }],
    },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'STALE_VERSION');
  assert.equal(await readFile(join(root, 'styles/demo.css'), 'utf8'), before);
  await rm(root, { recursive: true, force: true });
});

test('api: a syntax-breaking op is refused and nothing is written', async () => {
  const root = await project();
  const api = createApi(root);
  const model = (await api.handle('page', { query: { file: 'index.html' } })).body;
  const h1 = find(model.tree, (node) => node.tag === 'h1');

  const { status, body } = await api.handle('apply', {
    body: {
      ops: [{ op: 'insertNode', file: 'index.html', node: h1.id, position: 'append', html: '<div><span></div>', version: model.version }],
    },
  });
  assert.equal(status, 400);
  assert.equal(body.code, 'SCAN_PROBLEMS');
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), await readFile(join(SOURCE, '..', 'index.html'), 'utf8'));
  await rm(root, { recursive: true, force: true });
});

test('api: source endpoint returns text plus a version', async () => {
  const root = await project();
  const { status, body } = await createApi(root).handle('source', { query: { file: 'styles/demo.css' } });
  assert.equal(status, 200);
  assert.match(body.text, /\.page__title/);
  assert.match(body.version, /^sha256:/);
  await rm(root, { recursive: true, force: true });
});

test('instrument: every element is tagged and the bridge is injected', () => {
  const source = [
    '<!doctype html>',
    '<html>',
    '  <body>',
    '    <main>',
    '      <img src="a.png" alt="x" />',
    '      <p class="lede">Hi</p>',
    '    </main>',
    '  </body>',
    '</html>',
  ].join('\n');
  const { html, problems } = instrumentHtml(source);
  assert.deepEqual(problems, []);
  assert.match(html, /<p class="lede" data-hf-node="[^"]+">Hi<\/p>/);
  assert.match(html, /<img src="a\.png" alt="x" data-hf-node="[^"]+" \/>/);
  assert.match(html, /<script type="module" src="\/__studio\/bridge\.js"><\/script>/);
  assert.ok(html.indexOf('bridge.js') < html.lastIndexOf('</body>'));
});

test('instrument: markup with scan problems is served untouched', () => {
  const source = '<div><span></div>';
  const result = instrumentHtml(source);
  assert.equal(result.instrumented, false);
  assert.ok(result.problems.length > 0);
  assert.equal(result.html, source);
});

test('instrument: existing data-hf-node attributes are not duplicated', () => {
  const source = '<main><p data-hf-node="keep">x</p></main>';
  const { html } = instrumentHtml(source);
  assert.equal(html.match(/data-hf-node="keep"/g).length, 1);
  assert.match(html, /<main data-hf-node="[^"]+">/);
});

test('model: ids are stable across repeated scans of the same source', async () => {
  const root = await project();
  const a = await buildPageModel(root, 'index.html');
  const b = await buildPageModel(root, 'index.html');
  const ids = (tree) => {
    const out = [];
    const walk = (node) => {
      out.push(`${node.id}:${node.tag}`);
      node.children.forEach(walk);
    };
    walk(tree);
    return out;
  };
  assert.deepEqual(ids(a.tree), ids(b.tree));
  await rm(root, { recursive: true, force: true });
});

test('diff: insertion is one added line, not a delete/readd pair', () => {
  const before = 'a {\n  x: 1;\n}';
  const after = 'a {\n  x: 1;\n  y: 2;\n}';
  const lines = diffLines(before, after);
  assert.equal(lines.filter((line) => line.type === 'del').length, 0);
  assert.deepEqual(
    lines.filter((line) => line.type === 'add').map((line) => line.line.trim()),
    ['y: 2;'],
  );
});

test('diff: far-apart hunks are separated by a gap marker', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 1\n', 'line 1 changed\n').replace('line 28', 'line 28 changed');
  const lines = diffLines(before, after, 1);
  assert.ok(lines.some((line) => line.type === 'gap'));
  assert.equal(lines.filter((line) => line.type === 'del').length, 2);
});

test('scan: self-closing tags keep their attributes', () => {
  const tree = scanHtml('<input type="text" name="q" /><br class="x" />');
  const [input, br] = tree.nodes;
  assert.deepEqual(input.attrs.map((attr) => [attr.name, attr.value]), [['type', 'text'], ['name', 'q']]);
  assert.deepEqual(br.attrs.map((attr) => [attr.name, attr.value]), [['class', 'x']]);
  assert.equal(input.selfClosing, true);
});

test('ops: layout edits carry a disk precondition, not the pending value', async () => {
  const { layoutOps } = await import('../studio/ops.js');
  const onDisk = { gap: '1.25rem' };
  const first = layoutOps({ file: 'a.css', selector: '.g', decls: { gap: '2rem' }, previous: onDisk });
  const second = layoutOps({ file: 'a.css', selector: '.g', decls: { gap: '3rem' }, previous: onDisk });
  assert.equal(first[0].expect, '1.25rem');
  assert.equal(second[0].expect, '1.25rem', 'a second edit must still expect the on-disk value');
  assert.equal(second[0].value, '3rem');
});

test('ops: clearing a declaration becomes removeDecl, setting it back is a no-op', async () => {
  const { layoutOps } = await import('../studio/ops.js');
  const onDisk = { gap: '1.25rem' };
  assert.deepEqual(layoutOps({ file: 'a.css', selector: '.g', decls: { gap: '' }, previous: onDisk }).map((op) => op.op), ['removeDecl']);
  assert.deepEqual(layoutOps({ file: 'a.css', selector: '.g', decls: { gap: '1.25rem' }, previous: onDisk }), []);
  assert.deepEqual(layoutOps({ file: 'a.css', selector: '.g', decls: { gap: '2rem' }, previous: onDisk }).length, 1);
});

test('ops: component props remove default values and keep booleans boolean', async () => {
  const { propsOps } = await import('../studio/ops.js');
  const ops = propsOps({
    file: 'index.html',
    nodeId: '1.2',
    props: { title: 'New', open: true },
    previous: { title: 'Old', open: false },
    defaults: { title: 'Example card', density: 'compact', open: false },
  });
  assert.deepEqual(
    ops.map((op) => [op.op, op.name, op.value]),
    [
      ['setAttr', 'title', 'New'],
      ['setAttr', 'open', true],
    ],
  );
  const cleared = propsOps({
    file: 'index.html',
    nodeId: '1.2',
    props: { title: 'Example card' },
    previous: { title: 'Old' },
    defaults: { title: 'Example card' },
  });
  assert.deepEqual(cleared.map((op) => [op.op, op.name]), [['removeAttr', 'title']]);
});

test('ops: unknown frame presets are rejected', async () => {
  const { frameOps } = await import('../studio/ops.js');
  assert.throws(() => frameOps({ file: 'index.html', targetId: '0.0.1', presetId: 'nope' }), /unknown frame preset/);
});

test('server: serves the studio, an instrumented page, and the JSON API', async () => {
  const { startStudio } = await import('../tools/studio/server.mjs');
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const shell = await fetch(`${studio.url}`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /web-page-helper studio/);

    const css = await fetch(`http://${studio.host}:${studio.port}/__studio/studio.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const page = await fetch(`http://${studio.host}:${studio.port}/index.html`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-hf-node="/);
    assert.match(html, /\/__studio\/bridge\.js/);

    const api = await fetch(`http://${studio.host}:${studio.port}/__api/project`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).pages[0].file, 'index.html');
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('server: the API writes through HTTP and undo restores over HTTP', async () => {
  const { startStudio } = await import('../tools/studio/server.mjs');
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  const base = `http://${studio.host}:${studio.port}`;
  try {
    const before = await readFile(join(root, 'styles/demo.css'), 'utf8');
    const model = await (await fetch(`${base}/__api/page?file=index.html`)).json();
    const sheet = model.sheets.find((entry) => entry.file === 'styles/demo.css');

    const applied = await fetch(`${base}/__api/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'http test',
        ops: [{ op: 'setDecl', file: 'styles/demo.css', selector: '.page__title', property: 'gap', value: '4rem', version: sheet.version }],
      }),
    });
    assert.equal(applied.status, 200);
    const result = await applied.json();
    assert.deepEqual(result.written, ['styles/demo.css']);
    assert.match(await readFile(join(root, 'styles/demo.css'), 'utf8'), /gap: 4rem;/);

    const undone = await fetch(`${base}/__api/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: result.undo }),
    });
    assert.equal(undone.status, 200);
    assert.equal(await readFile(join(root, 'styles/demo.css'), 'utf8'), before);
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('server: a bad request body is a 400, not a crash', async () => {
  const { startStudio } = await import('../tools/studio/server.mjs');
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const response = await fetch(`http://${studio.host}:${studio.port}/__api/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'BAD_JSON');

    const missing = await fetch(`http://${studio.host}:${studio.port}/missing.css`);
    assert.equal(missing.status, 404);
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cli: `studio` targets the current directory by default', async () => {
  const { execFile } = await import('node:child_process');
  const cli = new URL('../tools/cli.mjs', import.meta.url).pathname;
  const root = await project();
  try {
    // Port 0 keeps the check free of port collisions; the server prints the URL
    // it actually bound, which is where the project path is reported.
    const child = execFile(process.execPath, [cli, 'studio', '--port', '0'], { cwd: root });
    const line = await new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => rejectLine(new Error('studio did not report its project root')), 10_000);
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/project (.+)/);
        if (!match) return;
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolveLine(match[1].trim());
      });
      child.on('error', rejectLine);
    });
    assert.equal(line, root, 'the studio must edit the directory it was started in');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server: text responses are compressed and validated, so a reload is cheap', async () => {
  const { startStudio } = await import('../tools/studio/server.mjs');
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  const base = `http://${studio.host}:${studio.port}`;
  try {
    const page = await fetch(`${base}/__api/page?file=index.html`, {
      headers: { 'Accept-Encoding': 'br' },
    });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-encoding'), 'br', 'large JSON must not cross the wire whole');
    const etag = page.headers.get('etag');
    assert.ok(etag, 'a deterministic response needs a validator');
    assert.match(page.headers.get('cache-control'), /no-cache/, 'the model may be stale after a save');
    await page.arrayBuffer();

    const revalidated = await fetch(`${base}/__api/page?file=index.html`, {
      headers: { 'Accept-Encoding': 'br', 'If-None-Match': etag },
    });
    assert.equal(revalidated.status, 304, 'an unchanged response must not be re-sent');
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0);

    // A client that advertises nothing must still get a usable body. Node's
    // fetch adds `Accept-Encoding: gzip` on its own, so opt out explicitly.
    const identity = await fetch(`${base}/__api/page?file=index.html`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    assert.equal(identity.headers.get('content-encoding'), null);
    assert.equal((await identity.json()).ok, true);

    const asset = await fetch(`${base}/__studio/panel.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(asset.headers.get('content-encoding'), 'gzip');
    const assetEtag = asset.headers.get('etag');
    await asset.arrayBuffer();
    const cached = await fetch(`${base}/__studio/panel.js`, { headers: { 'If-None-Match': assetEtag } });
    assert.equal(cached.status, 304);
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('server: the shell inlines the project inventory and names the module graph', async () => {
  const { startStudio } = await import('../tools/studio/server.mjs');
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const html = await (await fetch(`${studio.url}`)).text();
    // The inventory is inlined so the shell does not spend a round trip
    // before it can render the first tree.
    const boot = html.match(/<script type="application\/json" id="hf-boot">([\s\S]*?)<\/script>/);
    assert.ok(boot, 'the shell must carry the boot inventory');
    const inventory = JSON.parse(boot[1]);
    assert.equal(inventory.pages[0].file, 'index.html');
    // `</script>` inside the payload would end the tag early.
    assert.doesNotMatch(boot[1], /<\/script/i);
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('instrumentHtml: preloads the preview module graph and its component styles', async () => {
  const { instrumentHtml } = await import('../tools/studio/server.mjs');
  const source = `<!doctype html><html><head><title>x</title></head><body><p>hi</p><script type="module" src="/runtime/index.js"></script></body></html>`;
  const { html } = instrumentHtml(source, {
    preloads: ['/runtime/index.js', '/foundation/core.js'],
    styles: ['/components/card/card.css'],
  });
  assert.match(html, /<link rel="modulepreload" href="\/runtime\/index\.js">/);
  assert.match(html, /<link rel="modulepreload" href="\/foundation\/core\.js">/);
  assert.match(html, /<link rel="preload" as="style" href="\/components\/card\/card\.css">/);
  // The bridge is a deferred module, so it belongs in <head> where the fetch
  // starts immediately instead of at the end of the body.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /\/__studio\/bridge\.js/);
});

test('server: the preview page preloads the module graph it will fetch', async () => {
  const { startStudio } = await import('../tools/studio/server.mjs');
  const root = await project();
  // A page whose module entry imports a second module: the walker has to
  // follow the edge, or the browser pays a serial round trip for it.
  await mkdir(join(root, 'runtime'), { recursive: true });
  await writeFile(
    join(root, 'runtime', 'index.js'),
    `import { foundations } from '../foundation/index.js';\nexport const start = () => foundations;\n`,
  );
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const html = await (await fetch(`http://${studio.host}:${studio.port}/index.html`)).text();
    const preloads = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(preloads.includes('/runtime/index.js'), `entry missing from ${JSON.stringify(preloads)}`);
    assert.ok(preloads.includes('/foundation/index.js'), 'a module imported by the entry was not preloaded');
    assert.ok(preloads.includes('/foundation/core.js'), 'a transitive module was not preloaded');
    assert.ok(!preloads.some((href) => href.endsWith('.css')), 'stylesheets need rel=preload as=style');
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});
