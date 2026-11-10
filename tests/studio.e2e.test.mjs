import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from '../tools/studio/server.mjs';

const SOURCE = new URL('..', import.meta.url).pathname;

/**
 * End-to-end through the browser: pick in the preview → save a layout change →
 * read the file back from disk. Skipped when no Chromium is available, so
 * `npm test` stays runnable on a machine without one.
 */
async function launch() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return null;
  }
  try {
    return await chromium.launch({ channel: 'chromium' }).catch(async () => {
      // Fall back to the managed download location used by Playwright's installer.
      const root = join(process.env.HOME ?? '', '.cache/ms-playwright');
      const { readdir } = await import('node:fs/promises');
      const versions = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('chromium-'));
      if (!versions.length) return null;
      return chromium.launch({ executablePath: join(root, versions.sort().at(-1), 'chrome-linux64/chrome') });
    });
  } catch {
    return null;
  }
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'hf-e2e-'));
  for (const entry of ['index.html', 'styles', 'foundation', 'components', 'compose', 'runtime']) {
    await cp(join(SOURCE, entry), join(root, entry), { recursive: true });
  }
  return root;
}

test('e2e: pick in the preview, edit layout, confirm the diff, verify disk', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');

    // Picking is on by default: clicking the page selects, no mode switch.
    assert.equal(await page.isChecked('#pick-toggle'), true, 'pick mode defaults on');
    const frame = page.frameLocator('#preview');
    await frame.locator('.page__lede').click();
    await page.waitForFunction(() => document.querySelector('#node-path').textContent.includes('.page__lede'));

    await page.click('#tab-layout');
    const padding = page.locator('#panel-layout label.field', { hasText: 'padding' }).locator('input');
    await padding.fill('1rem 0');
    await padding.dispatchEvent('change');
    await page.waitForSelector('#pending-list li');

    await page.click('#save-btn');
    await page.waitForSelector('#diff-dialog[open]');
    assert.match(await page.textContent('#diff-body'), /padding: 1rem 0/);
    assert.equal(await readFile(join(root, 'styles/demo.css'), 'utf8'), await readFile(join(SOURCE, 'styles/demo.css'), 'utf8'), 'nothing written before confirming');

    await page.click('#confirm-save');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Saved'));

    const css = await readFile(join(root, 'styles/demo.css'), 'utf8');
    assert.match(css, /\.page__lede \{[^}]*padding: 1rem 0;/);
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: a stale file version is surfaced and nothing is written', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');

    // Change the file behind the studio's back, then save an edit.
    await page.click('#tab-frames');
    // `hasText` also matches the "Header / Sidebar / Main / Footer" card, so
    // pick by exact card title.
    await page
      .locator('#panel-frames .rule')
      .filter({ has: page.locator('.rule__head', { hasText: /^Sidebar \/ Main$/ }) })
      .locator('button')
      .click();
    await page.waitForSelector('#pending-list li');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'styles/demo.css'), (await readFile(join(root, 'styles/demo.css'), 'utf8')) + '\n/* external */\n', 'utf8');

    await page.click('#save-btn');
    await page.waitForFunction(() => {
      const status = document.querySelector('#status').textContent;
      return status.includes('STALE') || status.includes('changed on disk');
    });
    assert.equal(await page.$('#diff-dialog[open]'), null, 'no diff for a rejected batch');
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: the Element panel edits and removes attributes', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');
    await page.locator('.tree__row', { hasText: 'h1' }).first().click();
    await page.click('#tab-node');
    await page.waitForSelector('.attr-row');

    const name = page.locator('.attr-row--new input').first();
    const value = page.locator('.attr-row--new input').nth(1);
    await name.fill('data-probe');
    await value.fill('ok');
    await page.locator('.attr-row--new button', { hasText: 'Add' }).click();
    await page.waitForSelector('#pending-list li');
    assert.match(await page.textContent('#pending-list'), /data-probe on node/);

    await page.click('#save-btn');
    await page.waitForSelector('#diff-dialog[open]');
    await page.click('#confirm-save');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Saved'));
    assert.match(await readFile(join(root, 'index.html'), 'utf8'), /<h1 class="page__title" data-probe="ok">/);

    // remove it again: the row's ✕ must produce a removal, not a no-op
    await page.click('#reload-page');
    await page.waitForSelector('.attr-row');
    await page.locator('.tree__row', { hasText: 'h1' }).first().click();
    await page.click('#tab-node');
    await page.waitForSelector('.attr-row');
    await page.locator('.attr-row', { hasText: 'data-probe' }).locator('button').click();
    await page.waitForSelector('#pending-list li');
    await page.click('#save-btn');
    await page.waitForSelector('#diff-dialog[open]');
    await page.click('#confirm-save');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Saved'));
    assert.doesNotMatch(await readFile(join(root, 'index.html'), 'utf8'), /data-probe/);
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: side panels never overflow their column, even with long rule text', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');

    // The component panel renders a two-column field grid plus a `pre` usage
    // line; both used to size the panel to max-content and clip the fields.
    await page.locator('.tree__row', { hasText: 'page__lede' }).first().click();
    await page.click('#tab-node');
    await page.waitForSelector('#panel-node .group');
    // A long unbreakable token in a matched rule used to stretch the column.
    // Mirror the real failure: a matched rule whose text is one long token
    // (a Google Fonts URL). Grid items do not shrink below max-content, so
    // without `overflow-wrap` the column is 40px too wide.
    await page.evaluate(() => {
      const list = document.querySelector('#panel-node .rule__decls');
      if (!list) return;
      const line = document.createElement('div');
      line.className = 'long-token-probe';
      line.textContent = '500;600;700&family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap';
      list.append(line);
    });
    const spill = await page.evaluate(() => {
      const panel = document.querySelector('#panel-node');
      const probe = panel.querySelector('.long-token-probe');
      return { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, probeRight: probe.getBoundingClientRect().right, panelRight: panel.getBoundingClientRect().right };
    });
    assert.ok(spill.scrollWidth <= spill.clientWidth + 1, 'a long rule token must not widen the panel');
    assert.ok(spill.probeRight <= spill.panelRight + 1, 'rule text must not paint outside the column');

    await page.locator('.tree__row', { hasText: 'hf-example-card' }).first().click();
    await page.click('#tab-component');
    await page.waitForSelector('#panel-component .group');

    for (const id of ['panel-component', 'panel-node', 'panel-layout', 'panel-structure']) {
      const panel = page.locator(`#${id}`);
      if (!(await panel.count())) continue;
      if (id !== 'panel-component') {
        await page.click(`#${id.replace('panel-', 'tab-')}`);
        await page.waitForTimeout(150);
      }
      const box = await panel.evaluate((node) => ({
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        outside: [...node.querySelectorAll('*')].filter(
          (child) => child.getBoundingClientRect().right > node.getBoundingClientRect().right + 1,
        ).length,
      }));
      assert.ok(
        box.scrollWidth <= box.clientWidth + 1,
        `${id} must not scroll horizontally (${box.scrollWidth} > ${box.clientWidth})`,
      );
      assert.equal(box.outside, 0, `${id} must not paint children outside its column`);
    }
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: edits show in the preview before saving, and discard reverts them', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');

    const frame = page.frameLocator('#preview');
    await frame.locator('.page__lede').click();
    await page.waitForFunction(() => document.querySelector('#node-path').textContent.includes('.page__lede'));
    await page.click('#tab-layout');

    const gap = page.locator('#panel-layout label.field', { hasText: 'gap' }).locator('input');
    await gap.fill('7px');
    await gap.dispatchEvent('change');

    const computed = () =>
      frame.locator('.page__lede').evaluate((el) => getComputedStyle(el).gap);
    assert.equal(await computed(), '7px', 'the preview shows the edit immediately');
    assert.equal(
      await readFile(join(root, 'styles/demo.css'), 'utf8'),
      await readFile(join(SOURCE, 'styles/demo.css'), 'utf8'),
      'nothing is on disk yet',
    );

    await page.click('#discard-btn');
    // Wait for the live reset to land, not just for the list to empty: the
    // panel posts the new live set after it re-renders pending changes.
    await page.waitForFunction(
      () => document.querySelectorAll('#pending-list li').length === 0
        && document.querySelector('#status').textContent.startsWith('Discarded'),
    );
    await page.waitForFunction(
      () => document.querySelector('#preview').contentDocument
        .querySelector('.page__lede') && getComputedStyle(document.querySelector('#preview').contentDocument.querySelector('.page__lede')).gap !== '7px',
    );
    assert.notEqual(await computed(), '7px', 'discard removes the live override');
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: a field returned to its disk value drops the pending change', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');

    const frame = page.frameLocator('#preview');
    await frame.locator('.page__lede').click();
    await page.waitForFunction(() => document.querySelector('#node-path').textContent.includes('.page__lede'));
    await page.click('#tab-layout');

    const gap = page.locator('#panel-layout label.field', { hasText: 'gap' }).locator('input');
    await gap.fill('7px');
    await gap.dispatchEvent('change');
    await page.waitForSelector('#pending-list li');

    await gap.fill('');
    await gap.dispatchEvent('change');
    await page.waitForFunction(() => document.querySelectorAll('#pending-list li').length === 0);
    assert.equal(
      await page.isDisabled('#save-btn'),
      true,
      'no pending change means nothing to save',
    );
    assert.notEqual(
      await frame.locator('.page__lede').evaluate((el) => getComputedStyle(el).gap),
      '7px',
    );
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: the inspector offers only the tabs that apply to the selection', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');

    const visibleTabs = () =>
      page.$$eval('.tabs [role=tab]', (tabs) =>
        tabs.filter((tab) => !tab.hidden).map((tab) => tab.textContent.replace('?', '').trim()),
      );
    const selectInTree = async (label) => {
      const row = page.locator('#tree .tree__row', { hasText: label }).first();
      await row.click();
      await page.waitForFunction(() => document.querySelector('#node-path').textContent.length > 0);
    };

    // A foundation instance: its options are the reason the user clicked it,
    // so the Component tab is both offered and selected.
    await selectInTree('demo-disclosure');
    assert.ok((await visibleTabs()).includes('Component'), 'Component tab applies to a foundation');
    assert.equal(await page.getAttribute('#tab-component', 'aria-selected'), 'true', 'Component is selected for a foundation');
    assert.ok(
      await page.evaluate(() => !document.querySelector('#panel-component').hidden),
      'the visible panel matches the selected tab',
    );

    // A plain paragraph has a box but no component settings.
    await selectInTree('.page__lede');
    const pTabs = await visibleTabs();
    assert.ok(pTabs.includes('Layout'), 'Layout applies to a rendered element');
    assert.ok(!pTabs.includes('Component'), 'Component is hidden without a component');

    // <script> has no box: Layout would be meaningless.
    await selectInTree('script');
    const scriptTabs = await visibleTabs();
    assert.ok(!scriptTabs.includes('Layout'), 'Layout is hidden for a non-rendered tag');
    assert.ok(scriptTabs.includes('Element'), 'Element always applies');

    // Exactly one panel is ever shown, whatever the selection did.
    const shown = await page.$$eval('.panel', (panels) => panels.filter((p) => !p.hidden).length);
    assert.equal(shown, 1, 'exactly one panel is visible');
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: every panel title carries a Korean help tooltip', async (t) => {
  const browser = await launch();
  if (!browser) {
    t.skip('no Chromium available');
    return;
  }
  const root = await project();
  const studio = await startStudio({ root, port: 0, quiet: true });
  try {
    const page = await browser.newPage();
    await page.goto(studio.url);
    await page.waitForSelector('.tree__row');
    // A rendered element, so every tab applies and the headings get rendered.
    await page.locator('#tree .tree__row', { hasText: '.page__lede' }).first().click();
    await page.waitForSelector('#tab-layout:not([hidden])');
    await page.click('#tab-layout');

    const helps = await page.$$eval('.tabs [role=tab] .help', (icons) =>
      icons.map((icon) => ({ title: icon.getAttribute('title') ?? '', hidden: Boolean(icon.closest('[hidden]')) })),
    );
    assert.ok(helps.length >= 6, 'each tab has an icon');
    for (const icon of helps) {
      assert.match(icon.title, /[\uac00-\ud7a3]/, 'the tooltip is Korean');
    }
    // The icon inside a tab must not switch tabs when clicked.
    const before = await page.getAttribute('#tab-layout', 'aria-selected');
    await page.click('#tab-frames .help');
    assert.equal(await page.getAttribute('#tab-layout', 'aria-selected'), before, 'clicking ? does not switch tabs');
  } finally {
    await studio.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
