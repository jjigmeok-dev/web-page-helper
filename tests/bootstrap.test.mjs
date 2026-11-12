import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, planEdits } from '../tools/studio/edit.mjs';
import { buildPageModel } from '../tools/studio/model.mjs';
import { frameOps, framePreset } from '../studio/ops.js';
import { layoutOps } from '../studio/ops.js';

/**
 * Pages that have no DOM to speak of. A frontend tool is only useful on an
 * empty file if it can create the structure the user is asking for.
 */
const SHAPES = {
  'empty file': '',
  'bare text': 'Hello\n',
  'fragment': '<div>a</div>\n<p>b</p>\n',
  'html without body': '<!doctype html>\n<html><head><title>N</title></head>\n<p>bare</p>\n</html>\n',
  'self-closing body': '<!doctype html><html><head><title>S</title></head><body /></html>',
  'empty body': '<!doctype html>\n<html><head><title>E</title></head><body></body></html>\n',
};

async function withPage(html, run) {
  const root = await mkdtemp(join(tmpdir(), 'hf-boot-'));
  await writeFile(join(root, 'index.html'), html);
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const flatten = (node, out = []) => {
  out.push(node);
  node.children.forEach((child) => flatten(child, out));
  return out;
};

for (const [name, html] of Object.entries(SHAPES)) {
  test(`a frame can be applied to a page with ${name}`, async () => {
    await withPage(html, async (root) => {
      const model = await buildPageModel(root, 'index.html');
      const body = flatten(model.tree).find((node) => node.tag === 'body');
      const preset = framePreset('header-main-footer');
      const ops = body
        ? frameOps({ file: 'index.html', version: model.version, targetId: body.id, presetId: preset.id }).ops
        : [{ op: 'frameDocument', file: 'index.html', version: model.version, html: preset.html }];

      const result = await applyEdits(root, ops);
      assert.deepEqual(result.written, ['index.html']);

      // The result must be a page the editor can keep working on.
      const after = await buildPageModel(root, 'index.html');
      assert.deepEqual(after.problems, []);
      const nodes = flatten(after.tree);
      const main = nodes.find((node) => node.tag === 'main');
      assert.ok(main, 'the frame main element must exist');
      assert.ok(main.classes.includes('layout__main'));

      // Existing content must be preserved, not dropped.
      if (html.includes('Hello')) assert.match(await readFile(join(root, 'index.html'), 'utf8'), /Hello/);
      if (html.includes('<div>a</div>')) {
        const text = await readFile(join(root, 'index.html'), 'utf8');
        assert.match(text, /<div>a<\/div>/);
        assert.match(text, /<p>b<\/p>/);
      }
    });
  });
}

test('a layout edit creates style.css when the page links no stylesheet', async () => {
  await withPage('<!doctype html>\n<html><head><title>N</title></head><body><h1>Hi</h1></body></html>\n', async (root) => {
    const model = await buildPageModel(root, 'index.html');
    assert.equal(model.sheets.length, 0);

    const ops = layoutOps({ file: 'style.css', version: null, selector: 'h1', decls: { gap: '1rem' }, createFile: true });
    const result = await applyEdits(root, ops);
    assert.deepEqual(result.written, ['style.css']);
    assert.match(await readFile(join(root, 'style.css'), 'utf8'), /h1 \{[\s\S]*gap: 1rem;/);
  });
});

test('a file is never created implicitly', async () => {
  await withPage('<!doctype html><html><body><h1>x</h1></body></html>', async (root) => {
    await assert.rejects(
      () => planEdits(root, [{ op: 'setDecl', file: 'missing.css', selector: 'h1', property: 'gap', value: '1px' }]),
      (error) => error.code === 'MISSING',
    );
    // Only stylesheets may be created; an op cannot invent markup files.
    await assert.rejects(
      () => planEdits(root, [{ op: 'setDecl', file: 'missing.html', selector: 'h1', property: 'gap', value: '1px', createFile: true }]),
      (error) => error.code === 'MISSING' || error.code === 'BAD_FILE',
    );
  });
});

test('frameDocument refuses a page that already has a body', async () => {
  await withPage('<!doctype html><html><body><p>x</p></body></html>', async (root) => {
    const model = await buildPageModel(root, 'index.html');
    const preset = framePreset('sidebar-main');
    await assert.rejects(
      () => planEdits(root, [{ op: 'frameDocument', file: 'index.html', version: model.version, html: preset.html }]),
      (error) => error.code === 'BAD_NODE',
    );
  });
});

/**
 * One panel edit commonly turns into several declarations for one selector.
 * When the rule does not exist yet, the second op must extend the block the
 * first created instead of rewriting it — otherwise `display: flex`
 * disappears and only the last declaration survives.
 */
test('several declarations for a brand-new rule all land in it', async () => {
  await withPage('<!doctype html><html><head><title>T</title></head><body><div class="row"></div></body></html>', async (root) => {
    await writeFile(join(root, 'style.css'), '.a { color: red; }\n');
    const ops = [
      { op: 'setDecl', file: 'style.css', selector: '.row', property: 'display', value: 'flex', create: true },
      { op: 'setDecl', file: 'style.css', selector: '.row', property: 'gap', value: '0.75rem', create: true },
      { op: 'setDecl', file: 'style.css', selector: '.row', property: 'padding', value: '1rem', create: true },
    ];
    await applyEdits(root, ops);

    const css = await readFile(join(root, 'style.css'), 'utf8');
    assert.equal(css.match(/\.row \{/g).length, 1, 'the rule is created once');
    assert.match(css, /display: flex;/);
    assert.match(css, /gap: 0\.75rem;/);
    assert.match(css, /padding: 1rem;/);
    // Nothing else in the file may be duplicated by the batching.
    assert.equal(css.match(/\.a \{/g).length, 1);
  });
});

test('duplicate declarations for one property keep a single value', async () => {
  await withPage('<!doctype html><html><head><title>T</title></head><body><div class="row"></div></body></html>', async (root) => {
    await writeFile(join(root, 'style.css'), '.row { display: block; }\n');
    await applyEdits(root, [
      { op: 'setDecl', file: 'style.css', selector: '.row', property: 'display', value: 'flex', create: true },
      { op: 'setDecl', file: 'style.css', selector: '.row', property: 'display', value: 'grid', create: true },
    ]);
    const css = await readFile(join(root, 'style.css'), 'utf8');
    assert.equal(css.match(/display:/g).length, 1);
    assert.match(css, /display: grid;/);
  });
});
