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
    /* Drop indicator: where the dragged element will land. A 2px line was
       invisible over the page, so a sibling drop draws a 4px bar with end caps
       and an inside drop fills the target. */
    .__hf-drop {
      position: fixed;
      /* Without an explicit inset a fixed box keeps its static position at the
         end of the document, so the translate below drew it far off-screen. */
      inset: 0 auto auto 0;
      pointer-events: none;
      z-index: 2147483001;
      background: #4f46e5;
      box-sizing: border-box;
    }
    .__hf-drop--line { block-size: 4px; border-radius: 2px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.7); }
    .__hf-drop--line::before,
    .__hf-drop--line::after {
      content: '';
      position: absolute;
      inset-block: -3px;
      inline-size: 4px;
      background: #4f46e5;
      border-radius: 2px;
    }
    .__hf-drop--line::before { inset-inline-start: 0; }
    .__hf-drop--line::after { inset-inline-end: 0; }
    .__hf-drop--zone {
      background: rgb(79 70 229 / 0.15);
      border: 2px dashed #4f46e5;
      border-radius: 4px;
    }
    .__hf-drag { opacity: 0.35; outline: 2px dashed #4f46e5 !important; outline-offset: 1px !important; }

    /* Page layout tab: the page's real content is hidden and only the
       structure of the chosen frame is drawn. Everything is done from here,
       never by editing the project's own CSS. */
    html.__hf-skeleton body * { visibility: hidden !important; }
    html.__hf-skeleton body::before {
      content: '';
      position: fixed;
      inset: 0;
      z-index: 2147482998;
      background: repeating-linear-gradient(
        45deg,
        rgb(79 70 229 / 0.05) 0 10px,
        rgb(79 70 229 / 0.12) 10px 20px
      );
    }
    html.__hf-skeleton .__hf-skel {
      position: fixed;
      z-index: 2147482999;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      border: 2px dashed #4f46e5;
      border-radius: 6px;
      background: rgb(79 70 229 / 0.06);
      color: #4f46e5;
      font: 600 13px/1.2 ui-sans-serif, system-ui, sans-serif;
      text-transform: lowercase;
      visibility: visible !important;
    }
  `;
  document.head.append(style);

  const overlay = document.createElement('div');
  overlay.className = '__hf-overlay';
  overlay.hidden = true;
  const hoverBox = document.createElement('div');
  hoverBox.className = '__hf-hover';
  hoverBox.hidden = true;
  const dropBox = document.createElement('div');
  dropBox.className = '__hf-drop';
  dropBox.hidden = true;
  document.documentElement.append(overlay, hoverBox, dropBox);

  // Unsaved declaration edits are applied straight to the page's CSSOM, not
  // as an appended override: removing a declaration has to actually remove it,
  // otherwise the original rule keeps winning the cascade.
  const cssOriginals = new Map(); // CSSStyleRule -> cssText as the stylesheet declared it
  const liveAttrs = new Map();
  const liveTexts = new Map();

  let selectedId = null;
  let selectedEl = null;
  // Page layout tab: when set, the real page is hidden and these area boxes
  // are drawn instead. `null` means normal editing.
  let skeletonAreas = null;
  // True while the placement panel is open: geometry is only measured (a
  // forced layout read) when someone is actually looking at it.
  let measureWanted = false;
  // Drag-to-move: press on a node, move past a threshold, release over a
  // target. Only the *intent* is computed here; the studio turns it into an
  // op through the normal pending/save path, so a drag is never a write.
  const DRAG_THRESHOLD = 6;
  let drag = null; // { id, el, startX, startY, active, target, position }
  // Picking is the point of the studio, so it is on until the user turns it
  // off to interact with the page itself.
  let picking = true;

  /**
   * Draws (or clears) the wireframe overlay.
   *
   * Must survive the preview reloading: the studio re-sends `skeleton` after a
   * rebuild, but a reload drops the DOM this painted into, so it is idempotent
   * and re-creates its own layer every time.
   */
  function paintSkeleton() {
    const html = document.documentElement;
    const previous = html.querySelector('.__hf-skel-layer');
    previous?.remove();

    if (!skeletonAreas) {
      html.classList.remove('__hf-skeleton');
      return;
    }
    // Hide every other overlay: skeleton mode is a page-level view, not a
    // node-level one.
    hoverBox.hidden = true;
    dropBox.hidden = true;
    paintOverlay();
    html.classList.add('__hf-skeleton');

    const layer = document.createElement('div');
    layer.className = '__hf-skel-layer';
    // The layer itself must not hide: only the page's content does.
    layer.style.visibility = 'visible';
    for (const area of skeletonAreas) {
      const box = document.createElement('div');
      box.className = '__hf-skel';
      box.dataset.area = area.name;
      box.textContent = area.name;
      box.style.left = `${area.x}%`;
      box.style.top = `${area.y}%`;
      box.style.width = `${area.w}%`;
      box.style.height = `${area.h}%`;
      layer.append(box);
    }
    html.append(layer);
  }

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
    // The wireframe replaces the page visually; a selection box drawn over it
    // would point at content the user cannot see.
    if (skeletonAreas || !selectedEl || !document.contains(selectedEl)) {
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
    postGeometry();
  }

  /** Minimal identity for an element that has no `data-hf-node` of its own. */
  function describeElement(el) {
    return {
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList).filter((name) => name !== '__hf-selected'),
      text: (el.textContent ?? '').trim().slice(0, 60),
    };
  }

  /**
   * Where the selected element actually sits, measured from the live layout.
   *
   * The studio model has no geometry: it is a source scan, so it cannot know
   * that a `grid` row resolved to 180px or that the element is inside the
   * header band. This is the one thing only the rendered frame can answer, so
   * the panel asks for it instead of guessing.
   *
   * Coordinates are page-relative (`scrollX/Y` added), which keeps them stable
   * while the user scrolls; the element's share of the page is computed from
   * the document's scroll size, not the viewport.
   */
  function describeGeometry(el) {
    if (!el || !document.contains(el)) return null;
    const rect = el.getBoundingClientRect();
    const doc = document.documentElement;
    const style = getComputedStyle(el);
    const label = (node) => {
      if (!node) return null;
      const described = describeElement(node);
      return `${described.tag}${described.classes.length ? `.${described.classes.join('.')}` : ''}`;
    };
    return {
      tag: el.tagName.toLowerCase(),
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      pageWidth: Math.round(doc.scrollWidth),
      pageHeight: Math.round(doc.scrollHeight),
      display: style.display,
      position: style.position,
      zIndex: style.zIndex === 'auto' ? null : style.zIndex,
      offsetParent: label(el.offsetParent),
      parent: label(el.parentElement),
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

  /**
   * Rules are snapshotted as `cssText`, not as a list of longhands.
   *
   * A shorthand holding a custom property (`background: var(--hf-surface)`) is
   * a *pending-substitution* value: the CSSOM expands it into longhands that
   * each report an empty value. Replaying those longhands silently deleted the
   * declaration, so editing any element blanked `body`'s background to white.
   * `cssText` keeps the shorthand as written and round-trips verbatim.
   */
  function snapshotRule(rule) {
    return rule.style.cssText;
  }

  /** Puts a rule back exactly as the stylesheet declared it. */
  function restoreRule(rule, cssText) {
    rule.style.cssText = cssText;
  }

  /** Applies the panel's pending ops to the live document (no file writes). */
  function applyLive(data) {
    // Restore every rule first, then replay the pending set: that way a
    // removed declaration really disappears instead of leaving a stale
    // override that the original rule would keep winning against.
    const all = rulesByFile();
    for (const { rule } of all) {
      const original = cssOriginals.get(rule);
      if (original !== undefined) restoreRule(rule, original);
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
    if (skeletonAreas) return;
    if (!picking) return;
    // A drag ends with pointerup then click; the click must not re-select.
    if (drag?.active) return;
    const el = nodeOf(event.target);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    // `event.target` may be inside the host's rendered content (a component
    // template), which is a different file from the page.
    select(el, { origin: event.target });
  }

  function onHover(event) {
    if (skeletonAreas) return;
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

  /**
   * Where would `node` land if dropped over `target`?
   *
   * Inside the target when the pointer is well within it (the middle
   * three-fifths), otherwise before or after it on the dominant axis. This is
   * the usual block-editor rule, and it makes "move this below that" possible
   * without a second gesture.
   */
  // Tags that read as "somewhere things go". Dropping inside an <h2> or a
  // <code> is never what the user meant, so those only take before/after.
  const CONTAINER_TAGS = new Set([
    'div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside',
    'ul', 'ol', 'li', 'form', 'fieldset', 'body', 'figure', 'details',
  ]);

  function isContainer(el) {
    if (CONTAINER_TAGS.has(el.tagName.toLowerCase())) return true;
    return el.childElementCount > 0 && getComputedStyle(el).display !== 'inline';
  }

  /**
   * Resolves the element a drop should target.
   *
   * `elementFromPoint` returns the deepest node under the cursor, which is
   * often an inline leaf (`<code>` inside a paragraph, a `<span>` in a
   * button). Moving a block into one of those is never the intent, so climb
   * until the node is something a block can sensibly land in or beside.
   */
  function dropTargetOf(el, dragged) {
    let target = el;
    while (target && (target === dragged || dragged.contains(target))) target = target.parentElement;
    // Climb out of inline leaves so the drop lands on their block parent.
    while (target && target !== dragged && !isContainer(target)) {
      const parent = target.parentElement;
      if (!parent || parent === dragged || dragged.contains(parent)) break;
      target = parent;
    }
    return target && target !== dragged && !dragged.contains(target) ? target : null;
  }

  function dropPosition(node, target, x, y) {
    if (!target || node === target || target.contains(node)) return null;
    const rect = rectOf(target);
    const px = (x - rect.x) / Math.max(rect.width, 1);
    const py = (y - rect.y) / Math.max(rect.height, 1);
    const inside = px > 0.2 && px < 0.8 && py > 0.2 && py < 0.8;
    // Only a container can receive the element as a child; anything else
    // takes it as a sibling, which is what the pointer position implies.
    if (inside && isContainer(target)) return { position: 'append', rect };
    if (rect.width >= rect.height) return { position: px < 0.5 ? 'before' : 'after', rect };
    return { position: py < 0.5 ? 'before' : 'after', rect };
  }

  /** Paints the drop indicator for a resolved position. */
  function paintDrop(entry) {
    if (!entry) {
      dropBox.hidden = true;
      return;
    }
    const { rect, position } = entry;
    dropBox.hidden = false;
    dropBox.className = `__hf-drop ${position === 'append' ? '__hf-drop--zone' : '__hf-drop--line'}`;
    dropBox.style.width = `${rect.width}px`;
    if (position === 'append') {
      dropBox.style.height = `${rect.height}px`;
      dropBox.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
      return;
    }
    const bar = 4;
    dropBox.style.height = `${bar}px`;
    const top = position === 'before' ? rect.y : rect.y + rect.height - bar;
    dropBox.style.transform = `translate(${rect.x}px, ${top}px)`;
  }

  function onPointerDown(event) {
    if (!picking || event.button !== 0) return;
    const el = nodeOf(event.target);
    if (!el) return;
    drag = { id: el.dataset.hfNode, el, startX: event.clientX, startY: event.clientY, active: false, target: null, position: null };
  }

  function onPointerMove(event) {
    if (!drag) return;
    if (!drag.active) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (moved < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.el.classList.add('__hf-drag');
      hoverBox.hidden = true;
    }
    // The pointer is over the drop indicator (pointer-events: none), so the
    // hit test below sees the real element underneath it.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const target = under ? dropTargetOf(nodeOf(under), drag.el) : null;
    const resolved = target ? dropPosition(drag.el, target, event.clientX, event.clientY) : null;
    drag.target = target && resolved ? target.dataset.hfNode : null;
    drag.position = resolved?.position ?? null;
    paintDrop(resolved && target ? { rect: rectOf(target), position: resolved.position } : null);
  }

  function endDrag(event, cancelled) {
    if (!drag) return;
    const finished = drag.active && drag.target && drag.position && !cancelled;
    drag.el.classList.remove('__hf-drag');
    dropBox.hidden = true;
    const move = finished
      ? { nodeId: drag.id, targetId: drag.target, position: drag.position }
      : null;
    drag = null;
    if (move) post('drag-move', move);
    else paintOverlay();
    // A completed drag must not also register as a click-pick.
    if (finished) event?.preventDefault?.();
  }

  function onPointerUp(event) {
    if (!drag) return;
    endDrag(event, false);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && drag) {
      endDrag(event, true);
      event.stopPropagation();
    }
  }

  // Capture phase so project handlers cannot swallow the pick.
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerover', onHover, true);
  document.addEventListener('pointerleave', () => {
    hoverBox.hidden = true;
  });
  // No geometry update on scroll: the panel reports page-relative
  // coordinates (`scrollX + rect.left`), which do not change while scrolling.
  // Reposting them would re-render the panel every frame for identical values.
  window.addEventListener('scroll', paintOverlay, true);
  window.addEventListener('resize', () => {
    paintOverlay();
    postGeometry();
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'hf-studio') return;
    if (data.type === 'select') {
      const el = data.id ? document.querySelector(`[data-hf-node="${CSS.escape(data.id)}"]`) : null;
      select(el, { scroll: Boolean(data.scroll) });
    } else if (data.type === 'live') {
      applyLive(data);
    } else if (data.type === 'scroll-to') {
      window.scrollTo(0, Number(data.y) || 0);
    } else if (data.type === 'picking') {
      picking = Boolean(data.value);
      document.documentElement.style.cursor = picking ? 'crosshair' : '';
    } else if (data.type === 'skeleton') {
      // `areas` is absent (or null) when the user leaves the page layout tab.
      skeletonAreas = Array.isArray(data.areas) ? data.areas : null;
      paintSkeleton();
    } else if (data.type === 'measure') {
      // The placement readout must stay correct across resizes and edits, so
      // remember that the panel is watching and answer this request now.
      measureWanted = Boolean(data.watch);
      postGeometry();
    } else if (data.type === 'reposition') {
      paintOverlay();
    }
  });

  /** Sends the current geometry, but only when the panel asked for it. */
  function postGeometry() {
    if (!measureWanted) return;
    const geometry = describeGeometry(selectedEl);
    if (geometry) post('geometry', { geometry });
  }

  // The panel needs the document height to keep its scroll position sane.
  new ResizeObserver(paintOverlay).observe(document.documentElement);
  post('ready');
})();
