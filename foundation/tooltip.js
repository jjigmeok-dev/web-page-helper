import { KEY, emit, needsId, options, part, setState } from './core.js';

/**
 * Tooltip: descriptive text on hover/focus, dismissible with Escape.
 *
 * <div data-hf="tooltip" data-hf-options='{"delay":300}'>
 *   <button data-hf-part="trigger" aria-describedby="…">Hover me</button>
 *   <div data-hf-part="content" role="tooltip">Saves your draft</div>
 * </div>
 *
 * The content is always in the DOM with `role="tooltip"` and `hidden`
 * toggled, so screen readers and consumer CSS both work.
 */
export const meta = {
  name: 'tooltip',
  file: import.meta.url,
  summary: 'Hover/focus description with Escape dismissal.',
  parts: { trigger: 'any', content: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['trigger', 'content'],
  options: { delay: 300, hideDelay: 80, defaultOpen: false },
  events: ['hf:open', 'hf:close'],
};

export function mount(root) {
  const trigger = part(root, 'trigger');
  const content = part(root, 'content');
  if (!trigger || !content) throw new Error('[hf] tooltip needs [data-hf-part="trigger"] and [data-hf-part="content"]');
  const opts = options(root, meta.options);

  const id = needsId(content, 'hf-tooltip');
  content.setAttribute('role', 'tooltip');
  trigger.setAttribute('aria-describedby', id);
  content.hidden = true;

  let open = false;
  let timer = 0;

  function render(next, reason) {
    clearTimeout(timer);
    if (next === open) return;
    open = next;
    content.hidden = !open;
    setState(root, open ? 'open' : 'closed');
    setState(content, open ? 'open' : 'closed');
    emit(root, open ? 'hf:open' : 'hf:close', { reason });
  }

  function schedule(next, reason) {
    clearTimeout(timer);
    const wait = next ? Number(opts.delay) || 0 : Number(opts.hideDelay) || 0;
    timer = setTimeout(() => render(next, reason), Math.max(0, wait));
  }

  const onEnter = () => schedule(true, 'pointer');
  const onLeave = () => schedule(false, 'pointer');
  const onFocus = () => render(true, 'focus');
  const onBlur = () => render(false, 'blur');
  const onKey = (event) => {
    if (event.key === KEY.ESCAPE && open) {
      event.preventDefault();
      render(false, 'escape');
    }
  };

  trigger.addEventListener('pointerenter', onEnter);
  trigger.addEventListener('pointerleave', onLeave);
  trigger.addEventListener('focus', onFocus);
  trigger.addEventListener('blur', onBlur);
  trigger.addEventListener('keydown', onKey);
  render(Boolean(opts.defaultOpen), 'initial');

  return {
    get isOpen() {
      return open;
    },
    show(reason = 'api') {
      render(true, reason);
    },
    hide(reason = 'api') {
      render(false, reason);
    },
    destroy() {
      clearTimeout(timer);
      trigger.removeEventListener('pointerenter', onEnter);
      trigger.removeEventListener('pointerleave', onLeave);
      trigger.removeEventListener('focus', onFocus);
      trigger.removeEventListener('blur', onBlur);
      trigger.removeEventListener('keydown', onKey);
    },
  };
}
