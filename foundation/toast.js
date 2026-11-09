import { emit, options, part, parts, setState } from './core.js';

/**
 * Toast region: announces transient messages through a live region.
 *
 * <div data-hf="toast" data-hf-options='{"politeness":"polite","timeout":5000}'>
 *   <div data-hf-part="region" role="status"></div>
 *   <template data-hf-part="template">
 *     <div data-hf-part="toast"><span data-hf-part="message"></span></div>
 *   </template>
 * </div>
 *
 * Everything visual (placement, animation, dismissal button) is yours.
 * Controller: `show(message, {timeout, tone})` returns the toast element.
 */
export const meta = {
  name: 'toast',
  file: import.meta.url,
  summary: 'Live-region announcements with optional auto-dismiss.',
  parts: { region: 'any', template: 'template', toast: 'any', message: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['region'],
  options: { politeness: 'polite', timeout: 5000, max: 3 },
  events: ['hf:toastshow', 'hf:toasthide'],
};

export function mount(root) {
  const region = part(root, 'region') || root;
  const template = part(root, 'template');
  const opts = options(root, meta.options);
  const polite = opts.politeness !== 'assertive';

  region.setAttribute('role', polite ? 'status' : 'alert');
  region.setAttribute('aria-live', polite ? 'polite' : 'assertive');
  region.setAttribute('aria-atomic', 'false');
  region.setAttribute('aria-relevant', 'additions');

  const shown = new Set();

  function hide(toast, reason) {
    if (!shown.has(toast)) return;
    shown.delete(toast);
    clearTimeout(toast.__hfTimer);
    toast.remove();
    emit(root, 'hf:toasthide', { reason });
  }

  function show(message, { timeout = Number(opts.timeout), tone = '', reason = 'api' } = {}) {
    let toast;
    if (template && template.content) {
      toast = template.content.firstElementChild.cloneNode(true);
      const text = part(toast, 'message');
      if (text) text.textContent = message;
      else toast.textContent = message;
    } else {
      toast = document.createElement('div');
      toast.setAttribute('data-hf-part', 'toast');
      const text = document.createElement('span');
      text.setAttribute('data-hf-part', 'message');
      text.textContent = message;
      toast.append(text);
    }
    if (tone) toast.dataset.tone = tone;
    setState(toast, 'visible');
    region.append(toast);
    shown.add(toast);

    const max = Number(opts.max) || 0;
    while (max > 0 && shown.size > max) hide(shown.values().next().value, 'overflow');

    if (Number.isFinite(timeout) && timeout > 0) {
      toast.__hfTimer = setTimeout(() => hide(toast, 'timeout'), timeout);
    }
    emit(root, 'hf:toastshow', { message, tone, reason });
    return toast;
  }

  return {
    show,
    hide(toast) {
      hide(toast, 'api');
    },
    clear(reason = 'api') {
      Array.from(shown).forEach((toast) => hide(toast, reason));
    },
    get count() {
      return shown.size;
    },
    destroy() {
      Array.from(shown).forEach((toast) => {
        clearTimeout(toast.__hfTimer);
      });
      shown.clear();
    },
  };
}
