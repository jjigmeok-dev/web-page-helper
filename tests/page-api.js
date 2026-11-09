import * as core from '/foundation/core.js';
import { foundations } from '/foundation/index.js';
import * as runtime from '/runtime/index.js';
import * as compose from '/compose/component.js';

/**
 * Page-side test API. Tests run inside the real browser so focus,
 * activeElement, getClientRects and keyboard behavior are genuine.
 */

const controllers = new Set();

function fail(message) {
  throw new Error(message);
}

function format(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const assert = {
  equal(actual, expected, message = '') {
    if (actual !== expected) fail(`${message}\nexpected: ${format(expected)}\nactual:   ${format(actual)}`);
  },
  notEqual(actual, expected, message = '') {
    if (actual === expected) fail(`${message}\nexpected not: ${format(expected)}`);
  },
  deepEqual(actual, expected, message = '') {
    const a = format(actual);
    const b = format(expected);
    if (a !== b) fail(`${message}\nexpected: ${b}\nactual:   ${a}`);
  },
  ok(value, message = '') {
    if (!value) fail(message || `expected truthy, got ${format(value)}`);
  },
  notOk(value, message = '') {
    if (value) fail(message || `expected falsy, got ${format(value)}`);
  },
  throws(fn, message = '') {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) fail(message || 'expected function to throw');
  },
};

function mount(name, html, helpers = {}) {
  const foundation = foundations[name];
  if (!foundation) throw new Error(`unknown foundation ${name}`);
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  document.body.append(host);
  const el = host.firstElementChild;
  const controller = foundation.mount(el, { ...core, ...helpers });
  controllers.add(controller);
  return { el, host, controller };
}

function click(el) {
  el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

function key(el, name, init = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  if (init.shiftKey !== undefined) {
    Object.defineProperty(event, 'shiftKey', { value: Boolean(init.shiftKey) });
  }
  el.dispatchEvent(event);
  return event;
}

function reset() {
  for (const controller of controllers) {
    try {
      controller.destroy?.();
    } catch {
      /* already destroyed */
    }
  }
  controllers.clear();
  runtime.stop();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-hf-scroll-lock');
  for (const stale of document.querySelectorAll('link[data-hf-styles]')) stale.remove();
  document.body.focus?.();
}

window.hf = { mount, click, key, reset, assert, core, foundations, runtime, compose };
window.assert = assert;
window.__hfReady = true;
