import { KEY, emit, isDisabled, needsId, options, part, setState, nonSubmit } from './core.js';

/**
 * Disclosure: one trigger toggles one panel.
 *
 * <div data-hf="disclosure" data-hf-options='{"defaultOpen":false}'>
 *   <button data-hf-part="trigger">Details</button>
 *   <div data-hf-part="panel">…</div>
 * </div>
 */
export const meta = {
  name: 'disclosure',
  file: import.meta.url,
  summary: 'A button that shows and hides one region.',
  parts: { trigger: 'button', panel: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['trigger', 'panel'],
  options: { defaultOpen: false, disabled: false },
  events: ['hf:open', 'hf:close', 'hf:toggle'],
};

export function mount(root) {
  const trigger = nonSubmit(part(root, 'trigger'));
  const panel = part(root, 'panel');
  if (!trigger || !panel) throw new Error('[hf] disclosure needs [data-hf-part="trigger"] and [data-hf-part="panel"]');

  const opts = options(root, meta.options);
  const panelId = needsId(panel, 'hf-disclosure-panel');
  trigger.setAttribute('aria-controls', panelId);
  trigger.setAttribute('aria-expanded', 'false');
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', needsId(trigger, 'hf-disclosure-trigger'));

  let open = false;

  function render(next, reason) {
    open = next;
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    setState(root, open ? 'open' : 'closed');
    setState(trigger, open ? 'open' : 'closed');
    if (reason) emit(root, open ? 'hf:open' : 'hf:close', { reason, open });
  }

  function toggle(reason = 'trigger') {
    if (isDisabled(trigger) || opts.disabled) return;
    render(!open, reason);
    emit(root, 'hf:toggle', { open, reason });
  }

  const onClick = () => toggle('trigger');
  const onKey = (event) => {
    if (event.key === KEY.SPACE && trigger.tagName !== 'BUTTON') {
      event.preventDefault();
      toggle('keyboard');
    }
  };

  trigger.addEventListener('click', onClick);
  trigger.addEventListener('keydown', onKey);
  render(Boolean(opts.defaultOpen), 'initial');

  return {
    get isOpen() {
      return open;
    },
    setOpen(next, reason = 'api') {
      const value = Boolean(next);
      if (value !== open) render(value, reason);
    },
    toggle,
    destroy() {
      trigger.removeEventListener('click', onClick);
      trigger.removeEventListener('keydown', onKey);
    },
  };
}
