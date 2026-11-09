import { foundations } from '../foundation/index.js';
import { labelOf, typeahead } from '../foundation/core.js';

/**
 * Runtime: upgrades `[data-hf="<foundation>"]` elements in place.
 *
 * - Idempotent: a second `start()` never double-binds.
 * - Mutation-aware: foundations mounted on nodes added later.
 * - Teardown: `stop()` destroys controllers and restores nothing else.
 *
 * Nested components are supported; each foundation only reads its own
 * `data-hf-part` descendants (see `owns()` in core.js).
 */

const live = new WeakMap(); // root element -> controller
let observer = null;
let started = false;

const helpers = { labelOf, typeahead };

function mountOne(el) {
  if (live.has(el)) return live.get(el);
  const name = el.dataset.hf;
  const foundation = foundations[name];
  if (!foundation) {
    console.warn(`[hf] unknown foundation "${name}" on`, el);
    el.setAttribute('data-hf-error', `unknown foundation "${name}"`);
    return null;
  }
  try {
    const controller = foundation.mount(el, helpers);
    live.set(el, controller);
    el.setAttribute('data-hf-ready', '');
    return controller;
  } catch (error) {
    console.error(`[hf] failed to mount "${name}"`, error);
    el.setAttribute('data-hf-error', error.message);
    return null;
  }
}

function scan(root) {
  const selector = '[data-hf]';
  const nodes = [];
  if (root.matches?.(selector)) nodes.push(root);
  nodes.push(...root.querySelectorAll(selector));
  // Mount innermost first so parents that read child state see mounted children.
  for (const el of nodes.reverse()) mountOne(el);
}

function unmount(el) {
  const controller = live.get(el);
  if (!controller) return;
  controller.destroy?.();
  live.delete(el);
  el.removeAttribute('data-hf-ready');
}

export function start(root = document.body) {
  if (started) return api;
  started = true;
  scan(root);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        unmount(node);
        node.querySelectorAll?.('[data-hf]').forEach(unmount);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return api;
}

export function stop() {
  observer?.disconnect();
  observer = null;
  started = false;
}

export function get(el) {
  return live.get(el) ?? null;
}

export function all() {
  return new Map(live);
}

function findBy(root) {
  return typeof root === 'string' ? document.querySelector(root) : root;
}

/** Resolves a component by selector or element; throws with a clear message. */
export function use(selector) {
  const el = findBy(selector);
  if (!el) throw new Error(`[hf] no element for ${selector}`);
  const controller = live.get(el) || mountOne(el);
  if (!controller) throw new Error(`[hf] ${selector} is not an active component`);
  return controller;
}

export const api = { start, stop, get, all, use, foundations };

export default api;
