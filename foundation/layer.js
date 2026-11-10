/**
 * Shared top-layer plumbing for anchored layers (popover, menu).
 *
 * A layer is either **native** — promoted with the `popover` attribute, so the
 * browser owns the top layer, light dismiss and `Esc` — or **in-flow**, where
 * the panel stays inside its trigger's box and this module falls back to
 * `[hidden]`.
 *
 * Anchor positioning is part of the gate, not an optimisation. Promotion moves
 * the panel out of its containing block: a measured trigger at (300, 227)
 * rendered its `position: absolute` panel at (341, 589). Positioning correctly
 * in the top layer needs anchor positioning, so a browser without it must not
 * promote at all.
 *
 * Consumers position the panel themselves:
 *
 *   [data-hf-part='trigger'] { anchor-name: --my-layer; }
 *   [data-hf-part='content'] {
 *     position: fixed; margin: 0;
 *     position-anchor: --my-layer;
 *     position-area: bottom span-right;
 *     position-try-fallbacks: flip-block;
 *   }
 *
 * The anchor must be named explicitly: the implicit anchor only applies when
 * the invoker element opened the popover, so a programmatic `open()` would
 * otherwise land the panel at the viewport origin.
 */

/** What the running browser can do. Computed per call so hosts and tests that
 * patch the prototype see the environment they actually run in. */
export function capabilities() {
  const hasPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
  const hasAnchor =
    typeof CSS !== 'undefined' && CSS.supports('anchor-name: --a') && CSS.supports('position-area: bottom');
  // Declarative invokers only fire for trusted clicks, so a component that
  // wants a synthetic-click path must know whether it also wired this.
  const hasCommand = typeof HTMLButtonElement !== 'undefined' && 'commandForElement' in HTMLButtonElement.prototype;
  return { hasPopover, hasAnchor, hasCommand, native: hasPopover && hasAnchor };
}

/**
 * Wraps `content` in the strongest layer the browser supports.
 *
 * `manual` keeps the panel open until asked: a `beforetoggle` close is not
 * cancelable, so there is no way to veto a native dismissal when an option
 * narrows the contract (`closeOnEscape: false` and friends).
 *
 * `onToggle` receives `true`/`false` for changes the platform started
 * (Escape, light dismiss, or `commandfor` invokers). Changes made through
 * `show`/`hide` also report, so a single listener is enough.
 */
export function createLayer(content, { manual = false, onToggle } = {}) {
  const { native } = capabilities();
  let listening = false;

  if (native) {
    content.setAttribute('popover', manual ? 'manual' : 'auto');
    if (onToggle) {
      content.addEventListener('toggle', handle);
      listening = true;
    }
  } else {
    // Without the Popover API `[hidden]` is the only way out of flow.
    content.hidden = true;
  }

  function handle(event) {
    onToggle(event.newState === 'open');
  }

  return {
    /** True when the browser owns the top layer and dismissal for this node. */
    get isNative() {
      return native;
    },
    get isOpen() {
      return native ? content.matches(':popover-open') : !content.hidden;
    },
    show() {
      if (native) {
        if (!content.matches(':popover-open')) content.showPopover();
      } else {
        content.hidden = false;
      }
    },
    hide() {
      if (native) {
        if (content.matches(':popover-open')) content.hidePopover();
      } else {
        content.hidden = true;
      }
    },
    destroy() {
      if (listening) {
        content.removeEventListener('toggle', handle);
        listening = false;
      }
      if (native) content.removeAttribute('popover');
      else content.hidden = false;
    },
  };
}
