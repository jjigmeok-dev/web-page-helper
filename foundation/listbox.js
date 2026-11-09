import { KEY, emit, isDisabled, options, parts, setState } from './core.js';

/**
 * Listbox: single or multi selection with a roving cursor.
 *
 * <ul data-hf="listbox" data-hf-options='{"multiple":false,"selected":[]}'>
 *   <li data-hf-part="option" data-value="a">A</li>
 * </ul>
 *
 * Used standalone or inside `combobox` (`data-hf-part="listbox"`).
 * Selection state is `aria-selected`, cursor state is `data-active`.
 */
export const meta = {
  name: 'listbox',
  file: import.meta.url,
  summary: 'Selectable options with keyboard cursor and typeahead.',
  parts: { option: 'any' },
  // The root stands in for the part (`part(root, 'control') || root`).
  required: [],
  options: { multiple: false, selected: [], loop: true, typeahead: true },
  events: ['hf:change', 'hf:active'],
};

export function mount(root, helpers = {}) {
  const opts = options(root, meta.options);
  const selected = new Set(
    (Array.isArray(opts.selected) ? opts.selected : [opts.selected]).filter((value) => value !== undefined && value !== null).map(String),
  );
  const search = helpers.typeahead
    ? helpers.typeahead((text) => options_().findIndex((option) => label(option).startsWith(text)))
    : null;
  let active = -1;

  if (!root.hasAttribute('role')) root.setAttribute('role', 'listbox');
  root.setAttribute('aria-multiselectable', String(Boolean(opts.multiple)));

  function options_() {
    return parts(root, 'option');
  }

  function label(option) {
    return (helpers.labelOf ? helpers.labelOf(option) : option.textContent).trim().toLowerCase();
  }

  function valueOf(option) {
    return option.dataset.value ?? option.id;
  }

  function paint() {
    options_().forEach((option, index) => {
      const on = selected.has(String(valueOf(option)));
      option.setAttribute('aria-selected', String(on));
      option.setAttribute('role', 'option');
      option.tabIndex = index === active ? 0 : -1;
      if (index === active) option.setAttribute('data-active', '');
      else option.removeAttribute('data-active');
      setState(option, on ? 'selected' : 'idle');
    });
  }

  function setActive(index, reason) {
    const list = options_();
    if (!list.length) return;
    active = (index + list.length) % list.length;
    paint();
    emit(root, 'hf:active', { index: active, value: valueOf(list[active]), reason });
    if (reason === 'keyboard') list[active].focus({ preventScroll: true });
    else list[active].scrollIntoView({ block: 'nearest' });
  }

  function select(index, reason) {
    const list = options_();
    const option = list[index];
    if (!option || isDisabled(option)) return;
    const key = String(valueOf(option));
    if (opts.multiple) {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
    } else {
      selected.clear();
      selected.add(key);
    }
    paint();
    emit(root, 'hf:change', { value: valueOf(option), selected: Array.from(selected), index, reason });
  }

  const onClick = (event) => {
    const option = event.target.closest('[data-hf-part="option"]');
    if (!option || !root.contains(option)) return;
    const index = options_().indexOf(option);
    active = index;
    select(index, 'click');
  };

  const onKey = (event) => {
    const list = options_();
    const focused = list.indexOf(document.activeElement);
    if (focused !== -1 && focused !== active) active = focused;
    if (event.key === KEY.ARROW_DOWN) {
      event.preventDefault();
      setActive(active < 0 ? 0 : active + 1, 'keyboard');
    } else if (event.key === KEY.ARROW_UP) {
      event.preventDefault();
      setActive(active < 0 ? list.length - 1 : active - 1, 'keyboard');
    } else if (event.key === KEY.HOME) {
      event.preventDefault();
      setActive(0, 'keyboard');
    } else if (event.key === KEY.END) {
      event.preventDefault();
      setActive(list.length - 1, 'keyboard');
    } else if (event.key === KEY.SPACE || event.key === KEY.ENTER) {
      event.preventDefault();
      select(active, 'keyboard');
    } else if (search && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const index = search.push(event.key);
      if (index >= 0) {
        event.preventDefault();
        setActive(index, 'keyboard');
      }
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  if (!selected.size && !opts.multiple) {
    const first = options_()[0];
    if (first) selected.add(String(valueOf(first)));
  }
  paint();

  return {
    get value() {
      return opts.multiple ? Array.from(selected) : Array.from(selected)[0] ?? null;
    },
    get activeIndex() {
      return active;
    },
    select(value) {
      const index = options_().findIndex((option) => String(valueOf(option)) === String(value));
      if (index !== -1) select(index, 'api');
    },
    setActive(index) {
      setActive(index, 'api');
    },
    refresh() {
      paint();
    },
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
    },
  };
}
