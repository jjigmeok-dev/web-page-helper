import { KEY, emit, isDisabled, needsId, options, part, parts, setState } from './core.js';

/**
 * Accordion: a group of disclosures with single or multiple expansion.
 *
 * <div data-hf="accordion" data-hf-options='{"type":"single","collapsible":true}'>
 *   <div data-hf-part="item">
 *     <h3><button data-hf-part="trigger">Section</button></h3>
 *     <div data-hf-part="panel">…</div>
 *   </div>
 * </div>
 */
export const meta = {
  name: 'accordion',
  file: import.meta.url,
  summary: 'Grouped disclosures, single-open or multi-open.',
  parts: { item: 'any', trigger: 'button', panel: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['item'],
  options: { type: 'single', collapsible: true, defaultOpen: [] },
  events: ['hf:open', 'hf:close'],
};

export function mount(root) {
  const items = parts(root, 'item');
  if (!items.length) throw new Error('[hf] accordion needs at least one [data-hf-part="item"]');
  const opts = options(root, meta.options);
  if (opts.type !== 'single' && opts.type !== 'multiple') opts.type = 'single';

  const entries = items.map((item) => {
    const trigger = part(item, 'trigger');
    const panel = part(item, 'panel');
    if (!trigger || !panel) throw new Error('[hf] accordion item needs a trigger and a panel');
    const panelId = needsId(panel, 'hf-accordion-panel');
    trigger.setAttribute('aria-controls', panelId);
    trigger.setAttribute('aria-expanded', 'false');
    if (!panel.hasAttribute('role')) panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', needsId(trigger, 'hf-accordion-trigger'));
    panel.hidden = true;
    return { item, trigger, panel, open: false };
  });

  let destroyed = false;
  const openSet = new Set(
    (Array.isArray(opts.defaultOpen) ? opts.defaultOpen : [opts.defaultOpen])
      .map((value) => (typeof value === 'number' ? value : entries.findIndex((e) => e.trigger.id === value || e.trigger.dataset.value === value)))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < entries.length),
  );

  function setOpen(entry, next, reason) {
    if (isDisabled(entry.trigger)) return;
    if (opts.type === 'single' && next && !entry.open) {
      entries.forEach((other) => {
        if (other !== entry && other.open) paint(other, false, reason);
      });
      openSet.clear();
    }
    paint(entry, next, reason);
  }

  function paint(entry, next, reason) {
    if (entry.open === next) return;
    entry.open = next;
    entry.trigger.setAttribute('aria-expanded', String(next));
    entry.panel.hidden = !next;
    setState(entry.item, next ? 'open' : 'closed');
    setState(entry.trigger, next ? 'open' : 'closed');
    if (next) openSet.add(entries.indexOf(entry));
    else openSet.delete(entries.indexOf(entry));
    emit(root, next ? 'hf:open' : 'hf:close', { index: entries.indexOf(entry), reason });
  }

  const offs = entries.map((entry) => {
    const onClick = () => {
      const next = entry.open ? opts.collapsible : true;
      if (entry.open && !opts.collapsible && opts.type === 'single') return;
      setOpen(entry, next, 'trigger');
    };
    entry.trigger.addEventListener('click', onClick);
    return () => entry.trigger.removeEventListener('click', onClick);
  });

  entries.forEach((entry, index) => {
    if (openSet.has(index)) paint(entry, true, 'initial');
  });

  return {
    get openIndexes() {
      return Array.from(openSet).sort((a, b) => a - b);
    },
    open(index, reason = 'api') {
      const entry = entries[index];
      if (entry && !destroyed) setOpen(entry, true, reason);
    },
    close(index, reason = 'api') {
      const entry = entries[index];
      if (entry && !destroyed) paint(entry, false, reason);
    },
    toggle(index, reason = 'api') {
      const entry = entries[index];
      if (entry && !destroyed) setOpen(entry, !entry.open, reason);
    },
    destroy() {
      destroyed = true;
      offs.forEach((off) => off());
    },
  };
}
