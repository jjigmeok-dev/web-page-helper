import { KEY, emit, isDisabled, needsId, options, part, parts, setState, trapTab } from './core.js';

/**
 * A small popover layer (non-modal by default).
 *
 * <div data-hf="popover">
 *   <button data-hf-part="trigger">Filters</button>
 *   <div data-hf-part="content">…</div>
 * </div>
 *
 * Differs from `dialog`: no focus trap unless `modal: true`, no page
 * inerting, and it positions against the trigger with plain CSS
 * (`[data-state="open"]` + an anchor wrapper you own).
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

  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', needsId(content, 'hf-popover'));
  if (!content.hasAttribute('role')) content.setAttribute('role', 'dialog');
  content.setAttribute('aria-modal', String(Boolean(opts.modal)));
  if (!content.hasAttribute('tabindex')) content.tabIndex = -1;
  content.hidden = true;

  let open = false;
  let destroyed = false;

  function render(next, reason) {
    if (next === open) return;
    open = next;
    content.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    setState(root, open ? 'open' : 'closed');
    setState(trigger, open ? 'open' : 'closed');
    setState(content, open ? 'open' : 'closed');
    if (open) {
      if (opts.modal) content.focus({ preventScroll: true });
      emit(root, 'hf:open', { reason });
    } else {
      emit(root, 'hf:close', { reason });
    }
  }

  const onTriggerClick = () => render(!open, 'trigger');

  const onKey = (event) => {
    if (!open) return;
    if (event.key === KEY.ESCAPE && opts.closeOnEscape) {
      event.preventDefault();
      render(false, 'escape');
      trigger.focus({ preventScroll: true });
    } else if (opts.modal) {
      trapTab(event, content);
    }
  };

  const onOutside = (event) => {
    if (open && opts.closeOnOutside && !root.contains(event.target)) render(false, 'outside');
  };

  trigger.addEventListener('click', onTriggerClick);
  root.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside);
  render(Boolean(opts.defaultOpen), 'initial');

  return {
    get isOpen() {
      return open;
    },
    open(reason = 'api') {
      if (!destroyed) render(true, reason);
    },
    close(reason = 'api') {
      if (!destroyed) render(false, reason);
    },
    toggle(reason = 'api') {
      if (!destroyed) render(!open, reason);
    },
    destroy() {
      destroyed = true;
      if (open) render(false, 'destroy');
      trigger.removeEventListener('click', onTriggerClick);
      root.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
    },
  };
}
