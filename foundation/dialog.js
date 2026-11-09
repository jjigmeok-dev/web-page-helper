import { KEY, emit, needsId, options, part, parts, setState, trapTab } from './core.js';

/**
 * Dialog: modal or non-modal layer over the page.
 *
 * <div data-hf="dialog" data-hf-options='{"modal":true}'>
 *   <div data-hf-part="content" aria-labelledby="title">
 *     <h2 id="title">Title</h2>
 *     <button data-hf-part="close">Close</button>
 *   </div>
 * </div>
 *
 * `[data-hf="dialog"]` is the backdrop/layer; the consumer styles it.
 * Modal dialogs trap Tab, close on Escape and on backdrop click, and
 * restore focus to whatever was focused before opening.
 */
export const meta = {
  name: 'dialog',
  file: import.meta.url,
  summary: 'Focus-trapping layer with Escape and backdrop dismissal.',
  parts: { content: 'any', close: 'button' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['content'],
  options: {
    modal: true,
    closeOnEscape: true,
    closeOnBackdrop: true,
    lockScroll: true,
    defaultOpen: false,
  },
  events: ['hf:open', 'hf:close'],
};

export function mount(root) {
  const content = part(root, 'content') || root;
  const opts = options(root, meta.options);
  const modal = Boolean(opts.modal);

  if (!content.hasAttribute('role')) content.setAttribute('role', 'dialog');
  content.setAttribute('aria-modal', String(modal));
  if (!content.hasAttribute('tabindex')) content.tabIndex = -1;
  needsId(content, 'hf-dialog');

  let open = false;
  let restoreTo = null;
  let destroyed = false;

  function focusInside() {
    const target = content.querySelector('[autofocus]') || content;
    target.focus({ preventScroll: true });
  }

  function render(next, reason) {
    if (next === open) return;
    open = next;
    root.hidden = !open;
    setState(root, open ? 'open' : 'closed');
    setState(content, open ? 'open' : 'closed');
    if (open) {
      restoreTo = document.activeElement;
      if (modal && opts.lockScroll) document.documentElement.setAttribute('data-hf-scroll-lock', '');
      focusInside();
      emit(root, 'hf:open', { reason });
    } else {
      if (modal && opts.lockScroll) document.documentElement.removeAttribute('data-hf-scroll-lock');
      const back = restoreTo && document.contains(restoreTo) ? restoreTo : null;
      restoreTo = null;
      if (back) back.focus({ preventScroll: true });
      emit(root, 'hf:close', { reason });
    }
  }

  const onKeyDown = (event) => {
    if (!open) return;
    if (event.key === KEY.ESCAPE && opts.closeOnEscape) {
      event.preventDefault();
      event.stopPropagation();
      render(false, 'escape');
      return;
    }
    if (modal) trapTab(event, content);
  };

  const onClick = (event) => {
    if (!open || !opts.closeOnBackdrop) return;
    if (event.target === root || (!root.contains(content) && !content.contains(event.target))) {
      render(false, 'backdrop');
    }
  };

  const offs = parts(root, 'close').map((button) => {
    const onClickClose = () => render(false, 'close');
    button.addEventListener('click', onClickClose);
    return () => button.removeEventListener('click', onClickClose);
  });

  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('click', onClick);
  render(Boolean(opts.defaultOpen), 'initial');

  return {
    get isOpen() {
      return open;
    },
    open(reason = 'api') {
      if (destroyed) return;
      render(true, reason);
    },
    close(reason = 'api') {
      if (destroyed) return;
      render(false, reason);
    },
    toggle(reason = 'api') {
      if (destroyed) return;
      render(!open, reason);
    },
    setOpen(next, reason = 'api') {
      if (destroyed) return;
      render(Boolean(next), reason);
    },
    destroy() {
      destroyed = true;
      if (open) render(false, 'destroy');
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('click', onClick);
      offs.forEach((off) => off());
      if (open && modal && opts.lockScroll) document.documentElement.removeAttribute('data-hf-scroll-lock');
    },
  };
}
