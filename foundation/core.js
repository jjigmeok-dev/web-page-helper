/**
 * Shared primitives for headless foundations.
 *
 * Rules every foundation follows (enforced by `npm run validate`):
 * - It may set ARIA attributes, `hidden`, `inert`, `data-state`, `data-hf-*`
 *   and `tabindex` — never `class`, `className`, `style`, or a `<style>` tag.
 * - It ships zero visual CSS. Consumers own appearance and layout.
 * - Every mount returns a controller with `destroy()`.
 */

export const KEY = {
  TAB: 'Tab',
  ENTER: 'Enter',
  SPACE: ' ',
  ESCAPE: 'Escape',
  ARROW_UP: 'ArrowUp',
  ARROW_DOWN: 'ArrowDown',
  ARROW_LEFT: 'ArrowLeft',
  ARROW_RIGHT: 'ArrowRight',
  HOME: 'Home',
  END: 'End',
};

const TABBABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
  'select:not([disabled]),textarea:not([disabled]),iframe,summary,[contenteditable="true"],' +
  '[tabindex]:not([tabindex="-1"])';

let counter = 0;

export function needsId(el, prefix = 'hf') {
  if (!el.id) {
    counter += 1;
    el.id = `${prefix}-${counter}`;
  }
  return el.id;
}

/** True when `el` belongs to `root`, not to a nested `[data-hf]` component. */
export function owns(root, el) {
  if (!el || !root.contains(el)) return false;
  const owner = el.closest('[data-hf]');
  if (!owner) return true;
  return owner === (root.matches('[data-hf]') ? root : root.closest('[data-hf]'));
}

/** First descendant marked with `data-hf-part="name"`, ignoring nested components. */
export function part(root, name) {
  return parts(root, name)[0];
}

/** All descendants marked with `data-hf-part="name"`, ignoring nested components. */
export function parts(root, name) {
  return Array.from(root.querySelectorAll(`[data-hf-part="${name}"]`)).filter((el) => owns(root, el));
}

/**
 * Marks a `<button>` part as a control, not a form submitter.
 *
 * A `<button>` with no `type` inside a `<form>` defaults to `type="submit"`.
 * Every foundation part is a control — a toggle, a tab, a menu item — so the
 * default made each click submit the form and navigate away. Callers that
 * really want a submitter (e.g. a dialog's `confirm`) set `type="submit"`
 * explicitly and are left alone here.
 */
export function nonSubmit(el) {
  if (el.tagName !== 'BUTTON') return el;
  if (!el.hasAttribute('type')) el.setAttribute('type', 'button');
  return el;
}

/** Reads `data-hf-options='{"key": value}'` and merges it over defaults. */
export function options(root, defaults = {}) {
  const raw = root.getAttribute('data-hf-options');
  if (!raw) return { ...defaults };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('options must be an object');
    return { ...defaults, ...parsed };
  } catch (error) {
    console.warn(`[hf] ignoring invalid data-hf-options on #${root.id || root.tagName}`, error);
    return { ...defaults };
  }
}

/** Reflects behavior state for consumer CSS (`[data-state="open"]`). */
export function setState(el, value) {
  el.dataset.state = value;
}

export function emit(el, type, detail) {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
}

export function isDisabled(el) {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

export function focusable(container) {
  return Array.from(container.querySelectorAll(TABBABLE)).filter(
    (el) => !el.hidden && !el.closest('[hidden]') && (el.getClientRects().length > 0 || el === document.activeElement),
  );
}

/** Focuses the first tabbable child, falling back to the container itself. */
export function focusFirst(container, fallback = container) {
  const target = focusable(container)[0] || fallback;
  target.focus({ preventScroll: true });
  return target;
}

/** Keeps Tab/Shift+Tab inside `container`. Call from a keydown handler. */
export function trapTab(event, container) {
  if (event.key !== KEY.TAB) return;
  const items = focusable(container);
  if (!items.length) {
    event.preventDefault();
    container.focus({ preventScroll: true });
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** Arrow-key index movement with optional wrapping. */
export function moveIndex(length, current, step, loop = true) {
  if (!length) return -1;
  const next = current + step;
  if (next < 0) return loop ? length - 1 : 0;
  if (next >= length) return loop ? 0 : length - 1;
  return next;
}

export function labelOf(el) {
  return (el.getAttribute('data-label') || el.textContent || '').trim().toLowerCase();
}

/** Multi-character typeahead with a 500ms buffer, WAI-ARIA style. */
export function typeahead(select) {
  let buffer = '';
  let timer = 0;
  return {
    push(char) {
      clearTimeout(timer);
      buffer += char.toLowerCase();
      timer = setTimeout(() => {
        buffer = '';
      }, 500);
      const match = select(buffer);
      return match;
    },
    reset() {
      clearTimeout(timer);
      buffer = '';
    },
  };
}

/** Marks one item tabbable and the rest not (roving tabindex). */
export function roving(items, index) {
  items.forEach((item, i) => {
    item.tabIndex = i === index ? 0 : -1;
  });
}

export function axisKeys(orientation) {
  return orientation === 'vertical'
    ? { prev: KEY.ARROW_UP, next: KEY.ARROW_DOWN }
    : { prev: KEY.ARROW_LEFT, next: KEY.ARROW_RIGHT };
}
