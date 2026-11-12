import { KEY, emit, isDisabled, needsId, options, part, parts, setState, nonSubmit } from './core.js';

/**
 * Accordion: a group of disclosures with single or multiple expansion.
 *
 * Two markups, same foundation, chosen per item:
 *
 * **Native** — `<details>`/`<summary>` get exclusivity, keyboard activation and
 * the open state from the platform, and keep working with JavaScript disabled:
 *
 * <div data-hf="accordion" data-hf-options='{"type":"single"}'>
 *   <details data-hf-part="item">
 *     <summary data-hf-part="trigger">Section</summary>
 *     <div data-hf-part="panel">…</div>
 *   </details>
 * </div>
 *
 * **ARIA** — plain buttons, for layouts a `summary` cannot express:
 *
 * <div data-hf="accordion" data-hf-options='{"type":"single","collapsible":true}'>
 *   <div data-hf-part="item">
 *     <h3><button data-hf-part="trigger">Section</button></h3>
 *     <div data-hf-part="panel">…</div>
 *   </div>
 * </div>
 *
 * `type: 'single'` sets a shared `name` on native items so the *browser*
 * enforces exclusivity (`details-name`, newly) instead of the bookkeeping loop;
 * the loop still runs so both markups behave identically.
 *
 * `collapsible: false` has no platform equivalent: `toggle` is not cancelable,
 * so a user-initiated close is reverted inside its own event, before paint.
 */
export const meta = {
  name: 'accordion',
  file: import.meta.url,
  summary: 'Grouped disclosures, single-open or multi-open.',
  parts: { item: 'any', trigger: 'button | summary', panel: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['item'],
  options: { type: 'single', collapsible: true, defaultOpen: [] },
  events: ['hf:open', 'hf:close'],
};

let groupCounter = 0;

export function mount(root) {
  const items = parts(root, 'item');
  if (!items.length) throw new Error('[hf] accordion needs at least one [data-hf-part="item"]');
  const opts = options(root, meta.options);
  if (opts.type !== 'single' && opts.type !== 'multiple') opts.type = 'single';

  // `<details>` in the markup selects the native path for that item. Mixing the
  // two in one accordion would give two sources of truth for `type: 'single'`.
  const native = items.some((item) => item.tagName === 'DETAILS');
  if (native && items.some((item) => item.tagName !== 'DETAILS')) {
    throw new Error('[hf] accordion cannot mix <details> items with other elements');
  }

  // The platform closes siblings itself, but only when `name` is supported;
  // setting the attribute is harmless where it is not.
  const groupName = opts.type === 'single' && native ? `hf-accordion-${(groupCounter += 1)}` : null;

  const entries = items.map((item) => {
    const trigger = nonSubmit(part(item, 'trigger'));
    if (!trigger) throw new Error('[hf] accordion item needs a trigger');
    const panel = part(item, 'panel');
    if (native) {
      if (trigger.tagName !== 'SUMMARY') throw new Error('[hf] accordion <details> item needs a <summary> trigger');
      if (groupName) item.name = groupName;
      // `<details open>` exposes the state itself, so ARIA is left to it.
      if (panel) {
        if (!panel.hasAttribute('id')) needsId(panel, 'hf-accordion-panel');
        panel.removeAttribute('hidden');
      }
      const open = item.hasAttribute('open');
      return { item, trigger, panel, native: true, open };
    }
    if (!panel) throw new Error('[hf] accordion item needs a trigger and a panel');
    const panelId = needsId(panel, 'hf-accordion-panel');
    trigger.setAttribute('aria-controls', panelId);
    trigger.setAttribute('aria-expanded', 'false');
    if (!panel.hasAttribute('role')) panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', needsId(trigger, 'hf-accordion-trigger'));
    panel.hidden = true;
    return { item, trigger, panel, native: false, open: false };
  });

  let destroyed = false;
  // Marks the stretch where *we* move state, so a `collapsible: false` veto
  // cannot undo a programmatic close or squat against a sibling takeover.
  let driving = 0;
  const openSet = new Set();
  entries.forEach((entry, index) => {
    if (entry.open) openSet.add(index);
  });

  const asked = Array.isArray(opts.defaultOpen) ? opts.defaultOpen : [opts.defaultOpen];
  for (const value of asked) {
    const index =
      typeof value === 'number'
        ? value
        : entries.findIndex((entry) => entry.trigger.id === value || entry.trigger.dataset.value === value);
    if (Number.isInteger(index) && index >= 0 && index < entries.length) openSet.add(index);
  }

  function paint(entry, next, why) {
    if (entry.open === next) return;
    entry.open = next;
    if (entry.native) {
      // Programmatic changes do not fire `toggle`, so this cannot recurse.
      entry.item.open = next;
      if (entry.panel) entry.panel.hidden = false;
    } else {
      entry.trigger.setAttribute('aria-expanded', String(next));
      entry.panel.hidden = !next;
    }
    setState(entry.item, next ? 'open' : 'closed');
    setState(entry.trigger, next ? 'open' : 'closed');
    const index = entries.indexOf(entry);
    if (next) openSet.add(index);
    else openSet.delete(index);
    emit(root, next ? 'hf:open' : 'hf:close', { index, reason: why });
  }

  function setOpen(entry, next, why) {
    if (isDisabled(entry.trigger)) return;
    driving += 1;
    try {
      if (opts.type === 'single' && next && !entry.open) {
        for (const other of entries) {
          if (other !== entry && other.open) paint(other, false, why);
        }
      }
      paint(entry, next, why);
    } finally {
      driving -= 1;
    }
  }

  const offs = entries.map((entry) => {
    if (entry.native) {
      // `toggle` fires synchronously inside the activation task, so a veto here
      // happens before paint and the panel never flashes.
      const onToggle = () => {
        const next = entry.item.open;
        if (!next) {
          // A close the user asked for is refused when the item must stay open.
          // A close caused by a sibling opening is not: that is exclusivity
          // doing its job, and vetoing it would fight the platform for the
          // panel. `driving` covers our own programmatic writes the same way.
          const takeover = driving > 0 || entries.some((other) => other !== entry && other.open);
          const refused = !opts.collapsible && opts.type === 'single' && !takeover;
          if (refused || isDisabled(entry.trigger)) {
            entry.item.open = true;
            return;
          }
        }
        setOpen(entry, next, 'trigger');
      };
      entry.item.addEventListener('toggle', onToggle);
      return () => entry.item.removeEventListener('toggle', onToggle);
    }
    const onClick = () => {
      const next = entry.open ? opts.collapsible : true;
      if (entry.open && !opts.collapsible && opts.type === 'single') return;
      setOpen(entry, next, 'trigger');
    };
    entry.trigger.addEventListener('click', onClick);
    return () => entry.trigger.removeEventListener('click', onClick);
  });

  // Paint `defaultOpen` (or markup state) and give every item a `data-state`:
  // consumer CSS keys off it, and a missing attribute is not the same as
  // "closed" for a selector like `[data-state='closed']`.
  entries.forEach((entry, index) => {
    const wanted = openSet.has(index);
    if (wanted && !entry.open) {
      entry.open = true;
      if (entry.native) entry.item.open = true;
      else {
        entry.trigger.setAttribute('aria-expanded', 'true');
        entry.panel.hidden = false;
      }
    }
    setState(entry.item, entry.open ? 'open' : 'closed');
    setState(entry.trigger, entry.open ? 'open' : 'closed');
  });

  return {
    get openIndexes() {
      return Array.from(openSet).sort((a, b) => a - b);
    },
    /** True when the items are `<details>` and the platform owns the state. */
    get isNative() {
      return native;
    },
    open(index, why = 'api') {
      const entry = entries[index];
      if (entry && !destroyed) setOpen(entry, true, why);
    },
    close(index, why = 'api') {
      const entry = entries[index];
      if (entry && !destroyed) paint(entry, false, why);
    },
    toggle(index, why = 'api') {
      const entry = entries[index];
      if (entry && !destroyed) setOpen(entry, !entry.open, why);
    },
    destroy() {
      destroyed = true;
      offs.forEach((off) => off());
      // Only the group name is ours to remove; it would otherwise keep
      // unrelated instances exclusive. Mirrored state stays as the last
      // painted value: destroy stops mutating, it does not revert.
      for (const entry of entries) if (entry.native) entry.item.removeAttribute('name');
    },
  };
}
