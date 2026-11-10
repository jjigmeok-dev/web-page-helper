/**
 * Studio panel: selection, forms, pending ops, diff review, save.
 *
 * State is deliberately small and explicit:
 *   project  - inventory from /__api/project
 *   page     - model from /__api/page (tree, sheets, tokens, matched)
 *   selected - node id from the model
 *   pending  - ops not yet written, tagged with the file they target
 *
 * Every mutation goes into `pending`; nothing touches disk until Save, which
 * runs a dry-run plan first and shows the diff.
 */
import {
  FRAME_PRESETS,
  attrOp,
  duplicateOp,
  frameCssOps,
  frameOps,
  insertOp,
  layoutOps,
  moveOp,
  nodeLabel,
  optionsOp,
  propsOps,
  removeOp,
  snippetFor,
  textOp,
  wrapOp,
} from './ops.js';
import { SEVERITY_LABEL, indexTree, suggestionsFor } from './suggest.js';

const $ = (selector) => document.querySelector(selector);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

/* ------------------------------------------------------------ state */

const state = {
  project: null,
  profile: null,
  page: null,
  selected: null,
  target: null,
  pending: [],
  // Picking is on by default: the studio opens on the page you came to edit.
  picking: true,
  tab: 'node',
  // True once the user chooses a tab by hand for the current selection.
  tabPinned: false,
  nodeIndex: new Map(),
  busy: false,
};

const ui = {
  root: $('#project-root'),
  pageSelect: $('#page-select'),
  preview: $('#preview'),
  previewUrl: $('#preview-url'),
  previewHint: $('#preview-hint'),
  tree: $('#tree'),
  treeStatus: $('#tree-status'),
  status: $('#status'),
  statusbar: $('.statusbar'),
  nodePath: $('#node-path'),
  save: $('#save-btn'),
  undo: $('#undo-btn'),
  discard: $('#discard-btn'),
  pending: $('#pending'),
  pendingCount: $('#pending-count'),
  pendingList: $('#pending-list'),
  pickToggle: $('#pick-toggle'),
  openProject: $('#open-project'),
  pickerDialog: $('#picker-dialog'),
  pickerBody: $('#picker-body'),
  pickerPath: $('#picker-path'),
  pickerUp: $('#picker-up'),
  pickerNote: $('#picker-note'),
  pickerOpen: $('#picker-open'),
  diffDialog: $('#diff-dialog'),
  diffBody: $('#diff-body'),
  diffTitle: $('#diff-title'),
  diffNote: $('#diff-note'),
  confirmSave: $('#confirm-save'),
  panels: {
    node: $('#panel-node'),
    layout: $('#panel-layout'),
    component: $('#panel-component'),
    structure: $('#panel-structure'),
    frames: $('#panel-frames'),
    project: $('#panel-project'),
  },
  tabs: {
    node: $('#tab-node'),
    layout: $('#tab-layout'),
    component: $('#tab-component'),
    structure: $('#tab-structure'),
    frames: $('#tab-frames'),
    project: $('#tab-project'),
  },
};

/* ------------------------------------------------------------ api */

async function api(action, { query, body, method } = {}) {
  const url = new URL(`/__api/${action}`, location.origin);
  // The studio may be served on a network bind, where every request needs the
  // token that was printed with the URL. Keep it in the query string.
  const token = new URLSearchParams(location.search).get('token');
  if (token) url.searchParams.set('token', token);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({ ok: false, code: 'BAD_RESPONSE', message: 'invalid JSON' }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message ?? `request failed (${response.status})`);
    error.code = payload.code;
    error.detail = payload;
    throw error;
  }
  return payload;
}

function setStatus(message, tone) {
  ui.status.textContent = message;
  ui.statusbar.dataset.tone = tone ?? '';
}

function setBusy(value, message) {
  state.busy = value;
  ui.save.disabled = value || state.pending.length === 0;
  ui.undo.disabled = value;
  if (message) setStatus(message);
}

function reportError(error) {
  const detail = error.detail?.problems?.[0]?.message ?? error.detail?.actual;
  setStatus(`${error.code ? `[${error.code}] ` : ''}${error.message}${detail ? ` — ${detail}` : ''}`, 'error');
  console.error(error);
}

/* ------------------------------------------------------------ tree */

function flatten(node, depth = 0, out = []) {
  out.push({ node, depth });
  for (const child of node.children) flatten(child, depth + 1, out);
  return out;
}

function badgeFor(node) {
  const kind = node.component?.kind;
  if (kind === 'foundation') return el('span', { class: 'tree__badge', text: node.component.name });
  if (kind === 'component') return el('span', { class: 'tree__badge tree__badge--component', text: node.component.name });
  if (kind === 'part') return el('span', { class: 'tree__badge tree__badge--part', text: `part:${node.component.name}` });
  return null;
}

function renderTree() {
  const tree = state.page.tree;
  // Rebuilt with the page: part ownership and duplicate-id checks read it.
  state.treeIndex = indexTree(tree);
  state.nodeIndex = new Map();
  const rows = flatten(tree);
  const fragment = document.createDocumentFragment();

  for (const { node, depth } of rows) {
    state.nodeIndex.set(node.id, node);
    const row = el(
      'div',
      {
        class: 'tree__row',
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-selected': node.id === state.selected ? 'true' : 'false',
        tabindex: node.id === state.selected ? '0' : '-1',
        'data-id': node.id,
        title: `line ${node.line}`,
        onclick: () => select(node.id, { scroll: true, fromTree: true }),
      },
      el('span', { class: 'tree__twisty', text: node.children.length ? '▾' : '' }),
      el('span', { class: 'tree__tag', text: node.tag }),
      node.domId ? el('span', { class: 'tree__id', text: `#${node.domId}` }) : null,
      node.classes.length ? el('span', { class: 'tree__class', text: `.${node.classes.join('.')}` }) : null,
      badgeFor(node),
    );
    row.style.paddingInlineStart = `${0.3 + depth * 0.75}rem`;
    fragment.append(row);
  }

  ui.tree.replaceChildren(fragment);
  ui.treeStatus.textContent = `${rows.length - 1} elements · ${state.page.file}`;
}

function scrollTreeTo(id) {
  ui.tree.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------ selection */

function select(id, { scroll = false, fromTree = false, target = null } = {}) {
  // A new element is a new context: let the panel pick its most relevant tab
  // again, unless the user re-pins one by clicking a tab.
  if (id !== state.selected) state.tabPinned = false;
  state.selected = id;
  // What the user actually clicked. Null means the host itself.
  state.target = target;
  try {
    localStorage.setItem('hf-studio:selection', JSON.stringify({ file: state.page?.file ?? null, id }));
  } catch {
    /* storage is optional */
  }
  for (const row of ui.tree.querySelectorAll('.tree__row')) {
    const current = row.dataset.id === id;
    row.setAttribute('aria-selected', String(current));
    // Roving tabindex: only the selected row is in the tab order, and it is
    // also where focus goes, so arrows work immediately after a click.
    row.setAttribute('tabindex', current ? '0' : '-1');
    if (current && fromTree) row.focus({ preventScroll: true });
  }
  const node = state.nodeIndex.get(id);
  ui.nodePath.textContent = node ? `${nodeLabel(node)} · line ${node.line}` : '';
  if (!fromTree) scrollTreeTo(id);
  // A tree click addresses the host itself, so any earlier inner target is stale.
  if (fromTree) state.target = null;
  if (scroll) postToBridge({ type: 'select', id, scroll: true });
  else postToBridge({ type: 'select', id });

  // Tabs follow the selection. Two cases, both needed for "show the settings
  // that apply to what I clicked":
  //  1. the active tab no longer applies -> fall back to the most specific one
  //  2. the user has not pinned a tab for this selection -> open the most
  //     specific one, so clicking a component lands on its options instead of
  //     the generic attribute list.
  const available = syncTabs(node);
  const specific = ['component', 'layout'].find((key) => tabAvailability(node)[key]) ?? 'node';
  const wanted = state.tabPinned ? state.tab : specific;
  const active = resolvedTab(wanted, available);
  if (active !== state.tab) {
    showTab(active);
    return;
  }
  if (state.tab === 'node') renderNodePanel();
  if (state.tab === 'layout') renderLayoutPanel();
  if (state.tab === 'component') renderComponentPanel();
  if (state.tab === 'structure') renderStructurePanel();
}

function postToBridge(message) {
  ui.preview.contentWindow?.postMessage({ source: 'hf-studio', ...message }, '*');
}

/* ------------------------------------------------------------ preview */

function loadPreview() {
  const page = state.page;
  if (!page) return;
  const url = `${page.url}?hf=${Date.now()}`;
  ui.previewUrl.textContent = page.url;
  ui.preview.src = url;
}

/* ------------------------------------------------------------ panels */

/**
 * A `?` next to a title, with the Korean explanation.
 *
 * Uses `title` rather than a custom tooltip so it also works on touch
 * (long-press), keyboard focus, and screen readers. The icon is decorative in
 * the a11y tree only when a text alternative exists, so the button carries the
 * label and the description is duplicated into `aria-label` for SR users.
 */
function help(text) {
  return el('button', {
    type: 'button',
    class: 'help',
    title: text,
    'aria-label': text,
    tabindex: '0',
    text: '?',
  });
}

function group(title, ...children) {
  return el('section', { class: 'group' }, el('h3', { class: 'group__title', text: title }), ...children);
}

/** Same as `group` but with the explanation icon beside the heading. */
function groupHelp(title, helpText, ...children) {
  return el(
    'section',
    { class: 'group' },
    el('h3', { class: 'group__title' }, el('span', { text: title }), help(helpText)),
    ...children,
  );
}

function field(label, input, helpText = null) {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label' }, el('span', { text: label }), helpText ? help(helpText) : null),
    input,
  );
}

function textInput(value, onCommit, attrs = {}) {
  const input = el('input', { type: 'text', value: value ?? '', ...attrs });
  input.addEventListener('change', () => onCommit(input.value));
  return input;
}

function numberInput(value, onCommit, attrs = {}) {
  const input = el('input', { type: 'text', value: value ?? '', inputmode: 'decimal', ...attrs });
  input.addEventListener('change', () => onCommit(input.value));
  return input;
}

function selectInput(value, options, onCommit) {
  const select = el('select');
  for (const option of options) {
    const { value: optionValue, label } = typeof option === 'string' ? { value: option, label: option } : option;
    select.append(el('option', { value: optionValue, text: label, selected: String(optionValue) === String(value ?? '') }));
  }
  select.addEventListener('change', () => onCommit(select.value));
  return select;
}

function checkboxInput(checked, onCommit) {
  const input = el('input', { type: 'checkbox', checked: Boolean(checked) });
  input.addEventListener('change', () => onCommit(input.checked));
  return input;
}

function declsOf(rule) {
  const out = {};
  for (const decl of rule.decls) out[decl.property] = decl.value;
  return out;
}

/** The stylesheet that should receive new declarations for this node. */
/**
 * Picks the stylesheet a layout edit should land in.
 *
 * Order matters: a component's own stylesheet owns its internals, and the
 * page's last non-inline sheet wins the cascade for page markup. Guessing by
 * path alone would write a page rule that the component's sheet overrides.
 */
function styleTarget(node = null) {
  const page = state.page;
  const sheets = page.sheets.filter((sheet) => !sheet.inline && !sheet.error);

  // The clicked element was rendered from a component template: its rules
  // belong to that component's stylesheet, addressed by its class.
  const internal = state.target ? internalOwnerFor(state.target) : null;
  if (internal?.styles) {
    const sheet = sheets.find((entry) => entry.file === internal.styles);
    if (sheet) return { ...sheet, selector: selectorForTarget(state.target) };
  }

  const owner = node ? page.owners?.[node.id] : null;
  const componentSheet = owner?.styles?.find((entry) => entry.kind === 'component');
  if (componentSheet) {
    const sheet = sheets.find((entry) => entry.file === componentSheet.file);
    if (sheet) return sheet;
  }

  const linked = sheets.filter((sheet) => !sheet.component);
  const pick = (linked[linked.length - 1] ?? sheets[0]) ?? null;
  if (pick) return pick;
  // No stylesheet at all: the layout edit must still land somewhere. Creating
  // `style.css` next to the page is the conventional location, and the op
  // marks the file as new so the write is allowed.
  const dir = state.page.file.includes('/') ? `${state.page.file.slice(0, state.page.file.lastIndexOf('/'))}/` : '';
  return { file: `${dir}style.css`, version: null, create: true, inline: false };
}

/** A stable selector for a runtime element inside a component template. */
function selectorForTarget(target) {
  if (!target) return null;
  if (target.classes?.length) return `.${target.classes[target.classes.length - 1]}`;
  return target.tag ?? null;
}

function selectorForNode(node) {
  if (!node) return null;
  if (node.classes.length) return `.${node.classes[node.classes.length - 1]}`;
  if (node.domId) return `#${node.domId}`;
  return node.tag;
}

/* ---- ownership */

/**
 * "Which file do I edit?" — answered per concern, because a headless UI
 * splits one element across markup, behavior and styles.
 */
function renderOwners(node) {
  const owner = state.page.owners?.[node.id];
  if (!owner) return el('p', { class: 'muted', text: 'No ownership information for this node.' });

  const rows = el('dl', { class: 'kv' });

  const markupFile = owner.markup?.file ?? state.page.file;
  const markupLine = owner.markup?.line;
  rows.append(
    el('dt', { text: 'markup' }),
    el('dd', { class: 'mono', text: markupLine ? `${markupFile}:${markupLine}` : markupFile }),
  );

  const behavior = owner.behavior;
  if (behavior) {
    const label = `${behavior.kind} · ${behavior.name}${behavior.part ? ` (${behavior.part})` : ''}`;
    rows.append(el('dt', { text: 'behavior' }), el('dd', { text: label }));
    rows.append(
      el('dt', { text: '' }),
      el('dd', { class: 'mono muted', text: behavior.file ?? 'external — not in this project' }),
    );
  } else {
    rows.append(el('dt', { text: 'behavior' }), el('dd', { class: 'muted', text: 'none (static markup)' }));
  }

  const styles = owner.styles ?? [];
  rows.append(el('dt', { text: 'styles' }), el('dd', { text: styles.length ? `${styles.length} file${styles.length === 1 ? '' : 's'}` : 'none matched' }));
  for (const sheet of styles) {
    rows.append(el('dt', { text: '' }), el('dd', { class: 'mono muted', text: `${sheet.file}${sheet.kind === 'component' ? '  (component)' : ''}` }));
  }

  const children = [rows];

  // The clicked element is not the host: it was rendered from a template.
  if (state.target) {
    const internal = internalOwnerFor(state.target);
    children.push(
      el(
        'p',
        { class: 'muted' },
        el('strong', { text: 'Clicked inside a rendered component. ' }),
        el('span', {
          text: internal?.found
            ? 'Edit the template below — the page file only holds the host element.'
            : 'No matching element in the component template.',
        }),
      ),
    );
    if (internal) {
      children.push(
        el(
          'dl',
          { class: 'kv' },
          el('dt', { text: 'template' }),
          el('dd', { class: 'mono', text: internal.file }),
          el('dt', { text: 'target' }),
          el('dd', { class: 'mono', text: internal.markup ?? '—' }),
          ...(internal.styles
            ? [el('dt', { text: 'styles' }), el('dd', { class: 'mono', text: internal.styles })]
            : []),
        ),
      );
    }
  }

  return el('div', {}, ...children);
}

/**
 * Matches a runtime element against the component templates of the page.
 * The host is the nearest `data-hf-node` ancestor, so the component is looked
 * up from that tag, then the template is scanned for the same tag + classes.
 */
function internalOwnerFor(target) {
  const host = state.nodeIndex.get(state.selected);
  if (!host) return null;
  const component = state.page.components?.find((entry) => entry.tag === host.tag);
  if (!component || !component.template) return null;
  const holder = document.createElement('template');
  holder.innerHTML = component.template.trim();
  const match = [...holder.content.querySelectorAll('*')].find(
    (element) =>
      element.tagName.toLowerCase() === target.tag &&
      target.classes.every((name) => element.classList.contains(name)),
  );
  if (!match) return { file: component.file, styles: component.styles ?? null, found: false, markup: null };
  return {
    file: component.file,
    styles: component.styles ?? null,
    found: true,
    markup: match.outerHTML.replace(/\s+/g, ' ').slice(0, 160),
  };
}

/* ---- node panel */

function renderNodePanel() {
  const panel = ui.panels.node;
  const node = state.nodeIndex.get(state.selected);
  if (!node) {
    panel.replaceChildren(el('p', { class: 'empty', text: 'Select an element in the preview or the tree.' }));
    return;
  }
  const selector = selectorForNode(node);
  const rules = state.page.matched[node.id] ?? [];
  const attrRows = Object.entries(node.attrs);

  const content = [
    group('Owned by', renderOwners(node)),
    group(
      'Element',
      el(
        'dl',
        { class: 'kv' },
        el('dt', { text: 'tag' }),
        el('dd', { text: node.tag }),
        el('dt', { text: 'line' }),
        el('dd', { text: String(node.line) }),
        el('dt', { text: 'selector' }),
        el('dd', { class: 'mono', text: selector ?? '—' }),
        node.component?.kind !== 'plain'
          ? [el('dt', { text: 'component' }), el('dd', { text: `${node.component.kind}: ${node.component.name}` })]
          : null,
      ),
    ),
  ];

  if (!node.children.length && node.tag !== 'script' && node.tag !== 'style') {
    content.push(
      group(
        'Text',
        field(
          'content',
          textInput(node.text, (value) => {
            // `node.text` is a truncated preview, so it cannot be a
            // precondition; the file version already guards concurrent edits.
            pushOps(textOp({ file: state.page.file, version: state.page.version, nodeId: node.id, value }));
          }),
        ),
      ),
    );
  }

  // Attributes are editable: plain HTML projects need this for `aria-*`,
  // `tabindex`, `role`, and data attributes the panels above do not cover.
  const attrList = el('div', { class: 'rule__decls' });
  for (const [name, value] of attrRows) {
    attrList.append(
      el(
        'div',
        { class: 'attr-row' },
        el('span', { class: 'mono', text: name }),
        // Empty stays a value (`alt=""` marks a decorative image); only the
        // ✕ button removes the attribute.
        textInput(String(value), (next) => {
          pushOps(
            attrOp({
              file: state.page.file,
              version: state.page.version,
              nodeId: node.id,
              name,
              value: next,
              previous: String(value),
            }),
          );
        }),
        el('button', {
          type: 'button',
          class: 'attr-remove',
          title: `Remove ${name}`,
          text: '✕',
          onclick: () =>
            pushOps(
              attrOp({
                file: state.page.file,
                version: state.page.version,
                nodeId: node.id,
                name,
                value: null,
                previous: String(value),
              }),
            ),
        }),
      ),
    );
  }
  const newName = el('input', { type: 'text', placeholder: 'new attribute (e.g. role)' });
  const newValue = el('input', { type: 'text', placeholder: 'value' });
  const addAttr = () => {
    const name = newName.value.trim();
    if (!name) {
      setStatus('Enter an attribute name, e.g. role or aria-label', 'error');
      return;
    }
    pushOps(
      attrOp({
        file: state.page.file,
        version: state.page.version,
        nodeId: node.id,
        name,
        value: newValue.value,
        previous: undefined,
      }),
    );
    newName.value = '';
    newValue.value = '';
  };
  attrList.append(
    el(
      'div',
      { class: 'attr-row attr-row--new' },
      newName,
      newValue,
      el('button', { type: 'button', class: 'btn', text: 'Add', onclick: addAttr }),
    ),
  );
  content.push(
    groupHelp(
      `Attributes (${attrRows.length})`,
      'HTML 속성을 직접 편집합니다. role·aria-*·tabindex·data-* 처럼 다른 패널이 다루지 않는 값을 여기서 바꿉니다.',
      attrList,
    ),
  );

  if (rules.length) {
    const list = el('div', { class: 'rule__decls' });
    for (const rule of rules.slice(0, 6)) {
      list.append(
        el('div', {}, el('span', { text: rule.selector }), el('span', { class: 'rule__file', text: ` · ${rule.file}` })),
      );
    }
    content.push(
      groupHelp(`Matching rules (${rules.length})`, '이 요소에 실제로 적용 중인 CSS 규칙입니다. 위에서부터 우선순위가 높습니다.', list),
    );
  }

  content.push(renderSuggestions(node));

  panel.replaceChildren(...content);
}

/* ---- suggestions */

/**
 * What is worth changing about this element.
 *
 * Every suggestion is an op the editor already knows how to apply, so a click
 * lands in the same pending/diff/save path as editing a field by hand. Nothing
 * is written here.
 */
function renderSuggestions(node) {
  const target = (() => {
    const sheet = styleTarget(node);
    if (!sheet?.file) return null;
    return { ...sheet, selector: selectorForNode(node) };
  })();
  const index = state.treeIndex ?? indexTree(state.page.tree);
  const list = suggestionsFor(node, state.page, target, index);

  const body = el('div', { class: 'suggest' });
  if (!list.length) {
    body.append(el('p', { class: 'muted', text: 'Nothing to suggest for this element.' }));
  }
  for (const entry of list) {
    const apply = entry.ops?.length
      ? el('button', {
          type: 'button',
          class: 'btn btn--suggest',
          text: 'Apply',
          title: 'Add these changes to the pending diff',
          onclick: () => {
            // Ops from the engine carry no file/version: the panel owns those,
            // so one suggestion never has to know where the page lives.
            const isCss = (op) => op.op === 'setDecl' || op.op === 'removeDecl';
            const scoped = [];
            for (const op of entry.ops) {
              const file = op.file ?? (isCss(op) ? target?.file : state.page.file);
              // A suggestion is filtered out rather than emitting an op with no
              // target file: the write plan would reject it later anyway.
              if (!file) continue;
              // The wire format addresses nodes as `node`; the engine speaks
              // `nodeId` because that is easier to read in a suggestion.
              scoped.push({
                ...op,
                file,
                version: op.version ?? (isCss(op) ? target?.version : state.page.version),
                node: op.node ?? op.nodeId ?? node.id,
                nodeId: undefined,
              });
            }
            if (scoped.length) pushOps(scoped);
            else setStatus('Nothing to apply: no stylesheet target for this element', 'error');
          },
        })
      : null;

    body.append(
      el(
        'div',
        { class: `suggest__row suggest__row--${entry.severity}` },
        el('span', { class: `suggest__tag suggest__tag--${entry.severity}`, text: SEVERITY_LABEL[entry.severity] }),
        el('div', { class: 'suggest__text' }, el('strong', { text: entry.title }), el('span', { class: 'muted', text: entry.detail })),
        apply,
      ),
    );
  }

  return groupHelp(`Suggestions (${list.length})`, '이 요소에서 고칠 만한 것을 제안합니다. Apply를 누르면 손으로 고친 것과 같은 대기 변경에 들어갑니다.', body);
}

/* ---- layout panel */

const LAYOUT_PROPS = [
  {
    key: 'display',
    label: 'display',
    help: '요소가 화면에 어떻게 배치될지 정합니다. flex는 1차원 정렬, grid는 2차원 배치에 씁니다.',
    options: ['', 'block', 'flex', 'grid', 'inline-flex', 'inline-grid', 'inline', 'inline-block', 'none'],
  },
  {
    key: 'direction',
    property: 'flex-direction',
    label: 'flex-direction',
    help: 'flex 자식이 놓이는 방향입니다. row는 가로, column은 세로입니다.',
    options: ['', 'row', 'row-reverse', 'column', 'column-reverse'],
  },
  { key: 'gap', label: 'gap', help: 'flex·grid 자식 사이의 간격입니다. 예: 16px, 1rem, 8px 16px.' },
  { key: 'padding', label: 'padding', help: '요소 안쪽 여백입니다. 예: 16px, 1rem 2rem.' },
  {
    key: 'alignItems',
    property: 'align-items',
    label: 'align-items',
    help: 'flex·grid에서 자식을 교차축으로 정렬합니다. center면 세로 가운데(column이면 가로 가운데)입니다.',
    options: ['', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  },
  {
    key: 'justifyContent',
    property: 'justify-content',
    label: 'justify-content',
    help: 'flex·grid에서 자식을 주축으로 정렬합니다. space-between은 양 끝에 붙이고 사이를 고르게 벌립니다.',
    options: ['', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  },
  {
    key: 'columns',
    property: 'grid-template-columns',
    label: 'grid-template-columns',
    help: 'grid의 열 구성입니다. 예: repeat(3, 1fr), 200px 1fr.',
  },
];

function renderLayoutPanel() {
  const panel = ui.panels.layout;
  const node = state.nodeIndex.get(state.selected);
  if (!node) {
    panel.replaceChildren(el('p', { class: 'empty', text: 'Select an element to edit its layout.' }));
    return;
  }
  const selector = selectorForNode(node);
  const rules = state.page.matched[node.id] ?? [];
  const target = styleTarget(node);
  const targetSelector = target?.selector ?? selector;
  const ownRule =
    rules.find((rule) => rule.file === target?.file && rule.selector === targetSelector) ??
    (target?.selector ? null : rules[0]);
  const file = ownRule?.file ?? target?.file ?? state.page.file;
  const sheet = state.page.sheets.find((entry) => entry.file === file);
  const ruleSelector = ownRule?.selector ?? targetSelector;
  // Pending edits are the source of truth for what the field shows: without
  // this the control snaps back to the on-disk value after every change.
  const onDisk = ownRule ? declsOf(ownRule) : {};
  const current = { ...onDisk, ...pendingDecls(file, ruleSelector) };

  const apply = (property, value) => {
    // Editing a field back to its on-disk value must cancel the pending op.
    // `layoutOps` alone cannot see that: it compares against the file, not
    // against earlier pending edits in the same session.
    const onDiskValue = onDisk[property] ?? '';
    if (String(value) === String(onDiskValue)) cancelPending(file, ruleSelector, property);
    const ops = layoutOps({
      file,
      version: sheet?.version,
      selector: ruleSelector,
      decls: { [property]: value },
      // `expect` must match the file, not the pending view, or the server
      // rejects a second edit of the same declaration.
      previous: onDisk,
      create: true,
      // The target sheet may not exist yet (page with no <link>).
      createFile: Boolean(target?.create),
    });
    pushOps(ops);
    // No re-render: replacing the panel would detach the control the user is
    // typing in. The field keeps what was typed; `current` tracks it so the
    // next edit in this pass builds the right ops.
    if (value === '') delete current[property];
    else current[property] = value;
  };

  const controls = el('div', { class: 'group__grid' });
  for (const prop of LAYOUT_PROPS) {
    const property = prop.property ?? prop.key;
    const value = current[property] ?? '';
    const input = prop.options
      ? selectInput(value, prop.options.map((option) => ({ value: option, label: option || '—' })), (next) => apply(property, next))
      : numberInput(value, (next) => apply(property, next));
    controls.append(field(prop.label, input, prop.help));
  }

  const ruleList = el('div', { class: 'group' });
  for (const rule of rules) {
    const decls = el('div', { class: 'rule__decls' });
    for (const decl of rule.decls) {
      decls.append(el('div', { text: `${decl.property}: ${decl.value};` }));
    }
    ruleList.append(
      el(
        'div',
        { class: 'rule' },
        el('div', { class: 'rule__head' }, el('span', { text: rule.selector }), el('span', { class: 'rule__file', text: rule.file })),
        rule.atRule ? el('div', { class: 'rule__file', text: rule.atRule }) : null,
        decls,
      ),
    );
  }

  // Empty sections are noise: "Matching rules (0)" and a token list with
  // nothing in it tell the user nothing, so they are not rendered at all.
  const tokenCount = state.page.tokens.reduce((total, entry) => total + entry.tokens.length, 0);
  const sections = [
    groupHelp(
      `Box model · ${selector}`,
      '선택한 요소의 레이아웃 값입니다. 변경은 이 요소를 실제로 꾸미는 CSS 규칙에 기록됩니다.',
      controls,
      el(
        'p',
        { class: 'muted' },
        ownRule
          ? `Editing ${ownRule.selector} in ${file}${ownRule.atRule ? ` (${ownRule.atRule})` : ''}.`
          : `No rule yet; a new ${ruleSelector} block will be added to ${file}.`,
      ),
    ),
  ];
  if (rules.length) {
    sections.push(
      groupHelp(`Matching rules (${rules.length})`, '이 요소에 적용 중인 규칙입니다. 어느 파일의 어느 선택자인지 함께 표시합니다.', ruleList),
    );
  }
  if (tokenCount) {
    sections.push(
      groupHelp(
        'Design tokens',
        '이 페이지의 CSS 변수(커스텀 프로퍼티) 값입니다. 색·간격을 한 곳에서 바꿀 때 씁니다.',
        el(
          'div',
          { class: 'rule__decls' },
          ...state.page.tokens.flatMap((entry) => entry.tokens.map((token) => el('div', { text: `${token.name}: ${token.value}` }))),
        ),
      ),
    );
  }
  panel.replaceChildren(...sections);
}

/* ---- component panel */

function renderComponentPanel() {
  const panel = ui.panels.component;
  const node = state.nodeIndex.get(state.selected);
  const kind = node?.component?.kind;
  if (!node || (kind !== 'foundation' && kind !== 'component')) {
    panel.replaceChildren(el('p', { class: 'empty', text: 'Select a foundation or user component.' }));
    return;
  }

  const sections = [];
  if (kind === 'foundation') {
    const schema = node.component.optionSchema ?? {};
    const current = node.component.options ?? {};
    const next = { ...current };
    const fields = el('div', { class: 'group__grid' });

    for (const [key, fallback] of Object.entries(schema)) {
      const value = current[key] ?? fallback;
      let input;
      if (typeof fallback === 'boolean') {
        input = checkboxInput(value, (checked) => {
          next[key] = checked;
          pushOps(optionsOp({ file: state.page.file, version: state.page.version, nodeId: node.id, options: next, previous: current }));
        });
      } else if (typeof fallback === 'number') {
        input = numberInput(value, (raw) => {
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) next[key] = parsed;
          pushOps(optionsOp({ file: state.page.file, version: state.page.version, nodeId: node.id, options: next, previous: current }));
        });
      } else if (typeof fallback === 'string' && /^(auto|manual|horizontal|vertical|single|multiple)$/.test(fallback)) {
        input = textInput(value, (raw) => {
          next[key] = raw;
          pushOps(optionsOp({ file: state.page.file, version: state.page.version, nodeId: node.id, options: next, previous: current }));
        });
      } else {
        input = textInput(value, (raw) => {
          next[key] = raw;
          pushOps(optionsOp({ file: state.page.file, version: state.page.version, nodeId: node.id, options: next, previous: current }));
        });
      }
      fields.append(field(key, input));
    }

    sections.push(
      group(
        `Foundation · ${node.component.name}`,
        node.component.summary ? el('p', { class: 'muted', text: node.component.summary }) : null,
        fields,
      ),
    );
    if (node.component.options && Object.keys(node.component.options).length) {
      sections.push(
        group(
          'Options attribute',
          el('pre', { class: 'mono muted', text: JSON.stringify(node.component.options, null, 2) }),
        ),
      );
    }
  }

  if (kind === 'component') {
    const props = node.component.propTypes ?? {};
    const defaults = node.component.defaults ?? {};
    const current = node.component.props ?? {};
    const next = { ...current };
    const fields = el('div', { class: 'group__grid' });

    for (const [key, type] of Object.entries(props)) {
      const value = current[key] ?? defaults[key] ?? '';
      const commit = (raw) => {
        next[key] = raw;
        pushOps(
          propsOps({
            file: state.page.file,
            version: state.page.version,
            nodeId: node.id,
            props: next,
            previous: current,
            defaults,
          }),
        );
      };
      const input =
        type === 'boolean'
          ? checkboxInput(Boolean(value), commit)
          : type === 'number'
            ? numberInput(value, (raw) => commit(Number(raw)))
            : textInput(value, commit);
      fields.append(field(`${key} · ${type}`, input));
    }

    sections.push(group(`Component · ${node.component.name}`, fields));
    sections.push(
      group(
        'Usage',
        el('pre', { class: 'mono muted', text: `<${node.tag}${Object.entries(current)
          .map(([key, value]) => ` ${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`)
          .join('')}></${node.tag}>` }),
      ),
    );
  }

  panel.replaceChildren(...sections);
}

/* ---- structure panel */

function renderStructurePanel() {
  const panel = ui.panels.structure;
  const node = state.nodeIndex.get(state.selected);
  const page = state.page;
  const version = page.version;

  const insertOptions = [
    ...page.foundations.map((entry) => ({ kind: 'foundation', entry, label: `foundation · ${entry.name}` })),
    ...page.components.map((entry) => ({ kind: 'component', entry, label: `component · ${entry.name}` })),
  ];

  const snippetSelect = el(
    'select',
    {},
    ...insertOptions.map((option) => el('option', { value: `${option.kind}:${option.entry.name}`, text: option.label })),
  );
  // Projects without a foundation/ or components/ registry have nothing to
  // insert; disable the control rather than offering an empty dropdown.
  snippetSelect.disabled = insertOptions.length === 0;

  const positionSelect = el(
    'select',
    {},
    ...['append', 'prepend', 'before', 'after'].map((position) => el('option', { value: position, text: position })),
  );

  const targetSelect = el(
    'select',
    {},
    ...flatten(page.tree)
      .filter(({ node: entry }) => entry.id !== '0')
      .map(({ node: entry, depth }) => ({
        node: el('option', { value: entry.id, text: `${'· '.repeat(depth)}${nodeLabel(entry)}` }),
      }))
      .map((entry) => entry.node),
  );

  const wrapperInput = el('input', { type: 'text', placeholder: '<section class="wrap">' });

  panel.replaceChildren(
    group(
      'Insert',
      insertOptions.length
        ? null
        : el('p', {
            class: 'empty',
            text: '이 프로젝트에는 foundation/ 이나 components/ 레지스트리가 없어 삽입할 스니펫이 없습니다. Wrap·Duplicate·Delete는 그대로 쓸 수 있습니다.',
          }),
      field('snippet', snippetSelect),
      field('position', positionSelect),
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Insert',
          disabled: insertOptions.length === 0,
          onclick: () => {
            const [kind, name] = snippetSelect.value.split(':');
            const source = kind === 'foundation' ? page.foundations : page.components;
            const entry = source.find((candidate) => candidate.name === name);
            if (!entry) return;
            const html = snippetFor(kind, entry);
            const target = state.selected ?? page.tree.id;
            pushOps(insertOp({ file: page.file, version, nodeId: target, position: positionSelect.value, html }));
          },
        }),
      ),
    ),
    group(
      'Move',
      field('destination', targetSelect),
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Move into',
          disabled: !node,
          onclick: () => {
            if (!node) return;
            pushOps(moveOp({ file: page.file, version, nodeId: node.id, targetId: targetSelect.value, position: 'append' }));
          },
        }),
      ),
    ),
    group(
      'Wrap',
      field('wrapper', wrapperInput),
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Wrap selection',
          disabled: !node,
          onclick: () => {
            if (!node) return;
            const html = wrapperInput.value.trim();
            if (!html) {
              setStatus('Enter a wrapper tag, e.g. <section class="wrap">', 'error');
              return;
            }
            pushOps(wrapOp({ file: page.file, version, nodeId: node.id, html }));
          },
        }),
      ),
    ),
    group(
      'Duplicate',
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: node ? `Duplicate ${nodeLabel(node)}` : 'Duplicate selection',
          disabled: !node,
          onclick: () => {
            if (!node) return;
            pushOps(duplicateOp({ file: page.file, version, nodeId: node.id }));
          },
        }),
      ),
    ),
    group(
      'Delete',
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn btn--danger',
          type: 'button',
          text: node ? `Remove ${nodeLabel(node)}` : 'Remove selection',
          disabled: !node,
          onclick: () => {
            if (!node) return;
            pushOps(removeOp({ file: page.file, version, nodeId: node.id }));
          },
        }),
      ),
    ),
  );
}

/* ---- frames panel */

/* ---- project panel */

/**
 * What the bootstrap collected about this frontend: stack, file counts, design
 * tokens, and — most usefully — which files the editor cannot rewrite and why.
 */
function renderProjectPanel() {
  const panel = ui.panels.project;
  const profile = state.profile;
  if (!profile) {
    panel.replaceChildren(el('p', { class: 'empty', text: 'Scanning the project…' }));
    return;
  }

  const { summary, stack } = profile;
  const stackLabel = [
    profile.kind,
    stack.framework ? stack.framework : null,
    stack.packageManager ? `${stack.packageManager}` : null,
    stack.bundled ? 'bundled sources' : 'no build step',
  ]
    .filter(Boolean)
    .join(' · ');

  const facts = el(
    'dl',
    { class: 'kv' },
    el('dt', { text: 'root' }),
    el('dd', { class: 'mono', text: profile.rootDir }),
    el('dt', { text: 'kind' }),
    el('dd', { text: stackLabel }),
    el('dt', { text: 'pages' }),
    el('dd', { text: `${summary.editablePages}/${summary.pages} editable` }),
    el('dt', { text: 'styles' }),
    el('dd', { text: `${summary.styles} sheets · ${summary.tokens} tokens` }),
    el('dt', { text: 'scripts' }),
    el('dd', { text: `${summary.scripts} files · ${Math.round(summary.bytes / 1024)} KB total` }),
    el('dt', { text: 'components' }),
    el('dd', { text: `${summary.components} user · ${summary.foundations} foundations` }),
  );

  const pageList = el('div', { class: 'rule__decls' });
  for (const page of profile.pages) {
    const line = el('div', {}, el('span', { text: page.file }));
    if (!page.editable) line.append(el('span', { class: 'chip chip--warn', text: 'blocked' }));
    else line.append(el('span', { class: 'rule__file', text: `  ${page.nodes} nodes` }));
    pageList.append(line);
  }

  const sections = [group('Project', facts), group(`Pages (${profile.pages.length})`, pageList)];

  if (profile.styles.length) {
    const list = el('div', { class: 'rule__decls' });
    for (const sheet of profile.styles) {
      const line = el('div', {}, el('span', { text: sheet.file }));
      line.append(
        el('span', {
          class: sheet.editable ? 'rule__file' : 'chip chip--warn',
          text: sheet.editable ? `  ${sheet.rules} rules` : '  blocked',
        }),
      );
      list.append(line);
    }
    sections.push(group(`Stylesheets (${profile.styles.length})`, list));
  }

  if (profile.warnings.length) {
    const list = el('div', { class: 'rule__decls' });
    for (const warning of profile.warnings) {
      list.append(
        el(
          'div',
          {},
          el('span', {
            class: warning.level === 'error' || warning.level === 'warn' ? 'chip chip--warn' : 'chip',
            text: warning.level === 'info' ? 'note' : warning.level,
          }),
          el('span', { text: ` ${warning.file ? `${warning.file}: ` : ''}${warning.message}` }),
        ),
      );
    }
    // Only call them warnings when something is actually wrong; a proxy hint
    // is information, not a defect.
    const problems = profile.warnings.filter((warning) => warning.level !== 'info').length;
    sections.push(group(problems ? `Warnings (${problems})` : 'Notes', list));
  }

  if (profile.externalOrigins.length) {
    sections.push(
      group(
        'External origins',
        el('p', { class: 'muted', text: 'Loaded at runtime; the editor never rewrites these files.' }),
        el('div', { class: 'rule__decls' }, ...profile.externalOrigins.map((entry) => el('div', { text: entry.origin }))),
      ),
    );
  }

  panel.replaceChildren(...sections);
}

function renderFramesPanel() {
  const panel = ui.panels.frames;
  const node = state.nodeIndex.get(state.selected);
  const page = state.page;

  const cards = FRAME_PRESETS.map((preset) =>
    el(
      'div',
      { class: 'rule' },
      el('div', { class: 'rule__head' }, el('span', { text: preset.name })),
      el('p', { class: 'muted', text: preset.description }),
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Apply frame',
          onclick: () => applyFrame(preset),
        }),
      ),
    ),
  );

  // Say what will actually happen, including the case where the file has no
  // <body> yet and the frame has to create the document shell first.
  const all = (node, out = []) => {
    out.push(node);
    node.children.forEach((child) => all(child, out));
    return out;
  };
  const hasBody = all(page.tree).some((node) => node.tag === 'body');
  const hasHtml = all(page.tree).some((node) => node.tag === 'html');
  const target = !hasBody
    ? hasHtml
      ? 'This page has <html> but no <body>: a body is created around the existing content.'
      : 'This file has no document structure: <!doctype>, <html>, <head>, <body> are created around the existing content.'
    : 'Frames wrap everything inside <body>. The current page content is moved into the frame slot.';
  const cssNote = styleTarget(null)
    ? null
    : el('p', { class: 'muted', text: 'No stylesheet linked: style.css is created next to the page to hold the frame CSS.' });

  panel.replaceChildren(
    group('Page frames', el('p', { class: 'muted', text: 'A frame wraps the page in a layout skeleton. Existing content moves into the frame slot.' }), ...cards),
    group('Target', el('p', { class: 'muted', text: target }), cssNote),
  );
}

function applyFrame(preset) {
  const page = state.page;
  // Frames wrap the page body; a selected inner element would nest the whole
  // page inside itself, so always target the body.
  const html = page.tree.children.find((node) => node.tag === 'html') ?? page.tree.children[0];
  const body = html?.children?.find((node) => node.tag === 'body');
  if (!body) {
    // No <body>: the file is a fragment or empty. Build the document shell and
    // put the frame inside it, rather than refusing to style a bare page.
    const { ops } = frameOps({
      file: page.file,
      version: page.version,
      targetId: null,
      presetId: preset.id,
    });
    const styleSheet = styleTarget(null);
    // The document op writes the <link> itself when it is creating the shell.
    pushOps([
      {
        ...ops[0],
        op: 'frameDocument',
        node: undefined,
        title: page.title ?? 'Untitled',
        ...(styleSheet?.create ? { stylesheet: `/${styleSheet.file}` } : {}),
      },
    ]);
    if (styleSheet) {
      pushOps(withCreate(frameCssOps({ file: styleSheet.file, version: styleSheet.version, presetId: preset.id }), styleSheet));
      // An existing document without a <link>: add one in its own op.
      if (!styleSheet.create) pushOps([linkStylesheetOp(page, styleSheet.file)]);
    }
    return;
  }
  // Frames style the body, not the selection, so resolve without a node.
  const styleSheet = styleTarget(null);
  if (!styleSheet) {
    setStatus('No stylesheet to receive frame CSS', 'error');
    return;
  }
  const { ops } = frameOps({ file: page.file, version: page.version, targetId: body.id, presetId: preset.id });
  pushOps(ops);
  pushOps(withCreate(frameCssOps({ file: styleSheet.file, version: styleSheet.version, presetId: preset.id }), styleSheet));
  // A stylesheet that does not exist yet is not referenced by the page; without
  // a <link> the frame CSS would be written but never applied.
  if (styleSheet.create) pushOps([linkStylesheetOp(page, styleSheet.file)]);
}

/** `<link rel=stylesheet>` for a sheet the editor just created. */
function linkStylesheetOp(page, file) {
  // The editor serves from the project root, so a root-relative href is right
  // for both `index.html` and `pages/index.html`.
  return {
    op: 'appendToHead',
    file: page.file,
    version: page.version,
    html: `<link rel="stylesheet" href="/${file}">`,
  };
}

/**
 * Marks ops as allowed to create their stylesheet. `styleTarget` returns a
 * synthetic `{create:true}` entry when the page links no sheet; without this
 * the write is refused as a missing file.
 */
function withCreate(ops, sheet) {
  if (!sheet?.create) return ops;
  return ops.map((op) => ({ ...op, createFile: true }));
}

/* ------------------------------------------------------------ pending ops */

function describeOp(op) {
  if (op.label) return op.label;
  switch (op.op) {
    case 'setDecl':
      return `${op.selector} { ${op.property}: ${op.value} }`;
    case 'removeDecl':
      return `${op.selector} { -${op.property} }`;
    case 'setAttr':
      return `${op.name} on node ${op.node}`;
    case 'removeAttr':
      return `-${op.name} on node ${op.node}`;
    case 'setText':
      return `text of node ${op.node}`;
    case 'insertNode':
      return `insert into ${op.node} (${op.position})`;
    case 'removeNode':
      return `remove node ${op.node}`;
    case 'moveNode':
      return `move ${op.node} → ${op.target}`;
    case 'wrapNode':
      return `wrap node ${op.node}`;
    case 'duplicateNode':
      return `duplicate node ${op.node}`;
    case 'frameNode':
      return `frame node ${op.node}`;
    case 'appendCss':
      return `append css to ${op.file}`;
    default:
      return op.op;
  }
}

/**
 * Identity of an op for coalescing: two edits of the same declaration, the
 * same attribute, or the same node's text are one pending change, not two.
 * Structural ops (insert/move/wrap/remove) are never coalesced.
 */
function opKey(op) {
  switch (op.op) {
    case 'setDecl':
    case 'removeDecl':
      return `${op.op}|${op.file}|${op.selector}|${op.property}`;
    case 'setAttr':
    case 'removeAttr':
      return `attr|${op.file}|${op.node}|${op.name}`;
    case 'setText':
      return `text|${op.file}|${op.node}`;
    case 'appendCss':
      return `css|${op.file}`;
    default:
      return null;
  }
}

function pushOps(ops) {
  if (!ops || !ops.length) {
    setStatus('No change');
    return;
  }
  for (const op of ops) {
    const key = opKey(op);
    const existing = key ? state.pending.findIndex((candidate) => opKey(candidate) === key) : -1;
    if (existing !== -1) state.pending[existing] = op;
    else state.pending.push(op);
  }
  renderPending();
  setStatus(`${state.pending.length} pending change${state.pending.length === 1 ? '' : 's'}`);
}

/** Drops pending edits for one declaration, e.g. when the field returns to disk value. */
function cancelPending(file, selector, property) {
  const before = state.pending.length;
  state.pending = state.pending.filter(
    (op) =>
      !(
        op.file === file &&
        op.selector === selector &&
        (op.property === property) &&
        (op.op === 'setDecl' || op.op === 'removeDecl')
      ),
  );
  if (state.pending.length !== before) {
    renderPending();
    setStatus('No change');
  }
}

/** Declarations the pending ops would write for one rule. */
function pendingDecls(file, selector) {
  const out = {};
  for (const op of state.pending) {
    if (op.file !== file || op.selector !== selector) continue;
    if (op.op === 'setDecl') out[op.property] = op.value;
    if (op.op === 'removeDecl') out[op.property] = undefined;
  }
  return out;
}

function renderPending() {
  const count = state.pending.length;
  ui.pending.hidden = count === 0;
  ui.pendingCount.textContent = `${count} pending change${count === 1 ? '' : 's'}`;
  ui.save.disabled = count === 0 || state.busy;
  ui.discard.disabled = count === 0;

  const items = state.pending.map((op, index) =>
    el(
      'li',
      {},
      el('span', { text: describeOp(op) }),
      el('button', {
        type: 'button',
        text: '✕',
        title: 'Remove this change',
        onclick: () => {
          state.pending.splice(index, 1);
          renderPending();
        },
      }),
    ),
  );
  ui.pendingList.replaceChildren(...items);
  // Mirror the pending set into the preview so edits show up immediately.
  // The file is untouched until Save.
  postToBridge({ type: 'live', ...liveChanges() });
}

/**
 * Pending ops expressed against the live document: stylesheet text for
 * declarations, attribute writes, and text replacements. Rules from the
 * scanned sheets are reproduced in source order so specificity stays correct.
 */
function liveChanges() {
  const decls = [];
  for (const op of state.pending) {
    if (op.op === 'setDecl') {
      decls.push({ file: op.file, selector: op.selector, property: op.property, value: op.value });
    } else if (op.op === 'removeDecl') {
      decls.push({ file: op.file, selector: op.selector, property: op.property, value: null });
    }
  }

  const attrs = [];
  const texts = [];
  for (const op of state.pending) {
    if (op.op === 'setAttr' || op.op === 'removeAttr') {
      attrs.push({ id: op.node, name: op.name, value: op.op === 'removeAttr' ? null : op.value });
    } else if (op.op === 'setText') {
      texts.push({ id: op.node, value: op.value });
    }
  }
  return { decls, attrs, texts };
}

/* ------------------------------------------------------------ save */

async function reviewAndSave() {
  if (!state.pending.length || state.busy) return;
  setBusy(true, 'Planning…');
  try {
    const plan = await api('plan', { body: { ops: state.pending } });
    const changed = plan.files.filter((file) => file.changed);
    if (!changed.length) {
      setStatus('Nothing to write: the page already matches');
      setBusy(false);
      state.pending = [];
      renderPending();
      return;
    }
    ui.diffTitle.textContent = `Review ${changed.length} file${changed.length === 1 ? '' : 's'}`;
    ui.diffBody.replaceChildren(
      ...changed.flatMap((file) => [
        el('div', { class: 'diff__file', text: `${file.file} · ${file.version.slice(0, 8)} → ${file.nextVersion.slice(0, 8)}` }),
        ...file.diff.map((line) => {
          if (line.type === 'gap') return el('div', { class: 'diff__gap', text: '⋯' });
          const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
          return el(
            'div',
            { class: `diff__line diff__line--${line.type}` },
            el('span', { text: line.aLine ?? '' }),
            el('span', { text: line.bLine ?? '' }),
            el('span', { text: sign }),
            el('span', { text: line.line }),
          );
        }),
      ]),
    );
    ui.diffNote.textContent = `${state.pending.length} change${state.pending.length === 1 ? '' : 's'} · ${changed.map((file) => file.file).join(', ')}`;
    ui.diffDialog.showModal();
    setStatus('Review the diff, then write');
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function commitSave() {
  ui.diffDialog.close();
  setBusy(true, 'Writing…');
  try {
    const result = await api('apply', { body: { ops: state.pending, label: 'studio edit' } });
    state.pending = [];
    renderPending();
    await reloadPage({ keepSelection: true, status: `Saved ${result.written.join(', ')}`, tone: 'ok' });
  } catch (error) {
    reportError(error);
    setStatus(`${error.message} — nothing was written`, 'error');
  } finally {
    setBusy(false);
  }
}

async function undoLast() {
  if (state.busy) return;
  setBusy(true, 'Undoing…');
  try {
    const result = await api('undo', { body: {} });
    await reloadPage({
      keepSelection: true,
      status: `Undid "${result.label}" — restored ${result.restored.join(', ')}`,
      tone: 'ok',
    });
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------ page load */

async function loadProject() {
  const project = await api('project');
  state.project = project;
  // The profile is a second, slower scan (every page and stylesheet is
  // re-read). Load the editor first, then fill the Project tab when it lands.
  api('profile')
    .then((profile) => {
      state.profile = profile;
      if (state.tab === 'project') renderProjectPanel();
    })
    .catch(() => {
      state.profile = null;
    });
  ui.root.textContent = project.root;
  ui.pageSelect.replaceChildren(
    ...project.pages.map((page) => el('option', { value: page.file, text: page.title || page.file })),
  );
  if (!project.pages.length) {
    setStatus('No HTML pages found in this project', 'error');
    return;
  }
}

async function loadPage(file, { keepSelection = false, status = null, tone = '' } = {}) {
  const page = await api('page', { query: { file } });
  state.page = page;
  if (!keepSelection) state.selected = null;
  state.pending = [];
  renderPending();
  renderTree();
  loadPreview();
  if (state.selected && state.nodeIndex.has(state.selected)) select(state.selected, { fromTree: true });
  else {
    state.selected = null;
    renderNodePanel();
  }
  setStatus(status ?? `${page.file} · ${page.tree.children.length} top-level nodes`, tone);
}

async function reloadPage({ keepSelection = true, status = null, tone = '' } = {}) {
  const file = state.page?.file ?? ui.pageSelect.value;
  try {
    await loadPage(file, { keepSelection, status, tone });
  } catch (error) {
    reportError(error);
  }
}

/* ------------------------------------------------------------ tabs */

/**
 * Tabs that can do something for this node.
 *
 * `layout` is meaningless for elements with no box (`<script>`, `<title>`), and
 * `component` is meaningless unless the element really is a foundation or a
 * user component. Hiding them is the point of this function: the inspector
 * should only offer settings that apply to what the user clicked.
 */
const NON_RENDERED_TAGS = new Set([
  '#document',
  'script',
  'style',
  'title',
  'meta',
  'link',
  'base',
  'head',
  'noscript',
  'template',
]);

function tabAvailability(node) {
  const tag = node?.tag;
  const isComponent = node?.component?.kind === 'foundation' || node?.component?.kind === 'component';
  return {
    node: true,
    // No selection still shows the prompt to select something.
    layout: Boolean(node && tag && !NON_RENDERED_TAGS.has(tag)),
    component: Boolean(isComponent),
    structure: true,
    frames: true,
    project: true,
  };
}

/**
 * Hides the tabs that do not apply to this node. Purely presentational: it
 * never switches the active tab, so callers stay in control of what renders.
 */
function syncTabs(node) {
  const available = tabAvailability(node);
  for (const [key, tab] of Object.entries(ui.tabs)) {
    const usable = available[key] !== false;
    tab.hidden = !usable;
    tab.disabled = !usable;
    if (usable) tab.removeAttribute('aria-hidden');
    else tab.setAttribute('aria-hidden', 'true');
  }
  return available;
}

/**
 * Falls back to the most specific tab that still applies: a component's
 * options beat the generic box model, which beats the raw attribute list.
 */
function resolvedTab(name, available) {
  if (available[name] !== false) return name;
  return ['component', 'layout', 'node'].find((key) => available[key] !== false) ?? 'node';
}

function showTab(requested) {
  const available = syncTabs(state.nodeIndex.get(state.selected));
  const name = resolvedTab(requested, available);
  state.tab = name;
  for (const [key, tab] of Object.entries(ui.tabs)) {
    const selected = key === name;
    tab.setAttribute('aria-selected', String(selected));
    // Hidden tabs are out of the tab order entirely; only the selected one of
    // the visible set is focusable (roving tabindex).
    tab.tabIndex = selected ? 0 : -1;
    tab.disabled = tab.hidden;
    ui.panels[key].hidden = !selected;
  }
  if (name === 'node') renderNodePanel();
  if (name === 'layout') renderLayoutPanel();
  if (name === 'component') renderComponentPanel();
  if (name === 'structure') renderStructurePanel();
  if (name === 'frames') renderFramesPanel();
  if (name === 'project') renderProjectPanel();
}

for (const [name, tab] of Object.entries(ui.tabs)) {
  tab.addEventListener('click', (event) => {
    // The ? icon sits inside the tab button. Toggling a tab because the user
    // asked what it does is a surprise; only the label switches.
    if (event.target.closest('.help')) return;
    // An explicit choice sticks for this selection; auto-selection would
    // otherwise yank the user off the panel they just opened.
    state.tabPinned = true;
    showTab(name);
  });
  tab.addEventListener('keydown', (event) => {
    const names = Object.keys(ui.tabs);
    const index = names.indexOf(name);
    // Only visible tabs are reachable; hidden ones are not in the tab order.
    const visible = names.filter((key) => !ui.tabs[key].hidden);
    const position = visible.indexOf(name);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = visible[(position + 1) % visible.length];
      if (next) {
        showTab(next);
        ui.tabs[next].focus();
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = visible[(position - 1 + visible.length) % visible.length];
      if (next) {
        showTab(next);
        ui.tabs[next].focus();
      }
    }
  });
}

/* ------------------------------------------------------------ bridge messages */

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== 'hf-bridge') return;
  // The bridge echoes our own `select` back; re-selecting would rebuild the
  // panel and detach the control the user is editing.
  if (data.type === 'selected' && data.id) {
    // The target is the element under the cursor; when it is not the host,
    // the user clicked inside a component's own template.
    const target = data.target ?? null;
    const sameId = data.id === state.selected;
    if (!sameId) {
      select(data.id, { fromTree: false, target });
    } else {
      // Clicking a different child of the already-selected host must still
      // update the ownership view — the node id is identical either way.
      const changed = JSON.stringify(target) !== JSON.stringify(state.target);
      state.target = target;
      if (changed) {
        if (state.tab === 'node') renderNodePanel();
        if (state.tab === 'layout') renderLayoutPanel();
      }
    }
  }
  if (data.type === 'ready') {
    postToBridge({ type: 'picking', value: state.picking });
    // A reloaded frame starts clean; replay the pending set so the preview
    // still reflects edits that have not been saved yet.
    postToBridge({ type: 'live', ...liveChanges() });
    if (state.selected) postToBridge({ type: 'select', id: state.selected });
  }
});

ui.pickToggle.addEventListener('change', () => {
  state.picking = ui.pickToggle.checked;
  postToBridge({ type: 'picking', value: state.picking });
  ui.previewHint.textContent = state.picking ? 'click an element to select it' : '';
});

ui.pageSelect.addEventListener('change', () => {
  loadPage(ui.pageSelect.value).catch(reportError);
});

$('#reload-page').addEventListener('click', () => reloadPage({ keepSelection: true }));
ui.save.addEventListener('click', reviewAndSave);
ui.undo.addEventListener('click', undoLast);
function discardPending() {
  state.pending = [];
  renderPending();
  // Fields show the pending value; drop it and repaint from disk.
  if (state.tab === 'layout') renderLayoutPanel();
  if (state.tab === 'node') renderNodePanel();
  if (state.tab === 'component') renderComponentPanel();
  setStatus('Discarded pending changes');
}

ui.discard.addEventListener('click', discardPending);
ui.confirmSave.addEventListener('click', (event) => {
  event.preventDefault();
  commitSave();
});

/* ------------------------------------------------------------ keyboard */

document.addEventListener('keydown', (event) => {
  // `event.target` is the focused element; a document-level dispatch has no
  // `closest`, so guard the lookup.
  const inField = event.target?.closest?.('input, select, textarea');
  if (event.key === 'Escape' && !ui.diffDialog.open && !inField) {
    if (state.pending.length) discardPending();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (state.pending.length) reviewAndSave();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !inField) {
    event.preventDefault();
    if (state.pending.length) discardPending();
    else undoLast();
    return;
  }
  if (inField) return;

  const rows = [...ui.tree.querySelectorAll('.tree__row')];
  if (!rows.length) return;
  const index = rows.findIndex((row) => row.dataset.id === state.selected);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    // The listener sits on the tree, so it fires for rows too; ignore keys
    // typed into a control that happens to be inside the tree.
    if (!ui.tree.contains(document.activeElement)) return;
    if (event.target.closest('input, textarea, select')) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, index + 1)
            : Math.max(0, index - 1);
    const id = rows[nextIndex]?.dataset.id;
    if (id) select(id, { scroll: true, fromTree: true });
  }
});

/* ------------------------------------------------------- project picker */

/**
 * Browse the local filesystem for a project folder.
 *
 * The server confines browsing to its browse root, so this UI never has to
 * decide what is allowed - it renders what it is given. Folders that contain
 * at least one `.html` file are the ones worth opening; the rest are shown but
 * cannot be opened, which tells the user why instead of failing after a click.
 */
const picker = { dir: null, openable: false, roots: [] };

function closePicker() {
  if (ui.pickerDialog.open) ui.pickerDialog.close();
}

/**
 * Roots are shown as shortcuts above the listing: home and the current
 * project. Without them, getting from `~` to a checkout in `/srv` means
 * clicking Up a dozen times or typing a path, and there is no path input.
 */
function renderPickerRoots(roots) {
  picker.roots = roots;
  const bar = el('div', { class: 'picker__roots' });
  for (const root of roots) {
    bar.append(
      el('button', {
        type: 'button',
        class: 'picker__root',
        title: root.path,
        text: root.label,
        onclick: () => browseTo(root.path),
      }),
    );
  }
  return roots.length > 1 ? bar : null;
}

async function browseTo(dir) {
  ui.pickerBody.replaceChildren(el('p', { class: 'picker__empty', text: 'Reading folder…' }));
  try {
    // `base` lets the server resolve a relative path against the folder the
    // picker is showing rather than against its first root.
    const listing = await api('browse', { query: dir ? { dir, base: picker.dir ?? '' } : {} });
    picker.dir = listing.path;
    picker.openable = listing.openable;
    ui.pickerPath.textContent = listing.path;
    ui.pickerPath.title = listing.path;
    ui.pickerUp.disabled = !listing.parent;
    ui.pickerOpen.disabled = !listing.openable;
    ui.pickerNote.textContent = listing.openable
      ? `${listing.pages.length} page${listing.pages.length === 1 ? '' : 's'} found`
      : 'no .html files here — pick a folder that contains a page';

    const rows = [];
    const rootBar = renderPickerRoots(listing.roots ?? []);
    if (rootBar) rows.push(rootBar);
    for (const child of listing.dirs) {
      rows.push(
        el(
          'button',
          {
            type: 'button',
            class: 'picker__row',
            onclick: () => browseTo(child.path),
          },
          el('span', { class: 'picker__icon', text: '▸' }),
          el('span', { text: child.name }),
        ),
      );
    }
    if (rows.length === (rootBar ? 1 : 0)) rows.push(el('p', { class: 'picker__empty', text: 'no subfolders' }));
    ui.pickerBody.replaceChildren(...rows);
  } catch (error) {
    ui.pickerBody.replaceChildren(el('p', { class: 'picker__empty', text: error.message }));
    ui.pickerNote.textContent = '';
    ui.pickerOpen.disabled = true;
    ui.pickerUp.disabled = true;
  }
}

async function openPicker() {
  ui.pickerDialog.showModal();
  // Start at the server's first browse root (home by default). The root
  // shortcuts above the listing jump to the project in one click.
  await browseTo(null);
}

/**
 * Switches the server's project root, then rebuilds the whole studio against
 * the new project: a page id, a selection, or a pending edit from the old
 * project would otherwise be applied to the new one.
 */
async function switchProject(dir) {
  closePicker();
  setBusy(true, 'Opening project…');
  try {
    const project = await api('open', { body: { dir } });
    state.project = project;
    state.profile = null;
    state.page = null;
    state.selected = null;
    state.pending = [];
    state.nodeIndex = new Map();
    state.treeIndex = new Map();
    renderPending();
    localStorage.removeItem('hf-studio:selection');
    ui.root.textContent = project.root;
    ui.pageSelect.replaceChildren(
      ...project.pages.map((page) => el('option', { value: page.file, text: page.title || page.file })),
    );
    if (!project.pages.length) {
      setStatus('No HTML pages found in this project', 'error');
      return;
    }
    ui.pageSelect.value = project.pages[0].file;
    await loadPage(project.pages[0].file, { keepSelection: false });
    const history = await api('history');
    ui.undo.disabled = history.snapshots.length === 0;
    if (state.tab === 'project') renderProjectPanel();
    setStatus(`Opened ${project.root}`, 'ok');
    api('profile')
      .then((profile) => {
        state.profile = profile;
        if (state.tab === 'project') renderProjectPanel();
      })
      .catch(() => {
        state.profile = null;
      });
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

ui.openProject.addEventListener('click', openPicker);
ui.pickerUp.addEventListener('click', async () => {
  // `parent` is null at the root containing the current path; disabled there.
  try {
    const listing = await api('browse', { query: picker.dir ? { dir: picker.dir, base: picker.dir } : {} });
    if (listing.parent) await browseTo(listing.parent);
  } catch (error) {
    reportError(error);
  }
});
ui.pickerOpen.addEventListener('click', () => {
  if (!picker.dir || !picker.openable) return;
  // Pending edits only exist in memory: switching projects drops them, so ask.
  if (state.pending.length && !confirm(`Discard ${state.pending.length} unsaved change(s) and open another project?`)) {
    return;
  }
  switchProject(picker.dir);
});

/* ------------------------------------------------------------ boot */

(async () => {
  try {
    await loadProject();
    showTab('node');
    // Restore the last page and selection; ids are structural, so a stale id
    // simply fails the lookup and the panel shows the empty state.
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('hf-studio:selection') ?? 'null');
    } catch {
      saved = null;
    }
    const first = state.project.pages.find((page) => page.file === saved?.file) ?? state.project.pages[0];
    if (first) {
      ui.pageSelect.value = first.file;
      await loadPage(first.file, { keepSelection: false });
      if (saved?.file === first.file && saved.id && state.nodeIndex.has(saved.id)) {
        select(saved.id, { fromTree: true });
      }
    }
    const history = await api('history');
    ui.undo.disabled = history.snapshots.length === 0;
  } catch (error) {
    reportError(error);
    setStatus(`Failed to start studio: ${error.message}`, 'error');
  }
})();
