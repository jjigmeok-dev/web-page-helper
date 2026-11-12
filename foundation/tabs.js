import { KEY, emit, isDisabled, needsId, options, part, parts, setState, nonSubmit } from './core.js';

/**
 * Tabs: a tablist of tabs controlling sibling panels.
 *
 * <div data-hf="tabs" data-hf-options='{"orientation":"horizontal","activation":"auto"}'>
 *   <div role="tablist" data-hf-part="list">
 *     <button data-hf-part="tab">One</button>
 *     <button data-hf-part="tab">Two</button>
 *   </div>
 *   <section data-hf-part="panel">…</section>
 *   <section data-hf-part="panel">…</section>
 * </div>
 *
 * Panels pair with tabs by `data-hf-part="panel"` order, or explicitly with
 * `aria-controls` on the tab / `id` on the panel.
 */
export const meta = {
  name: 'tabs',
  file: import.meta.url,
  summary: 'Roving tablist with arrow, Home and End navigation.',
  parts: { list: 'tablist', tab: 'button|a', panel: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['list', 'tab'],
  options: { orientation: 'horizontal', activation: 'auto', selected: 0, loop: true },
  events: ['hf:select'],
};

export function mount(root) {
  const list = part(root, 'list');
  const tabs = parts(root, 'tab').map(nonSubmit);
  const panels = parts(root, 'panel');
  if (!list || !tabs.length) throw new Error('[hf] tabs needs [data-hf-part="list"] and at least one [data-hf-part="tab"]');

  const opts = options(root, meta.options);
  const vertical = opts.orientation === 'vertical';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');

  const bound = tabs.map((tab, index) => {
    const explicit = tab.getAttribute('aria-controls');
    const panel = explicit ? document.getElementById(explicit) : panels[index];
    if (panel && !panel.id) panel.id = needsId(panel, 'hf-tabpanel');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    if (panel) {
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', needsId(tab, 'hf-tab'));
      panel.tabIndex = 0;
    }
    return { tab, panel };
  });

  let selected = -1;

  function select(index, reason = 'api') {
    if (index < 0 || index >= bound.length) return;
    if (isDisabled(bound[index].tab)) return;
    selected = index;
    bound.forEach(({ tab, panel }, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      setState(tab, on ? 'selected' : 'idle');
      if (panel) {
        panel.hidden = !on;
        setState(panel, on ? 'selected' : 'idle');
      }
    });
    setState(root, 'selected');
    emit(root, 'hf:select', { index, value: bound[index].tab.getAttribute('data-value') ?? bound[index].tab.id, reason });
    if (reason === 'keyboard' || reason === 'click') bound[index].tab.focus({ preventScroll: true });
  }

  const onKey = (event) => {
    const index = bound.findIndex(({ tab }) => tab === document.activeElement);
    if (index === -1) return;
    const prev = vertical ? KEY.ARROW_UP : KEY.ARROW_LEFT;
    const next = vertical ? KEY.ARROW_DOWN : KEY.ARROW_RIGHT;
    let target = index;
    if (event.key === prev) target = index === 0 ? (opts.loop ? bound.length - 1 : 0) : index - 1;
    else if (event.key === next) target = index === bound.length - 1 ? (opts.loop ? 0 : index) : index + 1;
    else if (event.key === KEY.HOME) target = 0;
    else if (event.key === KEY.END) target = bound.length - 1;
    else return;

    event.preventDefault();
    if (opts.activation === 'manual') {
      bound.forEach(({ tab }, i) => {
        tab.tabIndex = i === target ? 0 : -1;
      });
      bound[target].tab.focus({ preventScroll: true });
      emit(root, 'hf:select', { index: target, pending: true, reason: 'keyboard' });
    } else {
      select(target, 'keyboard');
    }
  };

  const listeners = bound.map(({ tab }, index) => {
    const onClick = () => select(index, 'click');
    tab.addEventListener('click', onClick);
    return () => tab.removeEventListener('click', onClick);
  });

  list.addEventListener('keydown', onKey);
  select(Math.min(Math.max(Number(opts.selected) || 0, 0), bound.length - 1), 'initial');

  return {
    get selected() {
      return selected;
    },
    select(value) {
      const index = typeof value === 'number' ? value : bound.findIndex(({ tab }) => tab.id === value || tab.dataset.value === value);
      if (index !== -1) select(index, 'api');
    },
    destroy() {
      list.removeEventListener('keydown', onKey);
      listeners.forEach((off) => off());
    },
  };
}
