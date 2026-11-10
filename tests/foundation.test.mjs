import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

/**
 * All assertions run inside Chromium via `tests/page-api.js`, so focus,
 * keyboard events and layout are real. Each block resets the page.
 */

const run = (page, fn, arg) => page.evaluate(fn, arg);

test('disclosure: toggles, ARIA wiring, events, disabled state', async () => {
  await withPage(async ({ page, errors }) => {
    const result = await run(page, () => {
      const { mount, click, assert } = window.hf;
      const { el, controller } = mount(
        'disclosure',
        `<div data-hf="disclosure">
           <button data-hf-part="trigger">More</button>
           <div data-hf-part="panel">Body</div>
         </div>`,
      );
      const trigger = el.querySelector('[data-hf-part="trigger"]');
      const panel = el.querySelector('[data-hf-part="panel"]');
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(panel.hidden, true);
      assert.ok(panel.id, 'panel receives an id');
      assert.equal(trigger.getAttribute('aria-controls'), panel.id);

      const events = [];
      el.addEventListener('hf:open', (event) => events.push(event.type));
      el.addEventListener('hf:close', (event) => events.push(event.type));
      click(trigger);
      assert.equal(controller.isOpen, true);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(panel.hidden, false);
      assert.equal(el.dataset.state, 'open');
      controller.setOpen(true, 'api');
      assert.deepEqual(events, ['hf:open'], 'no duplicate open event');
      click(trigger);
      assert.deepEqual(events, ['hf:open', 'hf:close']);
      return true;
    });
    assert.equal(result, true);
    assert.deepEqual(errors, []);
  });
});

test('disclosure: disabled trigger and nested components stay independent', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, assert } = window.hf;
      const disabled = mount(
        'disclosure',
        `<div data-hf="disclosure"><button data-hf-part="trigger" disabled>Open</button><div data-hf-part="panel"></div></div>`,
      );
      click(disabled.el.querySelector('[data-hf-part="trigger"]'));
      assert.equal(disabled.el.dataset.state, 'closed', 'disabled trigger does not toggle');

      const nested = mount(
        'disclosure',
        `<div data-hf="disclosure" data-hf-options='{"defaultOpen":true}'>
           <button data-hf-part="trigger">Outer</button>
           <div data-hf-part="panel">
             <div data-hf="disclosure"><button data-hf-part="trigger">Inner</button><div data-hf-part="panel">x</div></div>
           </div>
         </div>`,
      );
      const outerTrigger = nested.el.querySelector(':scope > [data-hf-part="trigger"]');
      const outerPanel = nested.el.querySelector(':scope > [data-hf-part="panel"]');
      const innerPanel = nested.el.querySelector(
        ':scope > [data-hf-part="panel"] > [data-hf="disclosure"] > [data-hf-part="panel"]',
      );
      assert.equal(outerPanel.hidden, false, 'outer opens from defaultOpen');
      assert.equal(innerPanel.hasAttribute('hidden'), false, 'inner owns its own visibility');
      click(outerTrigger);
      assert.equal(outerPanel.hidden, true, 'outer toggles only its own panel');
      assert.equal(innerPanel.hasAttribute('hidden'), false, 'inner untouched');
      nested.controller.destroy();
    });
  });
});

test('tabs: arrow keys, Home/End, wrapping, focus follow and panel swap', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, key, assert } = window.hf;
      const { el, controller } = mount(
        'tabs',
        `<div data-hf="tabs">
           <div data-hf-part="list">
             <button data-hf-part="tab">One</button>
             <button data-hf-part="tab">Two</button>
             <button data-hf-part="tab">Three</button>
           </div>
           <section data-hf-part="panel">1</section>
           <section data-hf-part="panel">2</section>
           <section data-hf-part="panel">3</section>
         </div>`,
      );
      const tabs = [...el.querySelectorAll('[data-hf-part="tab"]')];
      const panels = [...el.querySelectorAll('[data-hf-part="panel"]')];
      const changes = [];
      el.addEventListener('hf:select', (event) => changes.push(event.detail.index));

      assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
      assert.deepEqual([...panels].map((panel) => panel.hidden), [false, true, true]);
      assert.equal(tabs[0].tabIndex, 0);
      assert.equal(tabs[1].tabIndex, -1);

      tabs[0].focus();
      key(tabs[0], 'ArrowRight');
      assert.equal(controller.selected, 1);
      assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
      assert.equal(panels[1].hidden, false);
      assert.equal(document.activeElement, tabs[1]);

      key(tabs[1], 'End');
      assert.equal(controller.selected, 2);
      key(tabs[2], 'ArrowRight');
      assert.equal(controller.selected, 0, 'wraps');
      assert.deepEqual(changes, [1, 2, 0]);
    });
  });
});

test('tabs: manual activation, vertical orientation, explicit aria-controls', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, key, click, assert } = window.hf;
      const manual = mount(
        'tabs',
        `<div data-hf="tabs" data-hf-options='{"activation":"manual"}'>
           <div data-hf-part="list"><button data-hf-part="tab">A</button><button data-hf-part="tab">B</button></div>
           <div data-hf-part="panel">a</div><div data-hf-part="panel">b</div>
         </div>`,
      );
      const manualTabs = manual.el.querySelectorAll('[data-hf-part="tab"]');
      manualTabs[0].focus();
      key(manualTabs[0], 'ArrowRight');
      assert.equal(manual.controller.selected, 0, 'selection unchanged');
      assert.equal(document.activeElement, manualTabs[1]);
      click(manualTabs[1]);
      assert.equal(manual.controller.selected, 1);

      const vertical = mount(
        'tabs',
        `<div data-hf="tabs" data-hf-options='{"orientation":"vertical"}'>
           <div data-hf-part="list"><button data-hf-part="tab">A</button><button data-hf-part="tab">B</button></div>
           <div data-hf-part="panel">a</div><div data-hf-part="panel">b</div>
         </div>`,
      );
      const verticalTabs = vertical.el.querySelectorAll('[data-hf-part="tab"]');
      assert.equal(vertical.el.querySelector('[data-hf-part="list"]').getAttribute('aria-orientation'), 'vertical');
      verticalTabs[0].focus();
      key(verticalTabs[0], 'ArrowRight');
      assert.equal(vertical.controller.selected, 0, 'horizontal key ignored');
      key(verticalTabs[0], 'ArrowDown');
      assert.equal(vertical.controller.selected, 1);

      const explicit = mount(
        'tabs',
        `<div data-hf="tabs">
           <div data-hf-part="list"><button data-hf-part="tab" aria-controls="second">A</button></div>
           <div data-hf-part="panel">a</div>
           <div data-hf-part="panel" id="second">b</div>
         </div>`,
      );
      assert.equal(explicit.el.querySelector('[data-hf-part="tab"]').getAttribute('aria-controls'), 'second');
      assert.equal(document.getElementById('second').hidden, false, 'explicit panel is the selected one');
    });
  });
});

test('accordion: single vs multiple, collapsible, defaultOpen, destroy', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, assert } = window.hf;
      const single = mount(
        'accordion',
        `<div data-hf="accordion" data-hf-options='{"type":"single","collapsible":false}'>
           <div data-hf-part="item"><button data-hf-part="trigger">A</button><div data-hf-part="panel">a</div></div>
           <div data-hf-part="item"><button data-hf-part="trigger">B</button><div data-hf-part="panel">b</div></div>
         </div>`,
      );
      const triggers = single.el.querySelectorAll('[data-hf-part="trigger"]');
      const panels = single.el.querySelectorAll('[data-hf-part="panel"]');
      click(triggers[0]);
      assert.equal(panels[0].hidden, false);
      click(triggers[0]);
      assert.equal(panels[0].hidden, false, 'collapsible:false keeps it open');
      click(triggers[1]);
      assert.equal(panels[0].hidden, true, 'sibling closes');
      assert.equal(panels[1].hidden, false);

      const multiple = mount(
        'accordion',
        `<div data-hf="accordion" data-hf-options='{"type":"multiple","defaultOpen":[0,2]}'>
           <div data-hf-part="item"><button data-hf-part="trigger">A</button><div data-hf-part="panel">a</div></div>
           <div data-hf-part="item"><button data-hf-part="trigger">B</button><div data-hf-part="panel">b</div></div>
           <div data-hf-part="item"><button data-hf-part="trigger">C</button><div data-hf-part="panel">c</div></div>
         </div>`,
      );
      assert.deepEqual(multiple.controller.openIndexes, [0, 2]);
      click(multiple.el.querySelectorAll('[data-hf-part="trigger"]')[1]);
      assert.deepEqual(multiple.controller.openIndexes, [0, 1, 2]);

      multiple.controller.destroy();
      multiple.controller.open(1);
      assert.equal(
        multiple.el.querySelectorAll('[data-hf-part="trigger"]')[1].getAttribute('aria-expanded'),
        'true',
        'destroyed controller no longer mutates the DOM',
      );
    });
  });
});

test('dialog: native element owns top layer, focus, Escape and focus return', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, assert } = window.hf;
      const opener = document.createElement('button');
      opener.id = 'opener';
      document.body.append(opener);
      opener.focus();

      const { el, controller } = mount(
        'dialog',
        `<dialog data-hf="dialog">
           <div data-hf-part="content">
             <input id="first" />
             <button data-hf-part="close">Close</button>
           </div>
         </dialog>`,
      );

      // The platform provides these; anything this module set itself would be
      // a duplicate, and the guidance forbids exactly that.
      assert.equal(el.tagName, 'DIALOG');
      assert.equal(el.getAttribute('role'), null, 'no hand-written role');
      assert.equal(el.getAttribute('aria-modal'), null, 'no hand-written aria-modal');
      assert.equal(el.open, false, 'closed until opened');

      controller.open();
      assert.equal(el.open, true, 'showModal() opened the element');
      assert.equal(el.matches(':modal'), true, 'it is in the top layer');
      assert.ok(el.contains(document.activeElement), 'the browser focused inside');
      assert.equal(document.documentElement.hasAttribute('data-hf-scroll-lock'), false, 'no manual scroll lock');

      controller.close();
      assert.equal(controller.isOpen, false);
      assert.equal(el.open, false);

      // The backdrop is not an element the dialog contains, so the module
      // closes on a click whose target is the dialog box itself.
      controller.open();
      click(el);
      assert.equal(controller.isOpen, false, 'backdrop click closes');
    });
  });
});

test('dialog: close buttons, cancel option, and host validation', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, assert } = window.hf;
      const { el, controller } = mount(
        'dialog',
        `<dialog data-hf="dialog">
           <div data-hf-part="content">
             <button data-hf-part="close">Close</button>
           </div>
         </dialog>`,
      );
      controller.open();
      el.querySelector('[data-hf-part="close"]').click();
      assert.equal(controller.isOpen, false, 'close button closes the dialog');
    });

    // `closeOnEscape: false` refusing `cancel` is the one decision the
    // platform cannot make for us, so it is the one handler worth keeping.
    await run(page, () => {
      const { mount, assert } = window.hf;
      const { el, controller } = mount(
        'dialog',
        `<dialog data-hf="dialog" data-hf-options='{"closeOnEscape":false}'>
           <div data-hf-part="content"><button>x</button></div>
         </dialog>`,
      );
      controller.open();
      const cancel = new Event('cancel', { cancelable: true });
      el.dispatchEvent(cancel);
      assert.equal(cancel.defaultPrevented, true, 'Escape dismissal refused');
      assert.equal(el.open, true);
    });

    // A host that is not a <dialog> cannot get the platform behavior, so it
    // must fail loudly instead of degrading to a div overlay.
    await run(page, () => {
      const { mount, assert } = window.hf;
      assert.throws(
        () => mount('dialog', `<div data-hf="dialog"><div data-hf-part="content">x</div></div>`),
        /needs a <dialog>/,
      );
    });
  });
});

test('menu: open, roving focus, disabled items, Escape, typeahead, outside click', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, key, assert } = window.hf;
      const { el, controller } = mount(
        'menu',
        `<div data-hf="menu">
           <button data-hf-part="trigger">Actions</button>
           <div data-hf-part="list">
             <button data-hf-part="item" data-value="copy">Copy</button>
             <button data-hf-part="item" data-value="paste" aria-disabled="true">Paste</button>
             <button data-hf-part="item" data-value="delete">Delete</button>
           </div>
         </div>`,
      );
      const trigger = el.querySelector('[data-hf-part="trigger"]');
      const list = el.querySelector('[data-hf-part="list"]');
      const selected = [];
      el.addEventListener('hf:select', (event) => selected.push(event.detail.value));

      assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
      click(trigger);
      assert.equal(controller.isOpen, true);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(document.activeElement, trigger.nextElementSibling.querySelector('[data-value="copy"]'));

      key(list, 'ArrowDown');
      assert.ok(document.activeElement.getAttribute('aria-disabled') === 'true');
      key(list, 'ArrowDown');
      assert.equal(document.activeElement.dataset.value, 'delete');
      key(list, 'Home');
      assert.equal(document.activeElement.dataset.value, 'copy');

      key(list, 'd');
      assert.equal(document.activeElement.dataset.value, 'delete', 'typeahead');
      key(list, 'Enter');
      assert.deepEqual(selected, ['delete']);
      assert.equal(controller.isOpen, false);
      assert.equal(document.activeElement, trigger, 'focus returns to trigger');

      key(trigger, 'ArrowUp');
      assert.equal(document.activeElement.dataset.value, 'delete', 'ArrowUp opens on last');
      key(list, 'Escape');
      assert.equal(controller.isOpen, false);

      click(trigger);
      const outside = document.createElement('div');
      document.body.append(outside);
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      assert.equal(controller.isOpen, false, 'outside pointerdown closes');
    });
  });
});

test('toggle & switch: state attributes, disabled guard, events', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, assert } = window.hf;
      const toggle = mount('toggle', `<div data-hf="toggle"><button data-hf-part="control">Pin</button></div>`);
      const control = toggle.el.querySelector('[data-hf-part="control"]');
      const states = [];
      toggle.el.addEventListener('hf:change', (event) => states.push(event.detail.pressed));
      click(control);
      assert.equal(control.getAttribute('aria-pressed'), 'true');
      assert.equal(toggle.el.dataset.state, 'pressed');
      click(control);
      assert.deepEqual(states, [true, false]);

      const disabled = mount('toggle', `<div data-hf="toggle"><button data-hf-part="control" disabled>x</button></div>`);
      click(disabled.el.querySelector('[data-hf-part="control"]'));
      assert.equal(disabled.el.querySelector('[data-hf-part="control"]').getAttribute('aria-pressed'), 'false');

      const sw = mount('switch', `<div data-hf="switch"><button data-hf-part="control"><span data-hf-part="thumb"></span>Wi-Fi</button></div>`);
      const button = sw.el.querySelector('[data-hf-part="control"]');
      const thumb = sw.el.querySelector('[data-hf-part="thumb"]');
      assert.equal(button.getAttribute('role'), 'switch');
      assert.equal(button.getAttribute('aria-checked'), 'false');
      click(button);
      assert.equal(button.getAttribute('aria-checked'), 'true');
      assert.equal(thumb.dataset.state, 'checked');
    });
  });
});

test('radio-group: arrows, wrap, roving tabindex, change events', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, key, assert } = window.hf;
      const { el, controller } = mount(
        'radio-group',
        `<div data-hf="radio-group" data-hf-options='{"value":"b"}'>
           <button data-hf-part="radio" data-value="a">A</button>
           <button data-hf-part="radio" data-value="b">B</button>
           <button data-hf-part="radio" data-value="c">C</button>
         </div>`,
      );
      const radios = [...el.querySelectorAll('[data-hf-part="radio"]')];
      const changes = [];
      el.addEventListener('hf:change', (event) => changes.push(event.detail.value));

      assert.equal(controller.value, 'b');
      assert.equal(radios[1].getAttribute('aria-checked'), 'true');
      assert.equal(radios[1].tabIndex, 0);
      assert.equal(radios[0].tabIndex, -1);
      assert.equal(el.getAttribute('role'), 'radiogroup');

      radios[1].focus();
      key(radios[1], 'ArrowRight');
      assert.equal(controller.value, 'c');
      key(radios[2], 'ArrowRight');
      assert.equal(controller.value, 'a');
      key(radios[0], 'ArrowLeft');
      assert.equal(controller.value, 'c');
      assert.deepEqual(changes, ['c', 'a', 'c']);
      assert.equal(document.activeElement, radios[2]);
    });
  });
});

test('listbox: single, multi, cursor events, typeahead', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, key, assert } = window.hf;
      const multi = mount(
        'listbox',
        `<ul data-hf="listbox" data-hf-options='{"multiple":true,"selected":["html"]}'>
           <li data-hf-part="option" data-value="html">HTML</li>
           <li data-hf-part="option" data-value="css">CSS</li>
         </ul>`,
      );
      const options = multi.el.querySelectorAll('[data-hf-part="option"]');
      assert.equal(multi.el.getAttribute('aria-multiselectable'), 'true');
      assert.equal(options[0].getAttribute('aria-selected'), 'true');
      click(options[1]);
      assert.deepEqual(multi.controller.value, ['html', 'css']);
      click(options[1]);
      assert.deepEqual(multi.controller.value, ['html']);

      const active = [];
      multi.el.addEventListener('hf:active', (event) => active.push(event.detail.value));
      options[0].focus();
      key(options[0], 'ArrowDown');
      assert.equal(multi.controller.activeIndex, 1);
      assert.ok(options[1].hasAttribute('data-active'));
      key(options[1], 'ArrowDown');
      assert.equal(multi.controller.activeIndex, 0);
      assert.deepEqual(active, ['css', 'html']);

      const single = mount(
        'listbox',
        `<ul data-hf="listbox">
           <li data-hf-part="option" data-value="a">Apple</li>
           <li data-hf-part="option" data-value="b">Banana</li>
           <li data-hf-part="option" data-value="c">Cherry</li>
         </ul>`,
      );
      single.controller.select('b');
      assert.equal(single.controller.value, 'b');
      single.el.querySelector('[data-hf-part="option"]').focus();
      key(single.el.querySelector('[data-hf-part="option"]'), 'c');
      assert.equal(document.activeElement.dataset.value, 'c', 'typeahead');
    });
  });
});

test('combobox: filter, choose, Escape, custom value, aria-activedescendant', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, key, assert } = window.hf;
      const { el, controller } = mount(
        'combobox',
        `<div data-hf="combobox">
           <input data-hf-part="input" />
           <ul data-hf-part="listbox">
             <li data-hf-part="option" data-value="node">Node.js</li>
             <li data-hf-part="option" data-value="deno">Deno</li>
             <li data-hf-part="option" data-value="bun">Bun</li>
           </ul>
         </div>`,
      );
      const input = el.querySelector('[data-hf-part="input"]');
      const list = el.querySelector('[data-hf-part="listbox"]');
      const options = [...el.querySelectorAll('[data-hf-part="option"]')];
      const changes = [];
      el.addEventListener('hf:change', (event) => changes.push(event.detail.value));

      assert.equal(input.getAttribute('role'), 'combobox');
      assert.equal(input.getAttribute('aria-expanded'), 'false');
      assert.equal(list.getAttribute('role'), 'listbox');
      assert.equal(options[2].getAttribute('role'), 'option');
      assert.equal(input.getAttribute('aria-controls'), list.id);

      input.value = 'den';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      assert.deepEqual(options.map((option) => option.hidden), [true, false, true]);
      assert.equal(controller.isOpen, true);
      assert.equal(input.getAttribute('aria-activedescendant'), options[1].id);

      key(input, 'Enter');
      assert.equal(input.value, 'Deno');
      assert.deepEqual(changes, ['deno']);
      assert.equal(controller.isOpen, false);

      input.value = 'o';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      key(input, 'Escape');
      assert.equal(controller.isOpen, false);
      assert.equal(input.value, 'o', 'Escape leaves text');

      input.value = 'custom';
      assert.equal(controller.value, 'custom', 'allowCustom');
    });
  });
});

test('toast: live region, template cloning, max eviction, auto timeout', async () => {
  await withPage(async ({ page }) => {
    await run(page, async () => {
      const { mount, assert } = window.hf;
      const { el, controller } = mount(
        'toast',
        `<div data-hf="toast" data-hf-options='{"max":2,"timeout":40}'>
           <div data-hf-part="region"></div>
           <template data-hf-part="template">
             <div data-hf-part="toast"><span data-hf-part="message"></span></div>
           </template>
         </div>`,
      );
      const region = el.querySelector('[data-hf-part="region"]');
      assert.equal(region.getAttribute('role'), 'status');
      assert.equal(region.getAttribute('aria-live'), 'polite');

      controller.show('one');
      controller.show('two');
      controller.show('three');
      assert.equal(controller.count, 2);
      assert.deepEqual(
        [...region.querySelectorAll('[data-hf-part="message"]')].map((node) => node.textContent),
        ['two', 'three'],
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(controller.count, 0, 'auto dismiss');
    });
  });
});

test('tooltip: focus/blur, Escape, aria-describedby, hover delay', async () => {
  await withPage(async ({ page }) => {
    await run(page, async () => {
      const { mount, key, assert } = window.hf;
      const { el, controller } = mount(
        'tooltip',
        `<div data-hf="tooltip" data-hf-options='{"delay":10,"hideDelay":10}'>
           <button data-hf-part="trigger">Hover</button>
           <div data-hf-part="content">Saves a draft</div>
         </div>`,
      );
      const trigger = el.querySelector('[data-hf-part="trigger"]');
      const content = el.querySelector('[data-hf-part="content"]');
      assert.equal(content.getAttribute('role'), 'tooltip');
      assert.equal(trigger.getAttribute('aria-describedby'), content.id);

      trigger.focus();
      assert.equal(controller.isOpen, true);
      assert.equal(content.hidden, false);
      key(trigger, 'Escape');
      assert.equal(controller.isOpen, false);

      trigger.dispatchEvent(new Event('pointerenter'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(controller.isOpen, true, 'hover opens after delay');
      trigger.dispatchEvent(new Event('pointerleave'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(controller.isOpen, false, 'leave hides');
    });
  });
});

test('popover: open, outside pointerdown, Escape, focus not trapped', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { mount, click, key, assert } = window.hf;
      const { el, controller } = mount(
        'popover',
        `<div data-hf="popover">
           <button data-hf-part="trigger">Filters</button>
           <div data-hf-part="content"><button id="inside">ok</button></div>
         </div>`,
      );
      const trigger = el.querySelector('[data-hf-part="trigger"]');
      const content = el.querySelector('[data-hf-part="content"]');
      assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(trigger.getAttribute('aria-controls'), content.id);

      click(trigger);
      assert.equal(controller.isOpen, true);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(content.hidden, false);

      const outside = document.createElement('div');
      document.body.append(outside);
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      assert.equal(controller.isOpen, false);

      click(trigger);
      key(content, 'Escape');
      assert.equal(controller.isOpen, false);
    });
  });
});

test('runtime: mounts on start, observes added nodes, destroys on removal, use()', async () => {
  await withPage(async ({ page }) => {
    await run(page, async () => {
      const { runtime, assert } = window.hf;
      document.body.innerHTML = `
        <div data-hf="disclosure" id="a"><button data-hf-part="trigger">A</button><div data-hf-part="panel">a</div></div>
        <div data-hf="nope" id="bad"></div>`;
      const warnings = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      console.warn = (...args) => warnings.push(String(args[0]));
      console.error = (...args) => warnings.push(String(args[0]));
      try {
        runtime.start();
        const a = document.getElementById('a');
        assert.ok(a.hasAttribute('data-hf-ready'), 'mounted on start');
        assert.ok(document.getElementById('bad').hasAttribute('data-hf-error'), 'bad foundation reported');

        const controller = runtime.use('#a');
        controller.setOpen(true, 'test');
        assert.equal(a.dataset.state, 'open');

        const later = document.createElement('div');
        later.id = 'later';
        later.setAttribute('data-hf', 'toggle');
        later.innerHTML = '<button data-hf-part="control">x</button>';
        document.body.append(later);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        assert.ok(later.hasAttribute('data-hf-ready'), 'mutation observer mounts new nodes');

        later.remove();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
        runtime.stop();
      }
    });
  });
});

test('compose: components interpolate props, distribute slots, react to attributes', async () => {
  await withPage(async ({ page }) => {
    await run(page, () => {
      const { compose, runtime, assert } = window.hf;
      compose.defineComponent({
        name: 'test-card',
        props: { title: 'Default', open: false, count: 0 },
        styles: './card.css',
        template: `<article data-hf-part="root">
            <h2 data-hf-part="title">{{ title }}</h2>
            <div data-hf-slot="default"></div>
            <div data-hf-slot="extra"></div>
          </article>`,
        setup({ root, props }) {
          const title = root.querySelector('[data-hf-part="title"]');
          return {
            update(next) {
              title.dataset.updated = String(next.count);
            },
            destroy() {
              root.dataset.destroyed = 'yes';
            },
          };
        },
      });

      const el = document.createElement('hf-test-card');
      el.setAttribute('title', 'Hello');
      el.setAttribute('count', '3');
      el.innerHTML = '<p id="body">body</p><span slot="extra" id="extra">extra</span>';
      document.body.append(el);

      assert.equal(el.querySelector('[data-hf-part="title"]').textContent, 'Hello');
      assert.equal(el.props.count, 3, 'numbers are coerced');
      assert.equal(el.querySelector('#body').parentElement.dataset.hfSlot, 'default', 'default slot');
      assert.equal(el.querySelector('#extra').parentElement.dataset.hfSlot, 'extra', 'named slot');
      assert.equal(document.querySelector('link[data-hf-styles]').getAttribute('href'), new URL('./card.css', document.baseURI).href);

      el.setAttribute('title', 'Changed');
      assert.equal(el.querySelector('[data-hf-part="title"]').textContent, 'Changed', 'prop update re-renders text');
      assert.equal(el.querySelector('[data-hf-part="title"]').dataset.updated, '3');

      el.setProps({ count: 7, open: true });
      assert.equal(el.getAttribute('open'), 'true');
      assert.equal(el.props.count, 7);

      const created = compose.createComponent('test-card', { title: 'Programmatic' });
      document.body.append(created);
      assert.equal(created.querySelector('[data-hf-part="title"]').textContent, 'Programmatic');

      el.remove();
      runtime.stop();
    });
  });
});

test('compose: nested foundation inside a component is mounted and reachable', async () => {
  await withPage(async ({ page }) => {
    await run(page, async () => {
      const { compose, runtime, assert } = window.hf;
      compose.defineComponent({
        name: 'panel-wrap',
        props: { open: false },
        template: `<div class="wrap">
            <div data-hf="disclosure"><button data-hf-part="trigger">Toggle</button><div data-hf-part="panel">content</div></div>
          </div>`,
        setup({ root, props }) {
          return {
            update(next) {
              if (next.open) runtime.use(root.querySelector('[data-hf="disclosure"]')).setOpen(true, 'prop');
            },
          };
        },
      });
      const el = document.createElement('hf-panel-wrap');
      document.body.append(el);
      runtime.start();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const disclosure = el.querySelector('[data-hf="disclosure"]');
      assert.ok(disclosure.hasAttribute('data-hf-ready'), 'nested foundation mounted');
      el.setAttribute('open', 'true');
      assert.equal(disclosure.querySelector('[data-hf-part="panel"]').hidden, false);
      runtime.stop();
    });
  });
});

test('validate: no foundation violates the headless contract', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const foundationDir = new URL('../foundation/', import.meta.url);
  const files = (await readdir(foundationDir)).filter((file) => file.endsWith('.js') && !['core.js', 'index.js'].includes(file));
  for (const file of files) {
    const lines = (await readFile(new URL(file, foundationDir), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
      assert.doesNotMatch(line, /\.className\s*=/, `${file}:${index + 1} assigns className`);
      assert.doesNotMatch(line, /\.classList\.(add|remove|toggle)/, `${file}:${index + 1} mutates classList`);
      assert.doesNotMatch(line, /\.style\.[a-zA-Z]+\s*=/, `${file}:${index + 1} writes inline style`);
      assert.doesNotMatch(line, /<style\b/, `${file}:${index + 1} ships a style tag`);
    });
  }
});
