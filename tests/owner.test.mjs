import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPageModel, internalOwner } from '../tools/studio/model.mjs';
import { discover } from '../tools/studio/discover.mjs';

/**
 * A project where markup, behavior and styles live in three different files:
 * that split is the whole point of a headless component toolkit, and it is
 * exactly what the ownership report has to reconstruct.
 */
async function makeSplitProject() {
  const root = await mkdtemp(join(tmpdir(), 'hf-owner-'));

  await writeFile(
    join(root, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
  <title>Split</title>
  <link rel="stylesheet" href="/page.css">
</head>
<body>
  <main>
    <div data-hf="disclosure" id="details">
      <button data-hf-part="trigger">Show</button>
      <div data-hf-part="panel">Body</div>
    </div>
    <hf-badge label="New"><span class="badge-extra">slotted</span></hf-badge>
  </main>
</body>
</html>
`,
    'utf8',
  );

  await writeFile(join(root, 'page.css'), 'main { display: block; }\n.badge-extra { color: red; }\n', 'utf8');

  // The component links a stylesheet that is not referenced from the page.
  // The definition is expressed with `describeDefinition`'s output shape so the
  // fixture needs no runtime: `discover` only reads the serialized metadata.
  await mkdir(join(root, 'components', 'badge'), { recursive: true });
  await writeFile(
    join(root, 'components', 'badge', 'badge.js'),
    `export default {
  __hfDefinition: true,
  name: 'badge',
  tag: 'hf-badge',
  props: { label: 'Badge' },
  styles: './badge.css',
  template: \`<span class="badge" data-hf-part="root"><span class="badge__label">{{ label }}</span><span class="badge__dot"></span></span>\`,
};
`,
    'utf8',
  );
  await writeFile(
    join(root, 'components', 'badge', 'badge.css'),
    '.badge { display: inline-flex; }\n.badge__label { font-weight: 600; }\n.badge__dot { width: 4px; }\n',
    'utf8',
  );

  // A foundation module the page instantiates through data-hf.
  await mkdir(join(root, 'foundation'), { recursive: true });
  await writeFile(
    join(root, 'foundation', 'disclosure.js'),
    `export const meta = { name: 'disclosure', file: import.meta.url, summary: 's', parts: {}, options: {}, events: [] };
export function mount() {}
`,
    'utf8',
  );
  await writeFile(
    join(root, 'foundation', 'index.js'),
    `import * as disclosure from './disclosure.js';
export const foundations = Object.freeze({ disclosure: Object.freeze({ name: 'disclosure', meta: disclosure.meta, mount: disclosure.mount }) });
`,
    'utf8',
  );

  return root;
}

test('discover records the file a foundation is defined in', async () => {
  const root = await makeSplitProject();
  try {
    const project = await discover(root);
    const disclosure = project.foundations.find((entry) => entry.name === 'disclosure');
    assert.equal(disclosure.file, 'foundation/disclosure.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discover records a component template and the stylesheet it links', async () => {
  const root = await makeSplitProject();
  try {
    const project = await discover(root);
    const badge = project.components.find((entry) => entry.name === 'badge');
    assert.equal(badge.file, 'components/badge/badge.js');
    assert.equal(badge.styles, 'components/badge/badge.css');
    assert.match(badge.template, /badge__label/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the page model includes a component stylesheet the page never links', async () => {
  const root = await makeSplitProject();
  try {
    const model = await buildPageModel(root, 'index.html');
    const sheet = model.sheets.find((entry) => entry.file === 'components/badge/badge.css');
    assert.ok(sheet, 'component stylesheet must be present');
    assert.equal(sheet.component, 'badge');
    assert.ok(sheet.rules.some((rule) => rule.selector === '.badge__label'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ownership names separate files for markup, behavior and styles', async () => {
  const root = await makeSplitProject();
  try {
    const model = await buildPageModel(root, 'index.html');
    const walk = (node, out = []) => {
      out.push(node);
      node.children.forEach((child) => walk(child, out));
      return out;
    };
    const nodes = walk(model.tree);

    const trigger = nodes.find((node) => node.attrs['data-hf-part'] === 'trigger');
    const owner = model.owners[trigger.id];
    assert.equal(owner.markup.file, 'index.html');
    assert.equal(owner.behavior.kind, 'foundation');
    assert.equal(owner.behavior.name, 'disclosure');
    assert.equal(owner.behavior.file, 'foundation/disclosure.js');
    // The trigger is a part, so the owner must say which part it is.
    assert.equal(owner.behavior.part, 'trigger');

    const host = nodes.find((node) => node.tag === 'hf-badge');
    const hostOwner = model.owners[host.id];
    assert.equal(hostOwner.behavior.kind, 'component');
    assert.equal(hostOwner.behavior.file, 'components/badge/badge.js');
    assert.ok(hostOwner.styles.some((entry) => entry.file === 'components/badge/badge.css'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a page element with no component reports no behavior', async () => {
  const root = await makeSplitProject();
  try {
    const model = await buildPageModel(root, 'index.html');
    const walk = (node, out = []) => {
      out.push(node);
      node.children.forEach((child) => walk(child, out));
      return out;
    };
    const main = walk(model.tree).find((node) => node.tag === 'main');
    assert.equal(model.owners[main.id].behavior, null);
    assert.equal(model.owners[main.id].markup.file, 'index.html');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('internalOwner maps a runtime element back into the component template', async () => {
  const root = await makeSplitProject();
  try {
    const project = await discover(root);
    const found = internalOwner(project, 'hf-badge', { tag: 'span', classes: ['badge__label'] });
    assert.equal(found.found, true);
    assert.equal(found.file, 'components/badge/badge.js');
    assert.equal(found.styles, 'components/badge/badge.css');
    assert.match(found.markup, /badge__label/);

    const missing = internalOwner(project, 'hf-badge', { tag: 'marquee', classes: [] });
    assert.equal(missing.found, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
