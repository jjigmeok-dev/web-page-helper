import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPageModel } from '../tools/studio/model.mjs';
import { indexTree, suggestionsFor } from '../studio/suggest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function model() {
  const page = await buildPageModel(root, 'index.html');
  return { page, index: indexTree(page.tree) };
}

const kinds = (list) => list.map((entry) => entry.kind);
const titles = (list) => list.map((entry) => entry.title);

test('every suggestion names ops the editor supports, with no page paths baked in', async () => {
  const { page, index } = await model();
  const SUPPORTED = new Set([
    'setDecl', 'removeDecl', 'setAttr', 'removeAttr', 'setText', 'insertNode',
    'removeNode', 'duplicateNode', 'moveNode', 'wrapNode', 'frameNode',
    'frameDocument', 'appendToHead', 'appendCss',
  ]);
  let checked = 0;
  for (const node of index.all) {
    for (const entry of suggestionsFor(node, page, { file: 'x.css', version: 'v', selector: '.x' }, index)) {
      assert.ok(entry.id && entry.title && entry.detail, `incomplete suggestion ${entry.id}`);
      assert.ok(['error', 'warn', 'info'].includes(entry.severity), entry.id);
      for (const op of entry.ops) {
        assert.ok(SUPPORTED.has(op.op), `${entry.id} builds unknown op ${op.op}`);
        // The panel fills file/version; a suggestion must not guess a page path.
        assert.equal(op.file, undefined, `${entry.id} hard-codes file`);
        assert.equal(op.version, undefined, `${entry.id} hard-codes version`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'expected at least one applicable suggestion');
});

test('a bare image is told to add alt, and the op does it', async () => {
  const page = { tree: { id: 'r', tag: '#document', children: [{ id: 'i', tag: 'img', attrs: { src: 'a.png' }, classes: [], children: [], text: '' }] }, matched: {}, foundations: [], components: [] };
  const index = indexTree(page.tree);
  const list = suggestionsFor(page.tree.children[0], page, null, index);
  const alt = list.find((entry) => entry.id === 'a11y:img:alt');
  assert.ok(alt, titles(list).join(', '));
  assert.deepEqual(alt.ops, [{ op: 'setAttr', nodeId: 'i', name: 'alt', value: '' }]);
});

test('a link without href and a nameless button are errors', async () => {
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [
        { id: 'a', tag: 'a', attrs: {}, classes: [], children: [], text: 'Docs' },
        { id: 'b', tag: 'button', attrs: {}, classes: [], children: [], text: '' },
      ],
    },
    matched: {}, foundations: [], components: [],
  };
  const index = indexTree(page.tree);
  assert.equal(suggestionsFor(page.tree.children[0], page, null, index).find((e) => e.id === 'a11y:a:href')?.severity, 'error');
  assert.equal(suggestionsFor(page.tree.children[1], page, null, index).find((e) => e.id === 'a11y:button:name')?.severity, 'error');
});

test('an optional part is not reported missing; a required one is', async () => {
  const foundations = [{
    name: 'menu',
    parts: { trigger: 'button', list: 'any', item: 'button', separator: 'any' },
    required: ['trigger', 'list'],
  }];
  const build = (children) => {
    const page = {
      tree: { id: 'r', tag: '#document', children: [{ id: 'm', tag: 'div', attrs: { 'data-hf': 'menu' }, classes: [], component: { kind: 'foundation', name: 'menu', options: {} }, children, text: '' }] },
      matched: {}, foundations, components: [],
    };
    return suggestionsFor(page.tree.children[0], page, null, indexTree(page.tree));
  };

  const none = build([]);
  const missing = titles(none.filter((entry) => entry.kind === 'contract'));
  assert.deepEqual(missing.sort(), ['Add the missing "list" part', 'Add the missing "trigger" part']);

  const withOptionalLeftOut = build([
    { id: 't', tag: 'button', attrs: { 'data-hf-part': 'trigger' }, classes: [], component: { kind: 'part', name: 'trigger' }, children: [], text: 'Open' },
    { id: 'l', tag: 'div', attrs: { 'data-hf-part': 'list' }, classes: [], component: { kind: 'part', name: 'list' }, children: [], text: '' },
  ]);
  // `separator` and `item` are listed in parts but not required: no complaint.
  assert.deepEqual(withOptionalLeftOut.filter((entry) => entry.kind === 'contract'), []);
});

test('a part nested one level down still belongs to its foundation', async () => {
  const foundations = [{ name: 'tabs', parts: { list: 'any', tab: 'button|a', panel: 'any' }, required: ['list', 'tab'] }];
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [{
        id: 't', tag: 'div', attrs: { 'data-hf': 'tabs' }, classes: [], component: { kind: 'foundation', name: 'tabs', options: {} }, text: '',
        children: [{
          id: 'l', tag: 'div', attrs: { 'data-hf-part': 'list' }, classes: [], component: { kind: 'part', name: 'list' }, text: '',
          children: [{ id: 'tab1', tag: 'button', attrs: { 'data-hf-part': 'tab' }, classes: [], component: { kind: 'part', name: 'tab' }, children: [], text: 'One' }],
        }],
      }],
    },
    matched: {}, foundations, components: [],
  };
  const index = indexTree(page.tree);
  assert.equal(index.partsOf.get('tab1'), 't');
  // `tab` exists, `panel` is listed but not required.
  assert.deepEqual(suggestionsFor(page.tree.children[0], page, null, index).filter((e) => e.kind === 'contract'), []);
});

test('a tag union is satisfied by any member, not just the first', async () => {
  const foundations = [{ name: 'tabs', parts: { tab: 'button|a' }, required: [] }];
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [{
        id: 't', tag: 'div', attrs: { 'data-hf': 'tabs' }, classes: [], component: { kind: 'foundation', name: 'tabs', options: {} }, text: '',
        children: [{ id: 'tab1', tag: 'a', attrs: { 'data-hf-part': 'tab' }, classes: [], component: { kind: 'part', name: 'tab' }, children: [], text: 'One' }],
      }],
    },
    matched: {}, foundations, components: [],
  };
  const index = indexTree(page.tree);
  assert.deepEqual(suggestionsFor(page.tree.children[0], page, null, index).filter((e) => e.kind === 'contract'), []);
});

test('duplicate ids and orphan parts are reported', async () => {
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [
        { id: 'a', tag: 'div', domId: 'x', attrs: { id: 'x' }, classes: [], children: [], text: '' },
        { id: 'b', tag: 'div', domId: 'x', attrs: { id: 'x' }, classes: [], children: [], text: '' },
        { id: 'c', tag: 'span', attrs: { 'data-hf-part': 'trigger' }, classes: [], component: { kind: 'part', name: 'trigger' }, children: [], text: '' },
      ],
    },
    matched: {}, foundations: [], components: [],
  };
  const index = indexTree(page.tree);
  assert.ok(suggestionsFor(page.tree.children[0], page, null, index).some((e) => e.id === 'structure:duplicate-id'));
  assert.ok(suggestionsFor(page.tree.children[2], page, null, index).some((e) => e.id === 'structure:orphan-part'));
});

test('shape and colour proposals use the page tokens when present', async () => {
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [{
        id: 'd', tag: 'div', attrs: {}, classes: ['row'], text: '',
        children: [
          { id: 'c1', tag: 'p', attrs: {}, classes: [], children: [], text: 'a' },
          { id: 'c2', tag: 'p', attrs: {}, classes: [], children: [], text: 'b' },
        ],
      }],
    },
    matched: {
      d: [{
        file: 'styles/base.css', selector: '.row', dynamic: false,
        decls: [{ property: '--hf-gap', value: '2rem' }, { property: '--hf-fg', value: '#111' }],
      }],
    },
    foundations: [], components: [],
  };
  const index = indexTree(page.tree);
  const list = suggestionsFor(page.tree.children[0], page, { file: 'styles/base.css', version: 'v1', selector: '.row' }, index);
  const flex = list.find((entry) => entry.id === 'shape:flex-row');
  assert.ok(flex, titles(list).join(', '));
  const gap = flex.ops.find((op) => op.property === 'gap');
  assert.equal(gap.value, 'var(--hf-gap)', 'must follow the token, not a hard-coded rem');
  const colour = list.find((entry) => entry.id === 'colour:foreground');
  assert.equal(colour.ops[0].value, 'var(--hf-fg)');
});

test('no proposal duplicates a declaration the element already sets', async () => {
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [{
        id: 'd', tag: 'div', attrs: {}, classes: ['row'], text: '',
        children: [
          { id: 'c1', tag: 'p', attrs: {}, classes: [], children: [], text: 'a' },
          { id: 'c2', tag: 'p', attrs: {}, classes: [], children: [], text: 'b' },
        ],
      }],
    },
    matched: {
      d: [{
        file: 'a.css', selector: '.row', dynamic: false,
        decls: [
          { property: 'display', value: 'flex' },
          { property: 'gap', value: '1rem' },
          { property: 'padding', value: '2rem' },
          { property: 'color', value: 'red' },
          { property: 'background', value: 'blue' },
        ],
      }],
    },
    foundations: [], components: [],
  };
  const index = indexTree(page.tree);
  const list = suggestionsFor(page.tree.children[0], page, { file: 'a.css', version: 'v1', selector: '.row' }, index);
  assert.equal(list.find((entry) => entry.id === 'shape:flex-row'), undefined);
  assert.equal(list.find((entry) => entry.id === 'size:padding'), undefined);
  assert.equal(list.find((entry) => entry.id === 'colour:foreground'), undefined);
  assert.equal(list.find((entry) => entry.id === 'colour:surface'), undefined);
});

test('errors sort before warnings before suggestions', async () => {
  const { page, index } = await model();
  for (const node of index.all) {
    const list = suggestionsFor(node, page, { file: 'a.css', version: 'v', selector: '.x' }, index);
    const rank = { error: 0, warn: 1, info: 2 };
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(rank[list[i - 1].severity] <= rank[list[i].severity], `unsorted at ${node.id}`);
    }
  }
});

test('an unknown foundation option is suggested only when it is absent', async () => {
  const page = {
    tree: {
      id: 'r', tag: '#document', children: [{
        id: 'd', tag: 'div', attrs: { 'data-hf': 'disclosure' }, classes: [], text: '',
        component: { kind: 'foundation', name: 'disclosure', options: { defaultOpen: true } },
        children: [],
      }],
    },
    matched: {},
    foundations: [{ name: 'disclosure', parts: { trigger: 'button', panel: 'any' }, required: ['trigger', 'panel'], options: { defaultOpen: false, disabled: false } }],
    components: [],
  };
  const index = indexTree(page.tree);
  const list = suggestionsFor(page.tree.children[0], page, { file: 'a.css', version: 'v', selector: '.x' }, index);
  const options = list.filter((entry) => entry.id.startsWith('logic:disclosure:option:'));
  assert.deepEqual(options.map((entry) => entry.title), ['Set the "disabled" option']);
  // Applying it must preserve the option already set.
  assert.deepEqual(JSON.parse(options[0].ops[0].value), { defaultOpen: true, disabled: false });
});

test('foundation parts found in the real project are not reported missing', async () => {
  const { page, index } = await model();
  const confirmed = ['disclosure', 'tabs', 'accordion', 'menu', 'switch', 'combobox', 'dialog', 'toast'];
  for (const name of confirmed) {
    const node = index.all.find((entry) => entry.component?.kind === 'foundation' && entry.component.name === name);
    if (!node) continue;
    const contract = suggestionsFor(node, page, { file: 'a.css', version: 'v', selector: '.x' }, index)
      .filter((entry) => entry.kind === 'contract' && entry.severity === 'error');
    assert.deepEqual(contract, [], `${name}: ${titles(contract).join(', ')}`);
  }
});

/**
 * A suggestion is only useful if applying it is a no-op on the next read. This
 * walks the full loop: detect the defect, apply the ops the panel would send,
 * and assert the defect is gone.
 */
test('applying the missing-part suggestion satisfies the contract', async () => {
  const { mkdtemp, cp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { applyEdits } = await import('../tools/studio/edit.mjs');
  const work = await mkdtemp(join(tmpdir(), 'hf-suggest-'));
  try {
    for (const entry of ['index.html', 'styles', 'components', 'foundation', 'runtime', 'tools']) {
      await cp(join(root, entry), join(work, entry), { recursive: true });
    }
    const original = await readFile(join(work, 'index.html'), 'utf8');
    // A disclosure with its panel removed fails to mount in the browser.
    const broken = original.replace(/<div data-hf-part="panel">\s*Behavior and accessibility[\s\S]*?<\/div>/, '');
    assert.notEqual(broken, original, 'expected the demo panel markup to exist');
    await writeFile(join(work, 'index.html'), broken);

    const before = await buildPageModel(work, 'index.html');
    const index = indexTree(before.tree);
    const node = index.all.find((entry) => entry.component?.kind === 'foundation' && entry.component.name === 'disclosure');
    const fix = suggestionsFor(node, before, { file: 'a.css', version: 'v', selector: '.x' }, index)
      .find((entry) => entry.id === 'foundation:disclosure:part:panel');
    assert.ok(fix, 'the missing panel must be reported');
    assert.equal(fix.severity, 'error');

    // Exactly what the panel does: fill the page file and the wire-format node.
    const ops = fix.ops.map((op) => ({ ...op, file: 'index.html', version: before.version, node: op.node ?? op.nodeId ?? node.id }));
    await applyEdits(work, ops);

    const after = await buildPageModel(work, 'index.html');
    const afterIndex = indexTree(after.tree);
    const nodeAfter = afterIndex.all.find((entry) => entry.component?.kind === 'foundation' && entry.component.name === 'disclosure');
    assert.deepEqual(
      suggestionsFor(nodeAfter, after, { file: 'a.css', version: 'v', selector: '.x' }, afterIndex).filter((entry) => entry.kind === 'contract'),
      [],
    );
    // The markup written by the suggestion must itself parse cleanly.
    assert.deepEqual(after.problems, []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a suggestion op addresses nodes the way the write plan expects', async () => {
  const { mkdtemp, cp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { applyEdits } = await import('../tools/studio/edit.mjs');
  const work = await mkdtemp(join(tmpdir(), 'hf-wire-'));
  try {
    for (const entry of ['index.html', 'styles', 'components']) {
      await cp(join(root, entry), join(work, entry), { recursive: true });
    }
    const page = await buildPageModel(work, 'index.html');
    const index = indexTree(page.tree);
    const button = index.all.find((entry) => entry.tag === 'button' && !entry.text);
    const fix = suggestionsFor(button, page, null, index).find((entry) => entry.id === 'a11y:button:name');
    assert.ok(fix);
    // `nodeId` is the engine's name; the plan reads `node`. Sending the raw op
    // must be rejected loudly rather than silently doing nothing.
    await assert.rejects(
      () => applyEdits(work, [{ ...fix.ops[0], file: 'index.html', version: page.version }]),
      (error) => error.code === 'BAD_NODE',
    );
    await applyEdits(work, [{ ...fix.ops[0], file: 'index.html', version: page.version, node: button.id }]);
    assert.match(await readFile(join(work, 'index.html'), 'utf8'), /aria-label="Action"/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
