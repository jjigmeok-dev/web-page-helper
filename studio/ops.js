/**
 * Client-side op builders.
 *
 * The panel never sends raw strings to the server; every control goes
 * through one of these functions, so op shapes stay in one place and are
 * testable without a browser.
 */

/** Values that mean "remove this declaration" rather than "set empty". */
const EMPTY = new Set(['', null, undefined]);

export function nodeLabel(node) {
  if (!node) return 'nothing selected';
  const id = node.domId ? `#${node.domId}` : '';
  const cls = node.classes.length ? `.${node.classes[0]}` : '';
  return `<${node.tag}${id}${cls}>`;
}

/* ------------------------------------------------------------ layout */

/**
 * Builds `setDecl` / `removeDecl` ops for a set of declarations on one node.
 * @param {{file: string, version?: string, selector: string, decls: object, previous?: object, create?: boolean}} input
 */
export function layoutOps({ file, version, selector, decls, previous = {}, create = true, createFile = false }) {
  if (!selector) throw new Error('a selector is required to write layout');
  const ops = [];
  for (const [property, value] of Object.entries(decls)) {
    const before = previous[property];
    const isRemoval = EMPTY.has(value) && value !== 0;
    if (isRemoval) {
      if (before === undefined || before === '') continue;
      ops.push({ op: 'removeDecl', file, selector, property, version });
      continue;
    }
    const next = String(value);
    if (before === next) continue;
    ops.push({
      op: 'setDecl',
      file,
      selector,
      property,
      value: next,
      version,
      create,
      // A page with no stylesheet yet: the op creates the file it writes to.
      ...(createFile ? { createFile: true } : {}),
      ...(before !== undefined ? { expect: before } : {}),
    });
  }
  return ops;
}

/** A box-model edit becomes several declarations at once. */
export function boxOps({ file, version, selector, box, previous = {}, create = true }) {
  const decls = {
    display: box.display,
    gap: box.gap,
    padding: box.padding,
    'align-items': box.alignItems,
    'justify-content': box.justifyContent,
    'grid-template-columns': box.columns,
    'flex-direction': box.direction,
  };
  return layoutOps({ file, version, selector, decls, previous, create });
}

/* ------------------------------------------------------------ components */

/** Foundation options live in one `data-hf-options` attribute. */
export function optionsOp({ file, version, nodeId, options, previous }) {
  const next = JSON.stringify(options);
  const before = previous ? JSON.stringify(previous) : undefined;
  if (before === next) return [];
  return [
    {
      op: 'setAttr',
      file,
      node: nodeId,
      name: 'data-hf-options',
      value: next,
      version,
      ...(before !== undefined ? { expect: before } : {}),
    },
  ];
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** User-component props map to kebab-case attributes on the host element. */
export function propsOps({ file, version, nodeId, props, previous = {}, defaults = {} }) {
  const ops = [];
  for (const [key, value] of Object.entries(props)) {
    const name = kebab(key);
    const before = previous[key];
    const fallback = defaults[key];
    const isDefault = value === fallback || value === '' || value === null || value === undefined;
    if (isDefault) {
      if (before === undefined) continue;
      ops.push({ op: 'removeAttr', file, node: nodeId, name, version });
      continue;
    }
    const next = value === true ? true : String(value);
    if (before === next) continue;
    ops.push({ op: 'setAttr', file, node: nodeId, name, value: next, version });
  }
  return ops;
}

/* ------------------------------------------------------------ structure */

export function insertOp({ file, version, nodeId, position, html }) {
  return [{ op: 'insertNode', file, node: nodeId, position, html, version }];
}

export function removeOp({ file, version, nodeId }) {
  return [{ op: 'removeNode', file, node: nodeId, version }];
}

export function moveOp({ file, version, nodeId, targetId, position = 'append' }) {
  return [{ op: 'moveNode', file, node: nodeId, target: targetId, position, version }];
}

export function duplicateOp({ file, version, nodeId }) {
  return [{ op: 'duplicateNode', file, node: nodeId, version }];
}

export function wrapOp({ file, version, nodeId, html }) {
  return [{ op: 'wrapNode', file, node: nodeId, html, version }];
}

export function textOp({ file, version, nodeId, value, previous }) {
  if (previous === value) return [];
  return [{ op: 'setText', file, node: nodeId, value, version, ...(previous !== undefined ? { expect: previous } : {}) }];
}

/* ------------------------------------------------------------ frames */

/**
 * Frame presets: a page skeleton the user can insert as a whole.
 * `slot` is where the current page content is moved into.
 *
 * `areas` describes the same skeleton as a grid for the Page layout tab, which
 * draws each preset as an empty wireframe: the point of that tab is to compare
 * shapes, so it must not render the page's real content.
 *   { name, x, y, w, h }  in a 100 x 100 grid cell space.
 */
export const FRAME_PRESETS = [
  {
    id: 'header-main-footer',
    name: '헤더 / 본문 / 푸터',
    description: '기본 문서 골격입니다. 지금 내용이 본문 자리로 들어갑니다.',
    html: `<div class="layout">
  <header class="layout__header">Header</header>
  <main class="layout__main" data-hf-frame-slot></main>
  <footer class="layout__footer">Footer</footer>
</div>`,
    css: `.layout {
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-block-size: 100dvh;
}

.layout__header,
.layout__footer {
  padding: 1rem 1.25rem;
  border-block-end: 1px solid var(--hf-border);
}

.layout__footer {
  border-block-end: 0;
  border-block-start: 1px solid var(--hf-border);
}

.layout__main {
  padding: 1.25rem;
}
`,
    slot: '.layout__main',
    areas: [
      { name: 'header', x: 0, y: 0, w: 100, h: 18 },
      { name: 'main', x: 0, y: 18, w: 100, h: 64 },
      { name: 'footer', x: 0, y: 82, w: 100, h: 18 },
    ],
  },
  {
    id: 'sidebar-main',
    name: '사이드바 / 본문',
    description: '고정 사이드바가 있는 2열 골격입니다. 좁은 화면에서는 세로로 쌓입니다.',
    html: `<div class="layout">
  <aside class="layout__sidebar">Navigation</aside>
  <main class="layout__main" data-hf-frame-slot></main>
</div>`,
    css: `.layout {
  display: grid;
  grid-template-columns: minmax(14rem, 18rem) 1fr;
  min-block-size: 100dvh;
}

.layout__sidebar {
  padding: 1.25rem;
  border-inline-end: 1px solid var(--hf-border);
  background: var(--hf-surface);
}

.layout__main {
  padding: 1.25rem;
}

@media (max-width: 48rem) {
  .layout {
    grid-template-columns: 1fr;
  }
}
`,
    slot: '.layout__main',
    areas: [
      { name: 'sidebar', x: 0, y: 0, w: 32, h: 100 },
      { name: 'main', x: 32, y: 0, w: 68, h: 100 },
    ],
  },
  {
    id: 'holy-grail',
    name: '헤더 / 사이드바 / 본문 / 푸터',
    description: '네 영역을 모두 갖춘 전체 앱 골격입니다.',
    html: `<div class="layout">
  <header class="layout__header">Header</header>
  <aside class="layout__sidebar">Navigation</aside>
  <main class="layout__main" data-hf-frame-slot></main>
  <footer class="layout__footer">Footer</footer>
</div>`,
    css: `.layout {
  display: grid;
  grid-template-areas:
    "header header"
    "sidebar main"
    "footer footer";
  grid-template-columns: minmax(13rem, 17rem) 1fr;
  grid-template-rows: auto 1fr auto;
  min-block-size: 100dvh;
}

.layout__header { grid-area: header; }
.layout__sidebar { grid-area: sidebar; }
.layout__main { grid-area: main; }
.layout__footer { grid-area: footer; }

.layout__header,
.layout__footer {
  padding: 1rem 1.25rem;
  border-block-end: 1px solid var(--hf-border);
}

.layout__footer {
  border-block-end: 0;
  border-block-start: 1px solid var(--hf-border);
}

.layout__sidebar {
  padding: 1.25rem;
  border-inline-end: 1px solid var(--hf-border);
  background: var(--hf-surface);
}

.layout__main {
  padding: 1.25rem;
}

@media (max-width: 48rem) {
  .layout {
    grid-template-areas:
      "header"
      "main"
      "sidebar"
      "footer";
    grid-template-columns: 1fr;
  }
}
`,
    slot: '.layout__main',
    areas: [
      { name: 'header', x: 0, y: 0, w: 100, h: 16 },
      { name: 'sidebar', x: 0, y: 16, w: 32, h: 68 },
      { name: 'main', x: 32, y: 16, w: 68, h: 68 },
      { name: 'footer', x: 0, y: 84, w: 100, h: 16 },
    ],
  },
];

export function framePreset(id) {
  return FRAME_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Applies a frame preset around a container's current children.
 *
 * The frame and the re-parented content are written in one op because a
 * batch cannot address a node an earlier op created.
 */
export function frameOps({ file, version, targetId, presetId }) {
  const preset = framePreset(presetId);
  if (!preset) throw new Error(`unknown frame preset: ${presetId}`);
  const ops = [{ op: 'frameNode', file, node: targetId, html: preset.html, version }];
  return { ops, css: preset.css, preset };
}

/**
 * Appends the frame stylesheet to a CSS file. Kept separate from `frameOps`
 * because CSS lives in a different file with its own version.
 */
export function frameCssOps({ file, version, presetId }) {
  const preset = framePreset(presetId);
  if (!preset) throw new Error(`unknown frame preset: ${presetId}`);
  return [{ op: 'appendCss', file, version, text: `/* frame: ${preset.id} */\n${preset.css}`, label: `frame css · ${preset.id}` }];
}

/** Prefixes every selector in a CSS block, leaving at-rules intact. */
export function prefixSelectors(css, prefix) {
  const out = [];
  let depth = 0;
  let buffer = '';
  let atRule = '';
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    buffer += ch;
    if (ch === '{') {
      if (depth === 0) {
        const prelude = buffer.slice(0, -1).trim();
        if (prelude.startsWith('@')) {
          atRule = prelude;
          out.push(buffer);
        } else {
          const prefixed = prelude
            .split(',')
            .map((part) => `${prefix} ${part.trim()}`)
            .join(',\n');
          out.push(`${prefixed} {`);
        }
        buffer = '';
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        out.push(buffer);
        buffer = '';
        atRule = '';
      }
    }
  }
  if (buffer) out.push(buffer);
  return out.join('');
}

/**
 * Starter markup per foundation.
 *
 * A foundation is only usable once its required parts exist, and the part
 * structure is not derivable from `parts` metadata alone (`tabs` needs tabs
 * *inside* its list, an accordion needs items). So known foundations get a
 * real snippet; anything else falls back to one element per part.
 */
const FOUNDATION_SNIPPETS = {
  disclosure: `<div data-hf="disclosure">
  <button data-hf-part="trigger">Details</button>
  <div data-hf-part="panel">Panel content.</div>
</div>`,
  tabs: `<div data-hf="tabs">
  <div data-hf-part="list">
    <button data-hf-part="tab">One</button>
    <button data-hf-part="tab">Two</button>
  </div>
  <section data-hf-part="panel">First panel.</section>
  <section data-hf-part="panel">Second panel.</section>
</div>`,
  accordion: `<div data-hf="accordion" data-hf-options='{"type":"single","collapsible":true}'>
  <div data-hf-part="item">
    <h3><button data-hf-part="trigger">Section one</button></h3>
    <div data-hf-part="panel">First section content.</div>
  </div>
  <div data-hf-part="item">
    <h3><button data-hf-part="trigger">Section two</button></h3>
    <div data-hf-part="panel">Second section content.</div>
  </div>
</div>`,
  dialog: `<dialog data-hf="dialog" aria-labelledby="dialog-title">
  <div data-hf-part="content">
    <h2 id="dialog-title">Dialog title</h2>
    <p>Dialog body.</p>
    <button data-hf-part="close">Close</button>
  </div>
</dialog>`,
  popover: `<div data-hf="popover">
  <button data-hf-part="trigger">Open popover</button>
  <div data-hf-part="content">Popover content.</div>
</div>`,
  menu: `<div data-hf="menu">
  <button data-hf-part="trigger">Actions</button>
  <div data-hf-part="list">
    <button data-hf-part="item">Rename</button>
    <button data-hf-part="item">Duplicate</button>
    <button data-hf-part="item">Delete</button>
  </div>
</div>`,
  tooltip: `<div data-hf="tooltip">
  <button data-hf-part="trigger">Hover or focus</button>
  <div data-hf-part="content">Tooltip text.</div>
</div>`,
  toggle: `<div data-hf="toggle">
  <button data-hf-part="control">Toggle</button>
</div>`,
  switch: `<div data-hf="switch">
  <button data-hf-part="control">
    <span data-hf-part="thumb"></span>
    <span>Switch label</span>
  </button>
</div>`,
  'radio-group': `<div data-hf="radio-group">
  <button data-hf-part="radio" data-value="a">A</button>
  <button data-hf-part="radio" data-value="b">B</button>
  <button data-hf-part="radio" data-value="c">C</button>
</div>`,
  listbox: `<div data-hf="listbox">
  <div data-hf-part="option">Option one</div>
  <div data-hf-part="option">Option two</div>
</div>`,
  combobox: `<div data-hf="combobox">
  <input data-hf-part="input" />
  <div data-hf-part="listbox">
    <div data-hf-part="option">Option one</div>
    <div data-hf-part="option">Option two</div>
  </div>
</div>`,
  toast: `<div data-hf="toast">
  <template data-hf-part="template">
    <div data-hf-part="toast">
      <span data-hf-part="message"></span>
    </div>
  </template>
</div>`,
};

/** Snippet for inserting a foundation or user component. */
export function snippetFor(kind, entry) {
  if (kind === 'foundation') {
    if (FOUNDATION_SNIPPETS[entry.name]) return FOUNDATION_SNIPPETS[entry.name];
    const body = Object.keys(entry.parts ?? {})
      .filter((name) => name !== 'template')
      .map((name) => `  <div data-hf-part="${name}"></div>`)
      .join('\n');
    return `<div data-hf="${entry.name}">\n${body}\n</div>`;
  }
  if (kind === 'component') {
    return entry.usage ?? `<${entry.tag}></${entry.tag}>`;
  }
  return '';
}

/* ------------------------------------------------------------ attributes */

/**
 * One attribute edit on a node. `value === null` removes the attribute, which
 * is how a plain HTML element loses an `aria-*` or `tabindex` it should not
 * carry. The studio UI only ever builds these for the selected node.
 */
export function attrOp({ file, version, nodeId, name, value, previous }) {
  if (!name) return [];
  if (value === null || value === undefined) {
    if (previous === undefined) return [];
    return [{ op: 'removeAttr', file, node: nodeId, name, version }];
  }
  if (previous === value) return [];
  return [{ op: 'setAttr', file, node: nodeId, name, value, version }];
}
