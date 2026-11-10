import { emit, needsId, options, part, parts, setState } from './core.js';

/**
 * Dialog: modal or non-modal layer over the page.
 *
 * Built on the native `<dialog>` element. The browser owns the modal
 * contract — top layer, focus containment, `Esc`, `::backdrop`, inert page
 * and focus return to the invoker — so this module only wires the API,
 * options and events. Rebuilding those by hand (a `role="dialog"`, a manual
 * focus trap, an `Esc` handler) is what the platform guidance says not to do.
 *
 * <dialog data-hf="dialog" data-hf-options='{"modal":true}'>
 *   <div data-hf-part="content" aria-labelledby="title">
 *     <h2 id="title">Title</h2>
 *     <button data-hf-part="close">Close</button>
 *   </div>
 * </dialog>
 *
 * The host must be a `<dialog>`. A non-modal dialog uses `show()`, which
 * keeps the page interactive; `modal: true` (the default) uses `showModal()`.
 */
export const meta = {
  name: 'dialog',
  file: import.meta.url,
  summary: 'Native <dialog> layer with Escape, backdrop and focus return.',
  parts: { content: 'any', close: 'button' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['content'],
  options: {
    modal: true,
    // Close when the user clicks the backdrop. `closedby` does this natively
    // where supported; the canvas listener is the fallback.
    closeOnBackdrop: true,
    closeOnEscape: true,
    defaultOpen: false,
  },
  events: ['hf:open', 'hf:close'],
};

export function mount(root) {
  if (root.tagName !== 'DIALOG') {
    throw new Error('[hf] dialog needs a <dialog> element as its host, not <' + root.tagName.toLowerCase() + '>');
  }
  const content = part(root, 'content') || root;
  const opts = options(root, meta.options);
  const modal = Boolean(opts.modal);

  // The browser supplies role/metatdata; naming the dialog is all that is left.
  needsId(content, 'hf-dialog');
  // `closedby` is Baseline-incomplete, so it is a hint, not a dependency: the
  // `cancel` handler below is what actually enforces the option.
  if (opts.closeOnBackdrop) root.setAttribute('closedby', 'any');
  else root.setAttribute('closedby', 'closerequest');

  let destroyed = false;

  /** Mirrors the element's real state rather than a parallel boolean. */
  function sync(reason) {
    setState(root, root.open ? 'open' : 'closed');
    setState(content, root.open ? 'open' : 'closed');
    emit(root, root.open ? 'hf:open' : 'hf:close', { reason });
  }

  // Native dismissals (`Esc`, back gesture, `command="close"`, a
  // `<form method="dialog">` submit) all end here. `close` fires for every
  // one of them, so event symmetry comes free instead of from a key handler.
  const onClose = () => sync('native');

  // `cancel` fires before `Esc`/back-gesture closes. Refusing it is the only
  // thing the platform cannot decide for us, because it depends on options.
  const onCancel = (event) => {
    if (opts.closeOnEscape) return;
    event.preventDefault();
  };

  // Light dismiss: a click that lands on the dialog box itself rather than on
  // its content is a backdrop click. `closedby="any"` handles this where it is
  // supported; this listener covers the rest.
  const onClick = (event) => {
    if (!root.open || !opts.closeOnBackdrop) return;
    if (event.target !== root) return;
    root.close('backdrop');
  };

  const offs = parts(root, 'close').map((button) => {
    const onClickClose = () => root.close('close');
    button.addEventListener('click', onClickClose);
    return () => button.removeEventListener('click', onClickClose);
  });

  root.addEventListener('close', onClose);
  root.addEventListener('cancel', onCancel);
  root.addEventListener('click', onClick);
  sync('initial');

  if (opts.defaultOpen) {
    if (modal) root.showModal();
    else root.show();
    sync('initial');
  }

  return {
    get isOpen() {
      return root.open;
    },
    /** `returnValue` from the last `<form method="dialog">` submit, if any. */
    get returnValue() {
      return root.returnValue;
    },
    open(reason = 'api') {
      if (destroyed || root.open) return;
      // `showModal()` is what makes the page inert, puts the dialog in the top
      // layer and returns focus on close. `show()` leaves the page usable.
      if (modal) root.showModal();
      else root.show();
      sync(reason);
    },
    close(reason = 'api') {
      if (destroyed || !root.open) return;
      // A `reason` survives the native `close` event, so the caller can tell a
      // backdrop dismissal from an API one.
      root.close(reason);
    },
    toggle(reason = 'api') {
      if (root.open) this.close(reason);
      else this.open(reason);
    },
    setOpen(next, reason = 'api') {
      if (next) this.open(reason);
      else this.close(reason);
    },
    destroy() {
      destroyed = true;
      if (root.open) root.close('destroy');
      root.removeEventListener('close', onClose);
      root.removeEventListener('cancel', onCancel);
      root.removeEventListener('click', onClick);
      offs.forEach((off) => off());
    },
  };
}
