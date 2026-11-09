import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanHtml } from '../tools/scan/html.mjs';
import { scanCss, findDecl, rulesFor } from '../tools/scan/css.mjs';
import { planEdits, applyEdits, diffLines } from '../tools/studio/edit.mjs';
import { attrOp } from '../studio/ops.js';
import { createSnapshot, undo, listSnapshots } from '../tools/studio/journal.mjs';
import { buildPageModel } from '../tools/studio/model.mjs';

/**
 * The edit engine is the only code that touches user files, so these tests
 * check bytes, not just behavior: the untouched parts of every file must be
 * identical after an edit.
 */

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Test</title>
    <link rel="stylesheet" href="/styles/app.css" />
  </head>
  <body>
    <main class="page">
      <h1 class="title">Hello</h1>
      <p class="lede">Text</p>
      <div data-hf="disclosure" data-hf-options='{"defaultOpen":true}'>
        <button data-hf-part="trigger">More</button>
        <div data-hf-part="panel">Body</div>
      </div>
    </main>
  </body>
</html>
`;

const CSS = `:root {
  --hf-accent: #4f46e5;
}

.page {
  display: grid;
  gap: 1rem;
}

.title {
  font-size: 2rem;
}
`;

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'hf-studio-'));
  await mkdir(join(root, 'styles'), { recursive: true });
  await writeFile(join(root, 'index.html'), PAGE, 'utf8');
  await writeFile(join(root, 'styles/app.css'), CSS, 'utf8');
  return root;
}

/** Node ids depend on document structure; resolve them instead of hardcoding. */
async function nodes(root, rel = 'index.html') {
  const { text } = { text: await readFile(join(root, rel), 'utf8') };
  const tree = scanHtml(text);
  const by = (predicate, nth = 0) => tree.nodes.filter(predicate)[nth]?.id;
  return {
    tree,
    byTag: (tag, nth = 0) => by((node) => node.tag === tag, nth),
    byClass: (name, nth = 0) => by((node) => (node.attrs.find((a) => a.name === 'class')?.value ?? '').split(/\s+/).includes(name), nth),
    byAttr: (name, value, nth = 0) => by((node) => node.attrs.some((a) => a.name === name && (value === undefined || a.value === value)), nth),
  };
}

test('scanner: exact ranges for tags, attributes, inner and close', () => {
  const tree = scanHtml(PAGE);
  assert.deepEqual(tree.problems, []);
  const h1 = tree.nodes.find((node) => node.tag === 'h1');
  assert.equal(PAGE.slice(h1.open.start, h1.open.end), '<h1 class="title">');
  assert.equal(PAGE.slice(h1.inner.start, h1.inner.end), 'Hello');
  assert.equal(PAGE.slice(h1.close.start, h1.close.end), '</h1>');
  const cls = h1.attrs.find((entry) => entry.name === 'class');
  assert.equal(PAGE.slice(cls.valueStart, cls.valueEnd), 'title');

  const disclosure = tree.nodes.find((node) => node.tag === 'div' && node.attrs.some((a) => a.name === 'data-hf'));
  const options = disclosure.attrs.find((entry) => entry.name === 'data-hf-options');
  assert.equal(options.quote, "'");
  assert.equal(PAGE.slice(options.valueStart, options.valueEnd), '{"defaultOpen":true}');
});

test('scanner: reports implicit closes and stray tags instead of guessing', () => {
  const broken = scanHtml('<div><p>x</div>');
  assert.ok(broken.problems.some((problem) => problem.message.includes('implicitly closed')));
  const stray = scanHtml('</span>');
  assert.ok(stray.problems.some((problem) => problem.message.includes('stray')));
  const unclosed = scanHtml('<div>');
  assert.ok(unclosed.problems.some((problem) => problem.message.includes('never closed')));
});

test('scanner: handles void elements, raw text and comments', () => {
  const source = `<!-- <div> --><img src="a.png"><script>if (a < b) {}</script><br/>`;
  const tree = scanHtml(source);
  assert.deepEqual(tree.problems, []);
  const img = tree.nodes.find((node) => node.tag === 'img');
  assert.equal(img.void, true);
  const script = tree.nodes.find((node) => node.tag === 'script');
  assert.equal(source.slice(script.inner.start, script.inner.end), 'if (a < b) {}');
  const br = tree.nodes.find((node) => node.tag === 'br');
  assert.equal(br.void, true);
});

test('css scanner: rules, declarations, nested at-rules and tokens', () => {
  const css = scanCss(`@media (min-width: 40rem) {
  .panel { gap: 2rem; }
}
.a, .b { color: red; }
:root { --x: 1px; }
`);
  assert.deepEqual(css.problems, []);
  const panel = css.rules.find((rule) => rule.selector === '.panel');
  assert.ok(panel, 'rule inside @media is found');
  assert.equal(findDecl(panel, 'gap').value, '2rem');
  assert.equal(css.customProps[0].name, '--x');
  assert.equal(rulesFor(css, '.a').length, 1, 'comma selector matches by member');
});

test('setAttr: rewrites only the attribute span, preserving formatting', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const result = await applyEdits(root, [{ op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'class', value: 'headline' }]);
  const after = await readFile(join(root, 'index.html'), 'utf8');
  assert.equal(after, PAGE.replace('<h1 class="title">', '<h1 class="headline">'));
  assert.equal(result.files[0].changed, true);
  await rm(root, { recursive: true, force: true });
});

test('setAttr: adds, updates boolean and removes attributes cleanly', async () => {
  const root = await project();
  const { byTag, byAttr } = await nodes(root);
  const h1 = byTag('h1');
  await applyEdits(root, [
    { op: 'setAttr', file: 'index.html', node: h1, name: 'data-active', value: '' },
    { op: 'setAttr', file: 'index.html', node: byTag('p'), name: 'data-hf-options', value: '{"defaultOpen":false}' },
    { op: 'setAttr', file: 'index.html', node: h1, name: 'hidden', value: true },
  ]);
  let html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<h1 class="title" data-active="" hidden>Hello<\/h1>/);
  assert.match(html, /<p class="lede" data-hf-options="\{&quot;defaultOpen&quot;:false\}">/);

  await applyEdits(root, [{ op: 'removeAttr', file: 'index.html', node: h1, name: 'hidden' }]);
  html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<h1 class="title" data-active="">Hello<\/h1>/);
  await rm(root, { recursive: true, force: true });
});

test('setAttr: escaping prevents markup injection', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await applyEdits(root, [{ op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'title', value: '"><script>x</script>' }]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('<script>x</script>'), 'value was escaped');
  const tree = scanHtml(html);
  assert.deepEqual(tree.problems, []);
  const h1 = tree.nodes.find((node) => node.tag === 'h1');
  assert.equal(h1.attrs.find((a) => a.name === 'title').value, '&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
  await rm(root, { recursive: true, force: true });
});

test('setAttr: a stale expectation aborts the whole batch with no writes', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await assert.rejects(
    applyEdits(root, [
      { op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'class', value: 'a', expect: 'wrong' },
      { op: 'setAttr', file: 'index.html', node: byTag('p'), name: 'class', value: 'b' },
    ]),
    (error) => error.code === 'PRECONDITION',
  );
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), PAGE, 'file is untouched');
  await rm(root, { recursive: true, force: true });
});

test('setText: keeps surrounding whitespace and escapes content', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await applyEdits(root, [{ op: 'setText', file: 'index.html', node: byTag('h1'), value: 'Hi <b>there</b>' }]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<h1 class="title">Hi &lt;b&gt;there&lt;\/b&gt;<\/h1>/);
  await rm(root, { recursive: true, force: true });
});

test('setText: refuses a node that has child elements', async () => {
  const root = await project();
  const { byAttr } = await nodes(root);
  await assert.rejects(
    applyEdits(root, [{ op: 'setText', file: 'index.html', node: byAttr('data-hf'), value: 'x' }]),
    (error) => error.code === 'NOT_A_LEAF',
  );
  await rm(root, { recursive: true, force: true });
});

test('insertNode: appends inside a node with matching indentation', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await applyEdits(root, [
    { op: 'insertNode', file: 'index.html', node: byTag('main'), position: 'append', html: '<p class="new">New</p>' },
  ]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /      <p class="new">New<\/p>\n    <\/main>/);
  assert.deepEqual(scanHtml(html).problems, []);
  await rm(root, { recursive: true, force: true });
});

test('insertNode: before/after insert on their own line', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const h1 = byTag('h1');
  await applyEdits(root, [
    { op: 'insertNode', file: 'index.html', node: h1, position: 'before', html: '<p id="lead">Lead</p>' },
    { op: 'insertNode', file: 'index.html', node: h1, position: 'after', html: '<p id="trail">Trail</p>' },
  ]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<p id="lead">Lead<\/p>\n      <h1 class="title">Hello<\/h1>/);
  assert.match(html, /<\/h1>\n      <p id="trail">Trail<\/p>/);
  assert.deepEqual(scanHtml(html).problems, []);
  await rm(root, { recursive: true, force: true });
});

test('insertNode: rejects malformed markup before writing', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await assert.rejects(
    applyEdits(root, [{ op: 'insertNode', file: 'index.html', node: byTag('main'), html: '<p>unclosed' }]),
    (error) => error.code === 'SCAN_PROBLEMS',
  );
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), PAGE);
  await rm(root, { recursive: true, force: true });
});

test('removeNode: removes whole lines when the node stands alone', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await applyEdits(root, [{ op: 'removeNode', file: 'index.html', node: byTag('p') }]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('class="lede"'));
  assert.ok(!html.includes('\n\n\n'), 'no blank line left behind');
  await rm(root, { recursive: true, force: true });
});

test('moveNode: relocates a node without corrupting the document', async () => {
  const root = await project();
  const { byTag, byAttr } = await nodes(root);
  await applyEdits(root, [
    { op: 'moveNode', file: 'index.html', node: byAttr('data-hf'), target: byTag('main'), position: 'prepend' },
  ]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const tree = scanHtml(html);
  assert.deepEqual(tree.problems, []);
  const main = tree.nodes.find((node) => node.tag === 'main');
  assert.equal(main.children[0].attrs.find((a) => a.name === 'data-hf').value, 'disclosure');
  assert.equal(tree.nodes.filter((node) => node.attrs.some((a) => a.name === 'data-hf')).length, 1);
  await rm(root, { recursive: true, force: true });
});

test('moveNode: refuses moving a node into its own subtree', async () => {
  const root = await project();
  const { byTag, byAttr } = await nodes(root);
  await assert.rejects(
    applyEdits(root, [{ op: 'moveNode', file: 'index.html', node: byTag('main'), target: byAttr('data-hf') }]),
    (error) => error.code === 'BAD_OP',
  );
  await rm(root, { recursive: true, force: true });
});

test('wrapNode: wraps an existing node in a single element', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await applyEdits(root, [{ op: 'wrapNode', file: 'index.html', node: byTag('h1'), html: '<div class="wrap">' }]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  // The wrapped node moves one level deeper, so its indent grows by one step.
  assert.match(html, /<div class="wrap">\n        <h1 class="title">Hello<\/h1>\n      <\/div>/);
  assert.deepEqual(scanHtml(html).problems, []);
  await rm(root, { recursive: true, force: true });
});

test('setDecl: updates an existing declaration in place', async () => {
  const root = await project();
  await applyEdits(root, [{ op: 'setDecl', file: 'styles/app.css', selector: '.page', property: 'gap', value: '2rem' }]);
  const css = await readFile(join(root, 'styles/app.css'), 'utf8');
  assert.equal(css, CSS.replace('gap: 1rem;', 'gap: 2rem;'));
  await rm(root, { recursive: true, force: true });
});

test('setDecl: adds a new declaration at the end of the rule body', async () => {
  const root = await project();
  await applyEdits(root, [
    { op: 'setDecl', file: 'styles/app.css', selector: '.page', property: 'padding', value: '2rem' },
  ]);
  const css = await readFile(join(root, 'styles/app.css'), 'utf8');
  const tree = scanCss(css);
  assert.deepEqual(tree.problems, []);
  const rule = rulesFor(tree, '.page')[0];
  assert.equal(findDecl(rule, 'padding').value, '2rem');
  assert.equal(findDecl(rule, 'gap').value, '1rem', 'existing declaration preserved');
  await rm(root, { recursive: true, force: true });
});

test('setDecl: creates a rule when none matches, only if allowed', async () => {
  const root = await project();
  await applyEdits(root, [
    { op: 'setDecl', file: 'styles/app.css', selector: '.brand', property: 'color', value: 'tomato' },
  ]);
  const css = await readFile(join(root, 'styles/app.css'), 'utf8');
  assert.match(css, /\.brand \{\n {2}color: tomato;\n\}\n$/);
  assert.deepEqual(scanCss(css).problems, []);

  await assert.rejects(
    applyEdits(root, [
      { op: 'setDecl', file: 'styles/app.css', selector: '.other', property: 'color', value: 'red', create: false },
    ]),
    (error) => error.code === 'NO_RULE',
  );
  await rm(root, { recursive: true, force: true });
});

test('removeDecl: drops a declaration line without leaving blanks', async () => {
  const root = await project();
  await applyEdits(root, [{ op: 'removeDecl', file: 'styles/app.css', selector: '.page', property: 'gap' }]);
  const css = await readFile(join(root, 'styles/app.css'), 'utf8');
  assert.equal(css, CSS.replace('  gap: 1rem;\n', ''));
  await rm(root, { recursive: true, force: true });
});

test('version fence: a stale version rejects the save and writes nothing', async () => {
  const root = await project();
  const stale = 'sha256:00000000000000000000000000000000';
  await assert.rejects(
    applyEdits(root, [
      { op: 'setAttr', file: 'index.html', node: '0.1.0', name: 'class', value: 'x', version: stale },
    ]),
    (error) => error.code === 'STALE_VERSION',
  );
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), PAGE);
  await rm(root, { recursive: true, force: true });
});

test('path guard: refuses escapes and denied directories', async () => {
  const root = await project();
  for (const file of ['../outside.html', '/etc/passwd', '.hf/journal.jsonl', 'node_modules/x.html', 'a/../../b.html']) {
    await assert.rejects(
      planEdits(root, [{ op: 'setAttr', file, node: '0.1', name: 'x', value: 'y' }]),
      (error) => ['OUT_OF_ROOT', 'DENY_PATH', 'BAD_PATH'].includes(error.code),
      file,
    );
  }
  await rm(root, { recursive: true, force: true });
});

test('atomic batch: a failure in op 2 leaves op 1 unapplied', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await assert.rejects(
    applyEdits(root, [
      { op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'class', value: 'changed' },
      { op: 'setAttr', file: 'index.html', node: '0.9.9', name: 'class', value: 'nope' },
    ]),
    (error) => error.code === 'NODE_NOT_FOUND',
  );
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), PAGE);
  await rm(root, { recursive: true, force: true });
});

test('multi-file batch: page and stylesheet change together', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const result = await applyEdits(root, [
    { op: 'setDecl', file: 'styles/app.css', selector: '.page', property: 'gap', value: '3rem' },
    { op: 'setAttr', file: 'index.html', node: byTag('main'), name: 'data-layout', value: 'wide' },
  ]);
  assert.deepEqual(result.written.sort(), ['index.html', 'styles/app.css']);
  assert.ok(result.diff['styles/app.css'].some((line) => line.type === 'add' && line.line.includes('3rem')));
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<main class="page" data-layout="wide">/);
  await rm(root, { recursive: true, force: true });
});

test('applyEdits: unchanged ops produce no write', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const result = await applyEdits(root, [{ op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'class', value: 'title' }]);
  assert.equal(result.written.length, 0);
  assert.equal(result.files[0].changed, false);
  await rm(root, { recursive: true, force: true });
});

test('journal: undo restores the exact previous bytes', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const snapshot = await createSnapshot(root, 'test edit');
  await applyEdits(
    root,
    [{ op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'class', value: 'changed' }],
    { snapshot: (rel, before, after) => snapshot.save(rel, before, after) },
  );
  await snapshot.finish('test edit');

  assert.notEqual(await readFile(join(root, 'index.html'), 'utf8'), PAGE);
  const result = await undo(root);
  assert.deepEqual(result.restored, ['index.html']);
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), PAGE);
  await rm(root, { recursive: true, force: true });
});

test('journal: undo refuses when a file changed after the edit', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const snapshot = await createSnapshot(root, 'edit');
  await applyEdits(
    root,
    [{ op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'class', value: 'changed' }],
    { snapshot: (rel, before, after) => snapshot.save(rel, before, after) },
  );
  await snapshot.finish('edit');

  await writeFile(join(root, 'index.html'), `${PAGE}<!-- external -->`, 'utf8');
  await assert.rejects(undo(root), (error) => error.code === 'STALE_UNDO');
  await rm(root, { recursive: true, force: true });
});

test('journal: lists recent snapshots and undo walks backwards', async () => {
  const root = await project();
  for (const name of ['first', 'second']) {
    const { byTag } = await nodes(root);
    const snapshot = await createSnapshot(root, name);
    await applyEdits(
      root,
      [{ op: 'setAttr', file: 'index.html', node: byTag('h1'), name: 'title', value: name }],
      { snapshot: (rel, before, after) => snapshot.save(rel, before, after) },
    );
    await snapshot.finish(name);
  }
  const list = await listSnapshots(root);
  assert.deepEqual(list.map((entry) => entry.label), ['second', 'first']);
  await undo(root);
  assert.match(await readFile(join(root, 'index.html'), 'utf8'), /title="first"/);
  await undo(root);
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), PAGE);
  await assert.rejects(undo(root), (error) => error.code === 'NO_UNDO');
  await rm(root, { recursive: true, force: true });
});

test('model: matched rules, tokens and component classification on a real page', async () => {
  const root = await project();
  await mkdir(join(root, 'components/card'), { recursive: true });
  await writeFile(
    join(root, 'components/card/card.js'),
    `export default { __hfDefinition: true, name: 'card', tag: 'hf-card', props: { title: 'T' }, template: '<div data-hf-slot="default"></div>', styles: null };\n`,
  );
  const html = PAGE.replace(
    '<p class="lede">Text</p>',
    '<hf-card title="T"></hf-card>',
  );
  await writeFile(join(root, 'index.html'), html, 'utf8');
  const model = await buildPageModel(root, 'index.html');
  const flat = [];
  (function walk(node) {
    flat.push(node);
    node.children.forEach(walk);
  })(model.tree);

  const h1 = flat.find((node) => node.tag === 'h1');
  assert.ok(model.matched[h1.id].some((rule) => rule.selector === '.title'), 'title rule matched');
  const card = flat.find((node) => node.tag === 'hf-card');
  assert.equal(card.component.kind, 'component');
  assert.equal(card.component.name, 'card');
  assert.deepEqual(card.component.props, { title: 'T' });
  const disclosure = flat.find((node) => node.component.kind === 'foundation');
  assert.equal(disclosure.component.name, 'disclosure');
  assert.deepEqual(disclosure.component.options, { defaultOpen: true });
  assert.ok(model.tokens.some((group) => group.group === 'hf'));
  await rm(root, { recursive: true, force: true });
});

test('insertNode: appended snippets are re-indented for the destination', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  // The panel sends snippets with their own relative nesting.
  const snippet = '<div data-hf="toggle">\n  <button data-hf-part="control">Pin</button>\n</div>';
  await applyEdits(root, [{ op: 'insertNode', file: 'index.html', node: byTag('main'), position: 'append', html: snippet }]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /      <div data-hf="toggle">\n        <button data-hf-part="control">Pin<\/button>\n      <\/div>\n    <\/main>/);
  assert.equal(scanHtml(html).problems.length, 0);
  await rm(root, { recursive: true, force: true });
});

test('insertNode: appending into a populated container adds no blank line', async () => {
  const root = await project();
  const { byAttr } = await nodes(root);
  await applyEdits(root, [
    {
      op: 'insertNode',
      file: 'index.html',
      node: byAttr('data-hf', 'disclosure'),
      position: 'append',
      html: '<p class="extra">Extra</p>',
    },
  ]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<div data-hf-part="panel">Body<\/div>\n        <p class="extra">Extra<\/p>\n      <\/div>/);
  assert.doesNotMatch(html, /\n {2,}\n/);
  await rm(root, { recursive: true, force: true });
});

test('moveNode: the moved node keeps the destination indentation', async () => {
  const root = await project();
  const { byTag, byAttr } = await nodes(root);
  await applyEdits(root, [
    { op: 'moveNode', file: 'index.html', node: byTag('h1'), target: byAttr('data-hf', 'disclosure'), position: 'append' },
  ]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<div data-hf-part="panel">Body<\/div>\n        <h1 class="title">Hello<\/h1>\n      <\/div>/);
  assert.doesNotMatch(html, /\n {2,}\n/);
  assert.equal(scanHtml(html).problems.length, 0);
  await rm(root, { recursive: true, force: true });
});

test('frameNode: wraps the container children and drops the slot marker', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const frame = [
    '<div class="layout">',
    '  <header class="layout__header">Header</header>',
    '  <main class="layout__main" data-hf-frame-slot></main>',
    '  <footer class="layout__footer">Footer</footer>',
    '</div>',
  ].join('\n');
  await applyEdits(root, [{ op: 'frameNode', file: 'index.html', node: byTag('main'), html: frame }]);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<main class="page">\n      <div class="layout">\n        <header class="layout__header">Header<\/header>\n        <main class="layout__main">/);
  assert.match(html, /<h1 class="title">Hello<\/h1>/);
  assert.doesNotMatch(html, /data-hf-frame-slot/);
  assert.equal(scanHtml(html).problems.length, 0);
  await rm(root, { recursive: true, force: true });
});

test('frameNode: a frame without a slot is rejected', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  await assert.rejects(
    () => applyEdits(root, [{ op: 'frameNode', file: 'index.html', node: byTag('main'), html: '<div class="x"></div>' }]),
    (error) => error.code === 'BAD_OP',
  );
  await rm(root, { recursive: true, force: true });
});

test('duplicateNode: copies the node in place with sibling indentation', async () => {
  const root = await project();
  const { byClass, byTag, tree } = await nodes(root);
  const lede = byClass('lede');
  const result = await applyEdits(root, [
    { op: 'duplicateNode', file: 'index.html', node: lede, version: tree.version },
  ]);
  const text = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(
    text,
    /      <p class="lede">Text<\/p>\n      <p class="lede">Text<\/p>\n/,
  );
  const rescan = scanHtml(text);
  assert.equal(rescan.problems.length, 0);
  assert.equal(rescan.nodes.filter((node) => node.tag === 'p').length, 2);
  assert.equal(result.files.length, 1);
  await rm(root, { recursive: true, force: true });
});

test('insertNode: a multi-line snippet beside a node keeps its own nesting', async () => {
  const root = await project();
  const { byClass } = await nodes(root);
  const html = '<div data-hf="toggle">\n  <button data-hf-part="control">Pin</button>\n</div>';
  await applyEdits(root, [
    { op: 'insertNode', file: 'index.html', node: byClass('lede'), position: 'after', html },
  ]);
  const text = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(
    text,
    /      <p class="lede">Text<\/p>\n      <div data-hf="toggle">\n        <button data-hf-part="control">Pin<\/button>\n      <\/div>\n/,
  );
  await rm(root, { recursive: true, force: true });
});

test('setDecl: minified CSS keeps `prop:value` spacing and stays single-line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-min-'));
  const minified = '.markets{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}\n';
  await writeFile(join(root, 'style.css'), minified, 'utf8');
  await applyEdits(root, [{ op: 'setDecl', file: 'style.css', selector: '.markets', property: 'gap', value: '18px', expect: '12px' }]);
  assert.equal(await readFile(join(root, 'style.css'), 'utf8'), '.markets{display:grid;grid-template-columns:repeat(6,1fr);gap:18px}\n');

  await applyEdits(root, [{ op: 'setDecl', file: 'style.css', selector: '.markets', property: 'padding', value: '4px', create: false }]);
  assert.equal(
    await readFile(join(root, 'style.css'), 'utf8'),
    '.markets{display:grid;grid-template-columns:repeat(6,1fr);gap:18px;padding:4px;}\n',
  );
  await rm(root, { recursive: true, force: true });
});

test('duplicateNode: the copy drops ids so the document keeps unique ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-dup-'));
  await writeFile(
    join(root, 'index.html'),
    '<main>\n  <section id="panel" aria-labelledby="panel-title">\n    <h2 id="panel-title">Title</h2>\n  </section>\n</main>\n',
    'utf8',
  );
  const before = scanHtml(await readFile(join(root, 'index.html'), 'utf8'));
  const section = before.nodes.find((node) => node.tag === 'section');
  await applyEdits(root, [{ op: 'duplicateNode', file: 'index.html', node: section.id }]);
  const text = await readFile(join(root, 'index.html'), 'utf8');

  assert.equal((text.match(/<section/g) ?? []).length, 2, 'the section was copied');
  assert.equal((text.match(/id="panel"/g) ?? []).length, 1, 'the original keeps its id');
  assert.equal((text.match(/id="panel-title"/g) ?? []).length, 1, 'the nested id is not copied');
  assert.equal((text.match(/aria-labelledby="panel-title"/g) ?? []).length, 1, 'no dangling aria reference on the copy');
  assert.equal(scanHtml(text).problems.length, 0);
  await rm(root, { recursive: true, force: true });
});

test('setAttr/removeAttr: plain HTML attributes round-trip', async () => {
  const root = await project();
  const { byTag, tree } = await nodes(root);
  const h1 = byTag('h1');
  await applyEdits(root, [
    { op: 'setAttr', file: 'index.html', node: h1, name: 'role', value: 'heading' },
  ]);
  let text = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(text, /<h1 class="title" role="heading">/, 'the attribute lands on the element');

  await applyEdits(root, [{ op: 'removeAttr', file: 'index.html', node: h1, name: 'role' }]);
  text = await readFile(join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(text, /role="heading"/, 'the attribute is gone');
  assert.match(text, /<h1 class="title">/, 'the rest of the tag is untouched');
  await rm(root, { recursive: true, force: true });
});

test('setAttr: quotes in the value are escaped, not injected as attributes', async () => {
  const root = await project();
  const { byTag } = await nodes(root);
  const h1 = byTag('h1');
  await applyEdits(root, [
    { op: 'setAttr', file: 'index.html', node: h1, name: 'title', value: 'a" onmouseover="alert(1)' },
  ]);
  const text = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(text, /title="a&quot; onmouseover=&quot;alert\(1\)"/, 'the value stays one attribute');
  assert.doesNotMatch(text, /<h1[^>]*\sonmouseover="alert/, 'no attribute was injected');
  const rescan = scanHtml(text).nodes.find((node) => node.tag === 'h1');
  assert.equal(rescan.attrs.filter((attr) => attr.name === 'onmouseover').length, 0);
  // The scanner reports source text, so the entities stay as written. What
  // matters is that the whole payload is one attribute value.
  assert.equal(rescan.attrs.find((attr) => attr.name === 'title')?.value, 'a&quot; onmouseover=&quot;alert(1)');
  await rm(root, { recursive: true, force: true });
});

test('attrOp: empty string sets an empty attribute, null removes it', async () => {
  const base = { file: 'index.html', version: 1, nodeId: '0.0.1.0.0.0', name: 'alt' };
  assert.deepEqual(attrOp({ ...base, value: '', previous: 'old' }), [
    { op: 'setAttr', file: 'index.html', node: '0.0.1.0.0.0', name: 'alt', value: '', version: 1 },
  ]);
  assert.deepEqual(attrOp({ ...base, value: null, previous: 'old' }), [
    { op: 'removeAttr', file: 'index.html', node: '0.0.1.0.0.0', name: 'alt', version: 1 },
  ]);
  assert.deepEqual(attrOp({ ...base, value: 'old', previous: 'old' }), [], 'unchanged is a no-op');
  assert.deepEqual(attrOp({ ...base, value: null, previous: undefined }), [], 'removing a missing attr is a no-op');
});
