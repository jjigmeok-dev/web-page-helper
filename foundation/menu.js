import { KEY, emit, isDisabled, needsId, options, part, parts, setState } from './core.js';
import { capabilities, createLayer } from './layer.js';

/**
 * Menu: a button that opens a listbox-like menu of actions.
 *
 * <div data-hf="menu">
 *   <button data-hf-part="trigger" aria-haspopup="menu">Actions</button>
 *   <div data-hf-part="list" role="menu">
 *     <button data-hf-part="item" role="menuitem">Edit</button>
 *     <button data-hf-part="item" role="menuitem">Delete</button>
 *   </div>
 * </div>
 *
 * The list is an anchored layer (see `layer.js`). Promoting it matters: inside
 * a card with `overflow: hidden` the in-flow list measured 165px tall but only
 * 5px visible, so it is promoted to the top layer wherever the browser can
 * position it. Consumers position it with anchor positioning:
 *
 *   [data-hf-part='trigger'] { anchor-name: --my-menu; }
 *   [data-hf-part='list'] {
 *     position: fixed; margin: 0;
 *     position-anchor: --my-menu;
 *     position-area: bottom span-right;
 *     position-try-fallbacks: flip-block;
 *   }
 *
 * Items marked `aria-disabled="true"` stay focusable but cannot activate.
 * Use `data-hf-part="separator"` for dividers (decorative: supply own markup).
 */
export const meta = {
  name: 'menu',
  file: import.meta.url,
  summary: 'Trigger + menu with arrow navigation and typeahead.',
  parts: { trigger: 'button', list: 'any', item: 'button', separator: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['trigger', 'list'],
  options: { placement: 'bottom-start', loop: true, typeahead: true },
  events: ['hf:open', 'hf:close', 'hf:select'],
};

export function mount(root, { labelOf, typeahead: makeTypeahead } = {}) {
  const trigger = part(root, 'trigger');
  const list = part(root, 'list');
  if (!trigger || !list) throw new Error('[hf] menu needs [data-hf-part="trigger"] and [data-hf-part="list"]');
  const opts = options(root, meta.options);
  const items = () => parts(root, 'item');

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', needsId(list, 'hf-menu-list'));
  if (!list.hasAttribute('role')) list.setAttribute('role', 'menu');
  // `auto` supplies light dismiss and Escape; the list never wants to outlive
  // an interaction started anywhere else.
  const layer = createLayer(list, { onToggle: (next) => render(next, reason ?? 'dismiss') });
  const { isNative } = layer;
  const { hasCommand } = capabilities();
  if (isNative && hasCommand) {
    trigger.setAttribute('commandfor', list.id);
    trigger.setAttribute('command', 'toggle-popover');
  }

  let open = false;
  let active = -1;
  let destroyed = false;
  let reason = null;

  const search = makeTypeahead
    ? makeTypeahead((text) => items().findIndex((item) => (labelOf ? labelOf(item) : item.textContent.trim().toLowerCase()).startsWith(text)))
    : null;

  function focusItem(index) {
    const list_ = items();
    if (!list_.length) return;
    active = (index + list_.length) % list_.length;
    list_.forEach((item, i) => {
      item.tabIndex = i === active ? 0 : -1;
    });
    list_[active].focus({ preventScroll: true });
  }

  function render(next, why) {
    if (next === open) return;
    open = next;
    trigger.setAttribute('aria-expanded', String(open));
    setState(root, open ? 'open' : 'closed');
    setState(trigger, open ? 'open' : 'closed');
    if (open) {
      const list_ = items();
      const checked = list_.findIndex((item) => item.getAttribute('aria-checked') === 'true');
      focusItem(checked >= 0 ? checked : 0);
      emit(root, 'hf:open', { reason: why });
    } else {
      active = -1;
      items().forEach((item) => {
        item.tabIndex = -1;
      });
      emit(root, 'hf:close', { reason: why });
    }
  }

  /** Drives the layer, then mirrors. `toggle` has usually already applied it. */
  function setOpen(next, why) {
    if (destroyed || next === open) return;
    reason = why;
    if (next) layer.show();
    else layer.hide();
    render(next, why);
    reason = null;
  }

  function choose(index, reason) {
    const item = items()[index];
    if (!item || isDisabled(item)) return;
    emit(root, 'hf:select', { index, value: item.dataset.value ?? item.id, reason });
    if (item.getAttribute('role') === 'menuitemcheckbox' || item.getAttribute('role') === 'menuitemradio') {
      const value = item.getAttribute('aria-checked') !== 'true';
      item.setAttribute('aria-checked', String(value));
    }
    setOpen(false, 'select');
    trigger.focus({ preventScroll: true });
  }

  // A trusted click is already handled by `commandfor`; a synthetic one never
  // reaches the invoker command, so only that case falls through to JS.
  const onTriggerClick = (event) => {
    if (isNative && hasCommand && event.isTrusted) return;
    setOpen(!open, 'trigger');
  };
  const onTriggerKey = (event) => {
    if (event.key === KEY.ARROW_DOWN || event.key === KEY.ENTER || event.key === KEY.SPACE) {
      event.preventDefault();
      setOpen(true, 'keyboard');
    } else if (event.key === KEY.ARROW_UP) {
      event.preventDefault();
      setOpen(true, 'keyboard');
      focusItem(items().length - 1);
    }
  };

  const onListKey = (event) => {
    const list_ = items();
    if (event.key === KEY.ARROW_DOWN) {
      event.preventDefault();
      focusItem(active + 1);
    } else if (event.key === KEY.ARROW_UP) {
      event.preventDefault();
      focusItem(active - 1);
    } else if (event.key === KEY.HOME) {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === KEY.END) {
      event.preventDefault();
      focusItem(list_.length - 1);
    } else if (event.key === KEY.ESCAPE) {
      // `auto` closes itself for a real key press and restores focus. A
      // synthetic key never reaches the platform, so it is handled here.
      if (!isNative || !event.isTrusted) {
        event.preventDefault();
        setOpen(false, 'escape');
        trigger.focus({ preventScroll: true });
      }
    } else if (event.key === KEY.TAB) {
      setOpen(false, 'tab');
    } else if (event.key === KEY.ENTER || event.key === KEY.SPACE) {
      event.preventDefault();
      choose(active, 'keyboard');
    } else if (search && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const index = search.push(event.key);
      if (index >= 0) {
        event.preventDefault();
        focusItem(index);
      }
    }
  };

  const onClick = (event) => {
    const item = event.target.closest('[data-hf-part="item"]');
    if (item && root.contains(item)) choose(items().indexOf(item), 'click');
  };

  const onOutside = (event) => {
    if (open && !root.contains(event.target)) setOpen(false, 'outside');
  };

  trigger.addEventListener('keydown', onTriggerKey);
  trigger.addEventListener('click', onTriggerClick);
  list.addEventListener('keydown', onListKey);
  list.addEventListener('click', onClick);
  // `auto` dismisses light clicks natively; this is what covers synthetic
  // ones, and it is idempotent when the platform already closed the layer.
  document.addEventListener('pointerdown', onOutside);

  return {
    get isOpen() {
      return open;
    },
    /** True when the browser owns top layer and dismissal for this instance. */
    get isNative() {
      return isNative;
    },
    open(why = 'api') {
      setOpen(true, why);
    },
    close(why = 'api') {
      setOpen(false, why);
    },
    destroy() {
      // Close first: `setOpen` is a no-op once `destroyed` is set.
      if (open) setOpen(false, 'destroy');
      destroyed = true;
      trigger.removeEventListener('click', onTriggerClick);
      trigger.removeEventListener('keydown', onTriggerKey);
      list.removeEventListener('keydown', onListKey);
      list.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onOutside);
      trigger.removeAttribute('commandfor');
      trigger.removeAttribute('command');
      layer.destroy();
    },
  };
}
