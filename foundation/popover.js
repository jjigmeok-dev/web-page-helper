import { KEY, emit, needsId, options, part, setState, trapTab } from './core.js';
import { capabilities, createLayer } from './layer.js';

/**
 * A small popover layer (non-modal by default).
 *
 * <div data-hf="popover">
 *   <button data-hf-part="trigger">Filters</button>
 *   <div data-hf-part="content">…</div>
 * </div>
 *
 * Two implementations, chosen by feature detection (see `layer.js`):
 *
 * 1. **Native** — `popover="auto"` plus the invoker command attributes. The
 *    browser then owns top layer, light dismiss, `Esc` and returning focus to
 *    the trigger; this module mirrors state and emits events.
 * 2. **In-flow fallback** — `hidden` plus `pointerdown`/`keydown` handlers,
 *    used when the browser lacks either the Popover API or anchor positioning.
 *
 * The consumer positions the panel:
 *
 *   [data-hf-part='trigger'] { anchor-name: --my-popover; }
 *   [data-hf-part='content'] {
 *     position: fixed; margin: 0;
 *     position-anchor: --my-popover;
 *     position-area: bottom span-right;
 *     position-try-fallbacks: flip-block;
 *   }
 */
export const meta = {
  name: 'popover',
  file: import.meta.url,
  summary: 'Anchored non-modal layer dismissed by Escape or outside click.',
  parts: { trigger: 'button', content: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['trigger', 'content'],
  options: { defaultOpen: false, closeOnEscape: true, closeOnOutside: true, modal: false },
  events: ['hf:open', 'hf:close'],
};

export function mount(root) {
  const trigger = part(root, 'trigger');
  const content = part(root, 'content');
  if (!trigger || !content) throw new Error('[hf] popover needs [data-hf-part="trigger"] and [data-hf-part="content"]');
  const opts = options(root, meta.options);
  const { hasCommand } = capabilities();

  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', needsId(content, 'hf-popover'));
  if (!content.hasAttribute('role')) content.setAttribute('role', 'dialog');
  if (opts.modal) content.setAttribute('aria-modal', 'true');
  if (!content.hasAttribute('tabindex')) content.tabIndex = -1;

  // `auto` gives Escape and light dismiss for free. Anything the options
  // narrow down needs `manual`, because a `beforetoggle` close is not
  // cancelable - there is no way to veto a native dismissal.
  const wantsManual = !opts.closeOnEscape || !opts.closeOnOutside || opts.modal;

  let open = false;
  let destroyed = false;
  // Set while *we* drive the layer, so a platform-initiated `toggle`
  // (Escape, light dismiss) is reported as `dismiss` instead of inheriting a
  // stale reason from the last API call.
  let reason = null;
  let restoreTo = null;

  function sync(next) {
    trigger.setAttribute('aria-expanded', String(next));
    setState(root, next ? 'open' : 'closed');
    setState(trigger, next ? 'open' : 'closed');
    setState(content, next ? 'open' : 'closed');
  }

  function show(next, why) {
    if (next === open) return;
    open = next;
    sync(next);
    if (next) {
      if (opts.modal) {
        restoreTo = document.activeElement;
        content.focus({ preventScroll: true });
      }
      emit(root, 'hf:open', { reason: why });
    } else {
      if (opts.modal) {
        const target = restoreTo instanceof HTMLElement ? restoreTo : trigger;
        target.focus({ preventScroll: true });
        restoreTo = null;
      }
      emit(root, 'hf:close', { reason: why });
    }
  }

  const layer = createLayer(content, {
    manual: wantsManual,
    onToggle: (next) => {
      const why = reason ?? 'dismiss';
      reason = null;
      show(next, why);
    },
  });
  const { isNative } = layer;

  if (isNative && hasCommand) {
    trigger.setAttribute('commandfor', content.id);
    trigger.setAttribute('command', 'toggle-popover');
  }

  function setOpen(next, why) {
    if (destroyed || next === open) return;
    reason = why;
    // Drive the layer, then mirror explicitly. The `toggle` listener has
    // already applied this change synchronously, so `show` no-ops here; when
    // the platform handles it asynchronously this keeps `isOpen` correct now.
    if (next) layer.show();
    else layer.hide();
    show(next, why);
    reason = null;
  }

  // `auto` dismisses itself; `manual` needs these. `modal` also needs the trap,
  // which is the one piece the Popover API has no equivalent for - modal layers
  // belong in the `dialog` foundation.
  const onKey = (event) => {
    if (!open) return;
    // With `auto` the platform closes on a real Escape and hands focus back,
    // so intercepting that would only race it. `manual` - and a synthetic key,
    // which the platform never sees - needs this handler.
    if (event.key === KEY.ESCAPE && opts.closeOnEscape && (!isNative || wantsManual || !event.isTrusted)) {
      event.preventDefault();
      setOpen(false, 'escape');
      if (!isNative) trigger.focus({ preventScroll: true });
    } else if (opts.modal) {
      trapTab(event, content);
    }
  };

  const onOutside = (event) => {
    if (!open || !opts.closeOnOutside || root.contains(event.target)) return;
    setOpen(false, 'outside');
  };

  // A trusted click is already handled by `commandfor`, so toggling here too
  // would undo it in the same gesture. A synthetic click never reaches the
  // invoker command, which is what makes `trigger.click()` and the test
  // harness work; only that case is handled here.
  const onTriggerClick = (event) => {
    if (isNative && hasCommand && event.isTrusted) return;
    setOpen(!open, 'trigger');
  };

  root.addEventListener('keydown', onKey);
  trigger.addEventListener('click', onTriggerClick);
  // `auto` dismisses light clicks natively; this listener is what covers
  // synthetic ones, and it is idempotent when the platform already closed.
  document.addEventListener('pointerdown', onOutside);
  if (opts.defaultOpen) setOpen(true, 'initial');

  return {
    get isOpen() {
      return open;
    },
    /** True when the browser owns dismissal and top layer for this instance. */
    get isNative() {
      return isNative;
    },
    open(why = 'api') {
      setOpen(true, why);
    },
    close(why = 'api') {
      setOpen(false, why);
    },
    toggle(why = 'api') {
      setOpen(!open, why);
    },
    destroy() {
      // Close first: `setOpen` is a no-op once `destroyed` is set.
      if (open) setOpen(false, 'destroy');
      destroyed = true;
      root.removeEventListener('keydown', onKey);
      trigger.removeEventListener('click', onTriggerClick);
      document.removeEventListener('pointerdown', onOutside);
      layer.destroy();
      trigger.removeAttribute('aria-expanded');
      trigger.removeAttribute('aria-haspopup');
      trigger.removeAttribute('aria-controls');
      trigger.removeAttribute('commandfor');
      trigger.removeAttribute('command');
    },
  };
}
