/**
 * User components: assemble foundations (or other user components) into a
 * named, attribute-driven element — still no build step.
 *
 *   defineComponent({
 *     name: 'media-card',
 *     props: { title: '', tone: 'plain', compact: false },
 *     template: `
 *       <article data-hf-part="card">
 *         <h3>{{ title }}</h3>
 *         <div data-hf-slot="media"></div>
 *         <div data-hf-slot="default"></div>
 *       </article>`,
 *     setup({ root, props, on }) { … },   // optional, returns { update, destroy }
 *   });
 *
 * Usage:
 *   <hf-media-card title="Hello">…children…</hf-media-card>
 *
 * Rules:
 * - `{{ path }}` interpolates a prop into text or an attribute value.
 *   `false`/`null`/`undefined` remove the attribute; `true` sets it empty.
 * - Children with `slot="name"` fill `[data-hf-slot="name"]`; the rest fill
 *   `[data-hf-slot="default"]`.
 * - Props update in place; focus and foundation state survive.
 * - Foundations inside the component are mounted by the runtime observer.
 */

const registry = new Map();
const definitions = new Map();

function toKebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function toCamel(attr) {
  return attr.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function coerce(raw, fallback) {
  if (raw === null) return fallback;
  if (typeof fallback === 'boolean') return raw !== 'false';
  if (typeof fallback === 'number') {
    const number = Number(raw);
    return Number.isFinite(number) ? number : fallback;
  }
  if (Array.isArray(fallback) || (fallback && typeof fallback === 'object')) {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw)) && String(Number(raw)) === raw) return Number(raw);
  return raw;
}

function readProps(el, defaults) {
  const props = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const attr = toKebab(key);
    if (el.hasAttribute(attr)) props[key] = coerce(el.getAttribute(attr), defaults[key]);
  }
  return props;
}

function format(value) {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return '';
  return String(value);
}

/** Replaces `{{ path }}` in text nodes and attribute values; returns updaters. */
function interpolate(root, props) {
  const updates = [];
  const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const template = node.nodeValue;
    if (!template.includes('{{')) continue;
    const path = template.match(/\{\{\s*([\w.]+)\s*\}\}/)?.[1];
    if (!path) continue;
    const read = () => path.split('.').reduce((value, key) => value?.[key], props);
    const apply = () => {
      const value = format(read());
      node.nodeValue = value === null ? '' : value;
    };
    apply();
    updates.push(apply);
  }

  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const template = attr.value;
      if (!template.includes('{{')) continue;
      const path = template.match(/\{\{\s*([\w.]+)\s*\}\}/)?.[1];
      if (!path) continue;
      const name = attr.name;
      const read = () => path.split('.').reduce((value, key) => value?.[key], props);
      const apply = () => {
        const value = format(read());
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
      };
      apply();
      updates.push(apply);
    }
  }
  return updates;
}

/** Moves light-DOM children into their slots, keeping order. */
function distribute(host, root) {
  const slots = new Map();
  for (const slot of root.querySelectorAll('[data-hf-slot]')) {
    const name = slot.dataset.hfSlot;
    if (!slots.has(name)) slots.set(name, slot);
  }
  const children = Array.from(host.childNodes).filter((node) => node !== root);
  for (const child of children) {
    const name = child.nodeType === 1 ? child.getAttribute('slot') : null;
    const target = name ? slots.get(name) : slots.get('default') || slots.get(name);
    if (!target) {
      // No slot for it: leave it where it is (host level) rather than dropping content.
      continue;
    }
    if (child.nodeType === 1) child.removeAttribute('slot');
    target.append(child);
  }
}

function createElement(template) {
  const holder = document.createElement('template');
  holder.innerHTML = template.trim();
  return holder.content.firstElementChild;
}

/**
 * Injects the component stylesheet once, resolved against `baseUrl`.
 * No bundler: the link is a plain network request the dev server serves.
 */
const linkedStyles = new Set();

function linkStyles(href) {
  if (!href || linkedStyles.has(href)) return;
  linkedStyles.add(href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.hfStyles = '';
  document.head.append(link);
}

/** True only where custom elements and a document exist (i.e. the browser). */
export function isBrowser() {
  return typeof document !== 'undefined' && typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined';
}

/** Serializable view of a definition, used by tooling outside the browser. */
export function describeDefinition(definition) {
  const { name, template = '', props = {}, styles = null } = definition;
  return Object.freeze({
    __hfDefinition: true,
    name,
    tag: `hf-${name}`,
    props: { ...props },
    template,
    styles,
  });
}

export function defineComponent(definition) {
  const { name, template, props: defaults = {}, setup, styles, baseUrl } = definition;
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`[hf] component name must be kebab-case, got "${name}"`);
  }
  if (registry.has(name)) return registry.get(name);
  if (definitions.has(name)) {
    const existing = definitions.get(name);
    return isBrowser() ? registry.get(name) : describeDefinition(existing);
  }

  const tag = `hf-${name}`;
  const href = isBrowser() && styles ? new URL(styles, baseUrl ?? document.baseURI).href : null;
  definitions.set(name, definition);

  // Node-side consumers (the studio's project scanner) only need the
  // definition metadata; there is no custom element registry there.
  if (!isBrowser()) return describeDefinition(definition);

  class UserComponent extends HTMLElement {
    static get observedAttributes() {
      return Object.keys(defaults).map(toKebab);
    }

    #props = {};
    #updates = [];
    #instance = null;
    #mounted = false;

    connectedCallback() {
      if (this.#mounted) return;
      this.#mounted = true;
      if (href) linkStyles(href);
      this.#props = readProps(this, defaults);
      const root = createElement(template);
      if (!root) throw new Error(`[hf] component "${name}" template is empty`);
      root.setAttribute('data-hf-component', name);
      this.append(root);
      distribute(this, root);
      this.#updates = interpolate(root, this.#props);
      this.#instance = setup?.({
        el: this,
        root,
        props: this.#props,
        on: (type, handler) => this.addEventListener(type, handler),
        set: (patch) => this.setProps(patch),
        emit: (type, detail) => this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true })),
      });
      this.dispatchEvent(new CustomEvent('hf:mount', { detail: { name }, bubbles: true }));
    }

    disconnectedCallback() {
      this.#instance?.destroy?.();
      this.#instance = null;
      this.#mounted = false;
      for (const child of Array.from(this.children)) {
        if (child.hasAttribute('data-hf-component')) child.remove();
      }
      this.#updates = [];
    }

    attributeChangedCallback(attr, previous, next) {
      if (!this.#mounted || previous === next) return;
      const key = toCamel(attr);
      this.#props[key] = coerce(next, defaults[key]);
      this.#updates.forEach((apply) => apply());
      this.#instance?.update?.(this.#props);
      this.dispatchEvent(new CustomEvent('hf:prop', { detail: { name, key, value: this.#props[key] }, bubbles: true }));
    }

    get props() {
      return { ...this.#props };
    }

    setProps(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const attr = toKebab(key);
        if (value === false || value === null || value === undefined) this.removeAttribute(attr);
        else this.setAttribute(attr, String(value));
      }
    }
  }

  customElements.define(tag, UserComponent);
  registry.set(name, UserComponent);
  return UserComponent;
}

/** Programmatic creation with props applied as attributes. */
export function createComponent(name, props = {}, children = []) {
  const Host = registry.get(name);
  if (!Host) throw new Error(`[hf] component "${name}" is not defined`);
  const el = document.createElement(`hf-${name}`);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    el.setAttribute(toKebab(key), value === true ? '' : String(value));
  }
  if (typeof children === 'string') el.innerHTML = children;
  else children.forEach((child) => el.append(child));
  return el;
}

export function getComponent(name) {
  return definitions.get(name) ?? null;
}

export function componentNames() {
  return Array.from(definitions.keys());
}

export const componentRegistry = registry;
