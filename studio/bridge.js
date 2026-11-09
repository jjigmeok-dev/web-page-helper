/**
 * Preview bridge. Runs inside the project page iframe.
 *
 * Responsibilities, all read-only with respect to the project:
 * - translate a click/hover on `[data-hf-node]` into a selection message
 * - draw an overlay highlight over the selected node
 * - scroll a selected node into view on request
 *
 * The bridge never mounts, mutates or styles project elements; the overlay
 * is a separate fixed-position element it owns.
 */
(() => {
  if (window.__hfBridge) return;
  window.__hfBridge = true;

  const parent = window.parent;
  if (parent === window) return;

  const style = document.createElement('style');
  style.textContent = `
    .__hf-overlay {
      position: fixed;
      pointer-events: none;
      z-index: 2147483000;
      border: 2px solid #4f46e5;
      background: rgb(79 70 229 / 0.08);
      border-radius: 2px;
      transition: none;
      inset: 0 auto auto 0;
    }
    .__hf-hover {
      position: fixed;
      pointer-events: none;
      z-index: 2147482999;
      border: 1px dashed #a1a1aa;
      border-radius: 2px;
      inset: 0 auto auto 0;
    }
    .__hf-selected { outline: 2px solid #4f46e5 !important; outline-offset: -2px !important; }
  `;
  document.head.append(style);

  const overlay = document.createElement('div');
  overlay.className = '__hf-overlay';
  overlay.hidden = true;
  const hoverBox = document.createElement('div');
  hoverBox.className = '__hf-hover';
  hoverBox.hidden = true;
  document.documentElement.append(overlay, hoverBox);

  // Unsaved declaration edits are applied straight to the page's CSSOM, not
  // as an appended override: removing a declaration has to actually remove it,
  // otherwise the original rule keeps winning the cascade.
  const cssOriginals = new Map(); // CSSStyleRule -> [[property, value, priority], …]
  const liveAttrs = new Map();
  const liveTexts = new Map();

  let selectedId = null;
  let selectedEl = null;
  // Picking is the point of the studio, so it is on until the user turns it
  // off to interact with the page itself.
  let picking = true;

  function post(type, payload = {}) {
    parent.postMessage({ source: 'hf-bridge', type, ...payload }, '*');
  }

  function nodeOf(el) {
    return el?.closest?.('[data-hf-node]') ?? null;
  }

  function rectOf(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  function paintOverlay() {
    if (!selectedEl || !document.contains(selectedEl)) {
      overlay.hidden = true;
      return;
    }
    const rect = rectOf(selectedEl);
    overlay.hidden = false;
    overlay.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  /**
   * `origin` is the element the user actually clicked. It differs from `el`
   * when the click landed on a component's rendered internals: those live in
   * the component template, not in the page file, so the studio must be told
   * both the addressable host and the real target.
   */
  function select(el, { scroll = false, origin = null } = {}) {
    if (selectedEl) selectedEl.classList.remove('__hf-selected');
    selectedEl = el;
    selectedId = el?.dataset.hfNode ?? null;
    if (selectedEl) selectedEl.classList.add('__hf-selected');
    paintOverlay();
    if (scroll && selectedEl) selectedEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    const target = origin && origin !== el ? describeElement(origin) : null;
    post('selected', { id: selectedId, target });
  }

  /** Minimal identity for an element that has no `data-hf-node` of its own. */
  function describeElement(el) {
    return {
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList).filter((name) => name !== '__hf-selected'),
      text: (el.textContent ?? '').trim().slice(0, 60),
    };
  }

  /** Every reachable style rule, in document order, keyed by sheet + selector. */
  function rulesByFile() {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet: not ours to touch
      }
      const file = fileOf(sheet);
      const walk = (list) => {
        for (const rule of list) {
          if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE || rule.type === CSSRule.LAYER_BLOCK_RULE) {
            walk(rule.cssRules);
          } else if (rule.selectorText && rule.style) {
            out.push({ file, sheet, rule });
          }
        }
      };
      walk(rules);
    }
    return out;
  }

  function fileOf(sheet) {
    if (sheet.href) {
      try {
        return new URL(sheet.href).pathname.replace(/^\//, '');
      } catch {
        return sheet.href;
      }
    }
    return 'index.html';
  }

  function snapshotRule(rule) {
    const style = rule.style;
    const decls = [];
    for (let i = 0; i < style.length; i += 1) {
      const property = style.item(i);
      decls.push([property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
    }
    return decls;
  }

  /** Puts a rule back exactly as the stylesheet declared it. */
  function restoreRule(rule, decls) {
    const style = rule.style;
    for (let i = style.length - 1; i >= 0; i -= 1) style.removeProperty(style.item(i));
    for (const [property, value, priority] of decls) style.setProperty(property, value, priority);
  }

  /** Applies the panel's pending ops to the live document (no file writes). */
  function applyLive(data) {
    // Restore every rule first, then replay the pending set: that way a
    // removed declaration really disappears instead of leaving a stale
    // override that the original rule would keep winning against.
    const all = rulesByFile();
    for (const { rule } of all) {
      const original = cssOriginals.get(rule);
      if (original) restoreRule(rule, original);
      else cssOriginals.set(rule, snapshotRule(rule));
    }

    for (const change of data.decls ?? []) {
      const targets = all.filter((entry) => entry.file === change.file && entry.rule.selectorText === change.selector);
      const target = targets.at(-1); // last one wins, like the cascade
      if (!target?.rule.style) continue;
      if (change.value === null) target.rule.style.removeProperty(change.property);
      else target.rule.style.setProperty(change.property, change.value);
    }

    const keep = new Set();
    for (const change of data.attrs ?? []) {
      const el = document.querySelector(`[data-hf-node="${CSS.escape(change.id)}"]`);
      if (!el) continue;
      const key = `${change.id}::${change.name}`;
      keep.add(key);
      if (!liveAttrs.has(key)) liveAttrs.set(key, { el, name: change.name, value: el.getAttribute(change.name) });
      if (change.value === null) el.removeAttribute(change.name);
      else el.setAttribute(change.name, change.value);
    }
    for (const [key, entry] of liveAttrs) {
      if (keep.has(key)) continue;
      if (entry.value === null) entry.el.removeAttribute(entry.name);
      else entry.el.setAttribute(entry.name, entry.value);
      liveAttrs.delete(key);
    }

    const keepText = new Set();
    for (const change of data.texts ?? []) {
      const el = document.querySelector(`[data-hf-node="${CSS.escape(change.id)}"]`);
      if (!el) continue;
      keepText.add(change.id);
      if (!liveTexts.has(change.id)) liveTexts.set(change.id, { el, value: el.textContent });
      el.textContent = change.value;
    }
    for (const [id, entry] of liveTexts) {
      if (keepText.has(id)) continue;
      entry.el.textContent = entry.value;
      liveTexts.delete(id);
    }
    paintOverlay();
  }

  function onClick(event) {
    if (!picking) return;
    const el = nodeOf(event.target);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    // `event.target` may be inside the host's rendered content (a component
    // template), which is a different file from the page.
    select(el, { origin: event.target });
  }

  function onHover(event) {
    const el = nodeOf(event.target);
    if (!el) {
      hoverBox.hidden = true;
      return;
    }
    const rect = rectOf(el);
    hoverBox.hidden = false;
    hoverBox.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    hoverBox.style.width = `${rect.width}px`;
    hoverBox.style.height = `${rect.height}px`;
  }

  // Capture phase so project handlers cannot swallow the pick.
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerover', onHover, true);
  document.addEventListener('pointerleave', () => {
    hoverBox.hidden = true;
  });
  window.addEventListener('scroll', paintOverlay, true);
  window.addEventListener('resize', paintOverlay);

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'hf-studio') return;
    if (data.type === 'select') {
      const el = data.id ? document.querySelector(`[data-hf-node="${CSS.escape(data.id)}"]`) : null;
      select(el, { scroll: Boolean(data.scroll) });
    } else if (data.type === 'live') {
      applyLive(data);
    } else if (data.type === 'picking') {
      picking = Boolean(data.value);
      document.documentElement.style.cursor = picking ? 'crosshair' : '';
    } else if (data.type === 'reposition') {
      paintOverlay();
    }
  });

  // The panel needs the document height to keep its scroll position sane.
  new ResizeObserver(paintOverlay).observe(document.documentElement);
  post('ready');
})();
