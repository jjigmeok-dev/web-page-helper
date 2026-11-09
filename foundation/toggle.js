import { KEY, emit, isDisabled, options, part, parts, setState } from './core.js';

/**
 * Toggle: a single control with pressed state (`aria-pressed`).
 *
 * <button data-hf="toggle" data-hf-options='{"pressed":false}' data-hf-part="control">Mute</button>
 *
 * For grouped exclusive choices use `radio-group`; for on/off with a text
 * label use `switch`.
 */
export const meta = {
  name: 'toggle',
  file: import.meta.url,
  summary: 'A button that keeps its pressed state.',
  parts: { control: 'button', label: 'any' },
  // The root stands in for the part (`part(root, 'control') || root`).
  required: [],
  options: { pressed: false, disabled: false },
  events: ['hf:change'],
};

export function mount(root) {
  const control = part(root, 'control') || root;
  const opts = options(root, meta.options);
  let pressed = Boolean(opts.pressed);

  control.setAttribute('aria-pressed', String(pressed));
  setState(root, pressed ? 'pressed' : 'idle');

  function set(next, reason) {
    if (isDisabled(control) || opts.disabled) return;
    const value = Boolean(next);
    if (value === pressed) return;
    pressed = value;
    control.setAttribute('aria-pressed', String(pressed));
    setState(root, pressed ? 'pressed' : 'idle');
    setState(control, pressed ? 'pressed' : 'idle');
    emit(root, 'hf:change', { pressed, reason });
  }

  const onClick = () => set(!pressed, 'click');
  const onKey = (event) => {
    if (control.tagName === 'BUTTON') return;
    if (event.key === KEY.ENTER || event.key === KEY.SPACE) {
      event.preventDefault();
      set(!pressed, 'keyboard');
    }
  };

  control.addEventListener('click', onClick);
  control.addEventListener('keydown', onKey);

  return {
    get pressed() {
      return pressed;
    },
    set(value, reason = 'api') {
      set(value, reason);
    },
    toggle(reason = 'api') {
      set(!pressed, reason);
    },
    destroy() {
      control.removeEventListener('click', onClick);
      control.removeEventListener('keydown', onKey);
    },
  };
}

/**
 * Switch: binary on/off with `role="switch"`.
 *
 * <button data-hf="switch" data-hf-part="control">Wi-Fi</button>
 */
export const switchMeta = {
  name: 'switch',
  file: import.meta.url,
  summary: 'Binary on/off control using role=switch.',
  parts: { control: 'button', thumb: 'any', label: 'any' },
  // `thumb` and `label` are optional decoration; the root acts as control.
  required: [],
  options: { checked: false, disabled: false },
  events: ['hf:change'],
};

export function mountSwitch(root) {
  const control = part(root, 'control') || root;
  const thumb = part(root, 'thumb');
  const opts = options(root, switchMeta.options);
  let checked = Boolean(opts.checked);

  if (!control.hasAttribute('role')) control.setAttribute('role', 'switch');
  control.setAttribute('aria-checked', String(checked));
  setState(root, checked ? 'checked' : 'unchecked');
  if (thumb) setState(thumb, checked ? 'checked' : 'unchecked');

  function set(next, reason) {
    if (isDisabled(control) || opts.disabled) return;
    const value = Boolean(next);
    if (value === checked) return;
    checked = value;
    control.setAttribute('aria-checked', String(checked));
    setState(root, checked ? 'checked' : 'unchecked');
    setState(control, checked ? 'checked' : 'unchecked');
    if (thumb) setState(thumb, checked ? 'checked' : 'unchecked');
    emit(root, 'hf:change', { checked, reason });
  }

  const onClick = () => set(!checked, 'click');
  const onKey = (event) => {
    if (control.tagName === 'BUTTON') return;
    if (event.key === KEY.ENTER || event.key === KEY.SPACE) {
      event.preventDefault();
      set(!checked, 'keyboard');
    }
  };

  control.addEventListener('click', onClick);
  control.addEventListener('keydown', onKey);

  return {
    get checked() {
      return checked;
    },
    set(value, reason = 'api') {
      set(value, reason);
    },
    toggle(reason = 'api') {
      set(!checked, reason);
    },
    destroy() {
      control.removeEventListener('click', onClick);
      control.removeEventListener('keydown', onKey);
    },
  };
}
