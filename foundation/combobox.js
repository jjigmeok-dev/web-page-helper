import { KEY, emit, needsId, options, part, setState } from './core.js';

/**
 * Combobox: text input with a filtered popup listbox.
 *
 * <div data-hf="combobox" data-hf-options='{"filter":"startsWith"}'>
 *   <input data-hf-part="input" role="combobox" aria-autocomplete="list">
 *   <ul data-hf-part="listbox">
 *     <li data-hf-part="option" data-value="js">JavaScript</li>
 *   </ul>
 * </div>
 *
 * Filtering hides options with `hidden`; it never rewrites your markup.
 * Emits `hf:change` with the chosen value and `hf:input` on each keystroke.
 */
export const meta = {
  name: 'combobox',
  file: import.meta.url,
  summary: 'Filterable input bound to a listbox popup.',
  parts: { input: 'input', listbox: 'any', option: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['input', 'listbox'],
  options: { filter: 'contains', allowCustom: true, openOnFocus: false, placeholder: '' },
  events: ['hf:change', 'hf:input', 'hf:open', 'hf:close'],
};

export function mount(root, { listbox }) {
  const input = part(root, 'input');
  const list = part(root, 'listbox');
  if (!input || !list) throw new Error('[hf] combobox needs [data-hf-part="input"] and [data-hf-part="listbox"]');
  const opts = options(root, meta.options);

  let open = false;
  let active = -1;

  if (!input.hasAttribute('role')) input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  needsId(list, 'hf-combobox-listbox');
  input.setAttribute('aria-controls', list.id);
  if (!list.hasAttribute('role')) list.setAttribute('role', 'listbox');
  list.querySelectorAll('[data-hf-part="option"]').forEach((option, index) => {
    if (!option.hasAttribute('role')) option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    if (!option.id) option.id = `${list.id}-opt-${index}`;
  });
  if (opts.placeholder && !input.placeholder) input.placeholder = opts.placeholder;
  list.hidden = true;

  const all = () => Array.from(list.querySelectorAll('[data-hf-part="option"]'));
  const visible = () => all().filter((option) => !option.hidden);
  const label = (option) => (option.textContent || '').trim();
  const valueOf = (option) => option.dataset.value ?? option.id ?? label(option);

  function filter() {
    const query = input.value.trim().toLowerCase();
    all().forEach((option) => {
      const text = label(option).toLowerCase();
      const match = !query || (opts.filter === 'startsWith' ? text.startsWith(query) : text.includes(query));
      option.hidden = !match;
    });
    if (listbox) listbox.refresh();
  }

  function render(next, reason) {
    if (next === open) return;
    open = next;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    setState(root, open ? 'open' : 'closed');
    input.setAttribute('aria-activedescendant', open && active >= 0 ? visible()[active]?.id : '');
    emit(root, open ? 'hf:open' : 'hf:close', { reason });
    if (!open) {
      active = -1;
      all().forEach((option) => option.removeAttribute('data-active'));
    }
  }

  function highlight(index, reason) {
    const options_ = visible();
    if (!options_.length) return;
    active = (index + options_.length) % options_.length;
    options_.forEach((option, i) => {
      option.tabIndex = i === active ? 0 : -1;
      if (i === active) option.setAttribute('data-active', '');
      else option.removeAttribute('data-active');
      if (!option.id) option.id = `${list.id || 'hf-combobox'}-opt-${i}`;
    });
    if (open) input.setAttribute('aria-activedescendant', options_[active].id);
    options_[active].scrollIntoView({ block: 'nearest' });
    if (reason === 'keyboard') emit(root, 'hf:input', { value: input.value, reason: 'highlight' });
  }

  function choose(index, reason) {
    const option = visible()[index];
    if (!option) return;
    const value = valueOf(option);
    input.value = label(option);
    render(false, 'choose');
    emit(root, 'hf:change', { value, option, index, reason });
    input.focus({ preventScroll: true });
  }

  const onInput = () => {
    filter();
    render(true, 'input');
    highlight(0, 'input');
    emit(root, 'hf:input', { value: input.value, reason: 'input' });
  };

  const onKey = (event) => {
    if (event.key === KEY.ARROW_DOWN) {
      event.preventDefault();
      if (!open) render(true, 'keyboard');
      highlight(active + 1, 'keyboard');
    } else if (event.key === KEY.ARROW_UP) {
      event.preventDefault();
      highlight(active - 1, 'keyboard');
    } else if (event.key === KEY.ENTER) {
      if (open && active >= 0) {
        event.preventDefault();
        choose(active, 'keyboard');
      }
      render(false, 'enter');
    } else if (event.key === KEY.ESCAPE) {
      if (open) {
        event.preventDefault();
        render(false, 'escape');
      }
    } else if (event.key === KEY.HOME && !open) {
      // let the caret behave natively
    } else if (event.key === KEY.TAB) {
      render(false, 'tab');
    }
  };

  const onFocus = () => {
    if (opts.openOnFocus) {
      filter();
      render(true, 'focus');
    }
  };

  const onBlur = () => {
    setTimeout(() => {
      if (!root.contains(document.activeElement)) render(false, 'blur');
    }, 0);
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  list.addEventListener('pointerdown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[data-hf-part="option"]');
    if (option && !option.hidden) choose(visible().indexOf(option), 'click');
  });

  return {
    get isOpen() {
      return open;
    },
    get value() {
      const match = all().find((option) => label(option) === input.value);
      return match ? valueOf(match) : opts.allowCustom ? input.value : null;
    },
    openList() {
      filter();
      render(true, 'api');
    },
    closeList() {
      render(false, 'api');
    },
    destroy() {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
    },
  };
}
