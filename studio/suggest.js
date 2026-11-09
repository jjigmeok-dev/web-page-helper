/**
 * Suggestions for the selected element.
 *
 * The studio can already *edit* whatever the user points at. This module adds
 * the missing half: what is worth changing. Every suggestion is a plain object
 * that names an op the editor already supports, so applying one is exactly the
 * same pending-op path as editing a field by hand.
 *
 * Two families:
 *
 * - `diagnose` finds problems in the current state (missing contract parts,
 *   missing `alt`, duplicate ids, unlinked stylesheets).
 * - `recommend` proposes shape/size/colour/logic values for an element that is
 *   not broken, derived from the design tokens the page actually defines.
 *
 * Everything here is pure: the model in, suggestions out. No DOM, no I/O.
 */

const EMPTY = new Set(['', null, undefined]);

/**
 * The serialized tree has no parent pointers and no `parts` array: both are
 * derivable, and storing them twice would let them drift. Build the index once
 * per render.
 *
 * @returns {{byId: Map, parentOf: Map, partsOf: Map, all: Array}}
 */
export function indexTree(root) {
  const byId = new Map();
  const parentOf = new Map();
  const partsOf = new Map();
  const all = [];
  const walk = (node, parent) => {
    all.push(node);
    byId.set(node.id, node);
    parentOf.set(node.id, parent);
    // A part belongs to the nearest ancestor with [data-hf].
    if (node.component?.kind === 'part') {
      // `owns()` in the runtime treats any [data-hf] as the boundary, and a
      // part is not one. So `tab` inside `list` still belongs to `tabs`:
      // walk to the nearest foundation/component, skipping other parts.
      let owner = parent;
      while (owner && owner.component?.kind !== 'foundation' && owner.component?.kind !== 'component') {
        owner = parentOf.get(owner.id);
      }
      partsOf.set(node.id, owner?.id ?? null);
    }
    node.children.forEach((child) => walk(child, node));
  };
  walk(root, null);
  return { byId, parentOf, partsOf, all };
}

/** Every [data-hf-part] owned by `node`, at any depth. */
function partsOf(node, index) {
  const out = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (child.component?.kind === 'part' && index.partsOf.get(child.id) === node.id) {
        out.push({ name: child.component.name, tag: child.tag, id: child.id, node: child });
      }
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Which attribute carries the accessible name for a given tag. */
const NAME_ATTR = {
  img: 'alt',
  input: 'aria-label',
  textarea: 'aria-label',
  select: 'aria-label',
};

/**
 * Elements where a missing accessible name is a real defect, with the attribute
 * that would fix it and a sensible default value.
 */
const NEEDS_NAME = new Set(['img', 'button', 'a', 'input', 'textarea', 'select']);

const HEADING = /^h([1-6])$/;

/** Landmark-ish tags that should not be empty. */
const CONTAINERS = new Set(['section', 'nav', 'aside', 'header', 'footer', 'main', 'form', 'ul', 'ol', 'dl']);

const SHAPE_PROPS = ['display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'grid-template-columns'];

/* -------------------------------------------------------------- helpers */

const declsOf = (rule) => Object.fromEntries(rule.decls.map((decl) => [decl.property, decl.value]));

/** The decls that actually win for this node, in file order. */
function effectiveDecls(rules) {
  const out = {};
  for (const rule of rules) Object.assign(out, declsOf(rule));
  return out;
}

/** Design tokens defined anywhere the node matches (`--hf-accent`, `--hf-radius`). */
function tokensFrom(rules) {
  const out = {};
  for (const rule of rules) {
    for (const decl of rule.decls) {
      if (!decl.property.startsWith('--')) continue;
      out[decl.property] = decl.value;
    }
  }
  return out;
}

/** `var(--hf-accent)` when the token exists, otherwise the literal fallback. */
function token(tokens, name, fallback) {
  return tokens[name] !== undefined ? `var(${name})` : fallback;
}

function textOf(node) {
  return (node.text ?? '').trim();
}

function hasName(node) {
  const attrs = node.attrs ?? {};
  if (attrs['aria-label'] && String(attrs['aria-label']).trim()) return true;
  if (attrs['aria-labelledby'] && String(attrs['aria-labelledby']).trim()) return true;
  if (NAME_ATTR[node.tag] === 'alt' && 'alt' in attrs) return true;
  // An element whose text content names it.
  if (textOf(node)) return true;
  return false;
}

function suggestion({ id, kind, title, detail, ops, severity = 'info' }) {
  return { id, kind, title, detail, ops, severity };
}

/* ------------------------------------------------------------ diagnosis */

/**
 * Foundation contract: `meta.parts` declares what a foundation needs, but the
 * studio never checked it. A disclosure without a `panel` part mounts and then
 * throws inside the runtime, which the panel could not surface.
 */
function foundationSuggestions(node, model, index) {
  const component = node.component;
  if (component?.kind !== 'foundation') return [];
  const meta = (model.foundations ?? []).find((entry) => entry.name === component.name);
  const parts = meta?.parts ?? {};
  // Only `required` is a defect when absent: `parts` also lists optional slots
  // (a menu separator, a switch thumb) that mount() is happy without.
  const required = new Set(meta?.required ?? []);
  const mine = partsOf(node, index);
  const present = new Set(mine.map((part) => part.name));
  const out = [];

  for (const name of required) {
    if (present.has(name)) continue;
    const expected = parts[name] ?? 'any';
    out.push(
      suggestion({
        id: `foundation:${component.name}:part:${name}`,
        kind: 'contract',
        severity: 'error',
        title: `Add the missing "${name}" part`,
        // `any` is the explicit "no tag requirement" marker in every meta.
        detail:
          expected === 'any'
            ? `${component.name} needs a [data-hf-part="${name}"] element and will fail to mount without it.`
            : `${component.name} needs [data-hf-part="${name}"] on a <${expected}> element and will fail to mount without it.`,
        ops: [
          {
            op: 'insertNode',
            nodeId: node.id,
            position: 'append',
            html: expected === 'any'
              ? `<div data-hf-part="${name}"></div>`
              : `<${expected} data-hf-part="${name}"></${expected}>`,
          },
        ],
      }),
    );
  }

  for (const part of mine) {
    if (parts[part.name] !== undefined) continue;
    out.push(
      suggestion({
        id: `foundation:${component.name}:unknown:${part.name}`,
        kind: 'contract',
        severity: 'warn',
        title: `Unknown part "${part.name}"`,
        detail: `${component.name} does not read a "${part.name}" part. Known parts: ${Object.keys(parts).join(', ') || 'none'}.`,
        ops: [],
      }),
    );
  }

  // Tag contract: `button` vs `a` in tabs is a real difference (roving focus
  // and Enter behave differently), so check the ones present. `parts` values
  // are either `any` or a `a|b` union, never a single required tag.
  for (const [name, expected] of Object.entries(parts)) {
    if (expected === 'any') continue;
    const allowed = String(expected).split('|').map((tag) => tag.trim());
    const part = mine.find((entry) => entry.name === name);
    if (!part || allowed.includes(part.tag)) continue;
    out.push(
      suggestion({
        id: `foundation:${component.name}:tag:${name}`,
        kind: 'contract',
        severity: 'warn',
        title: `"${name}" should be a <${expected}>`,
        detail: `The part is currently a <${part.tag}>. Keyboard and click behaviour assume <${expected}>.`,
        ops: [],
      }),
    );
  }

  return out;
}

/** Accessibility basics that do not need a full a11y engine. */
function a11ySuggestions(node, index) {
  const attrs = node.attrs ?? {};
  const out = [];

  if (node.tag === 'img' && !('alt' in attrs)) {
    out.push(
      suggestion({
        id: 'a11y:img:alt',
        kind: 'a11y',
        severity: 'error',
        title: 'Add alt text',
        detail: 'A screen reader announces the file name without an alt attribute. Use alt="" for a decorative image.',
        ops: [{ op: 'setAttr', nodeId: node.id, name: 'alt', value: '' }],
      }),
    );
  }

  if (node.tag === 'a' && !('href' in attrs)) {
    out.push(
      suggestion({
        id: 'a11y:a:href',
        kind: 'a11y',
        severity: 'error',
        title: 'Add href',
        detail: 'An <a> without href is not focusable and not announced as a link.',
        ops: [{ op: 'setAttr', nodeId: node.id, name: 'href', value: '#' }],
      }),
    );
  }

  if (NEEDS_NAME.has(node.tag) && !hasName(node)) {
    const name = NAME_ATTR[node.tag] ?? 'aria-label';
    out.push(
      suggestion({
        id: `a11y:${node.tag}:name`,
        kind: 'a11y',
        severity: 'error',
        title: 'Add an accessible name',
        detail: `This <${node.tag}> has no text, label, or aria-label, so it is announced as "${node.tag}".`,
        ops: [{ op: 'setAttr', nodeId: node.id, name, value: node.tag === 'input' ? 'Field' : 'Action' }],
      }),
    );
  }

  const level = HEADING.exec(node.tag)?.[1];
  if (level) {
    const parent = index.parentOf.get(node.id);
    const parentLevel = parent ? HEADING.exec(parent.tag)?.[1] : null;
    if (parentLevel && Number(level) > Number(parentLevel) + 1) {
      out.push(
        suggestion({
          id: 'a11y:heading:skip',
          kind: 'a11y',
          severity: 'warn',
          title: `Heading level skips h${Number(parentLevel) + 1}`,
          detail: `<h${level}> directly under <h${parentLevel}> breaks the document outline. Screen reader users navigate by level.`,
          ops: [],
        }),
      );
    }
  }

  return out;
}

/** Structural hygiene: duplicate ids and empty containers. */
function structureSuggestions(node, model, index) {
  const out = [];
  const domId = node.domId;

  if (domId) {
    const sameId = index.all.filter((entry) => entry.domId === domId);
    if (sameId.length > 1) {
      const others = sameId.filter((entry) => entry.id !== node.id);
      out.push(
        suggestion({
          id: 'structure:duplicate-id',
          kind: 'structure',
          severity: 'error',
          title: `id "${domId}" is used ${sameId.length} times`,
          detail: `Duplicate ids break aria-labelledby, aria-controls and getElementById. Also on: ${others.map((entry) => entry.id).join(', ')}.`,
          ops: [{ op: 'removeAttr', nodeId: node.id, name: 'id' }],
        }),
      );
    }
  }

  if (CONTAINERS.has(node.tag) && !node.children.length && !textOf(node)) {
    out.push(
      suggestion({
        id: 'structure:empty-container',
        kind: 'structure',
        severity: 'warn',
        title: 'Empty container',
        detail: `An empty <${node.tag}> adds a landmark or list with nothing in it, which assistive tech announces and users can focus past.`,
        ops: [],
      }),
    );
  }

  // A part attached to something that is not inside a foundation.
  if (node.component?.kind === 'part' && !index.partsOf.get(node.id)) {
    out.push(
      suggestion({
        id: 'structure:orphan-part',
        kind: 'structure',
        severity: 'error',
        title: 'Part outside its foundation',
        detail: `[data-hf-part="${node.component.name}"] has no ancestor with [data-hf], so nothing will ever mount it.`,
        ops: [{ op: 'removeAttr', nodeId: node.id, name: 'data-hf-part' }],
      }),
    );
  }

  return out;
}

/** Metadata and non-rendered tags: styling advice is meaningless for these. */
const UNSTYLED = new Set(['html', 'head', 'meta', 'link', 'title', 'script', 'style', 'base', 'template', '#document']);

/**
 * Style wiring: is there a hook the page gave this element that no rule uses?
 *
 * "No rule matched" is far too noisy on its own: a `<p>` inside a styled
 * parent is correct, and inheriting is the normal case. The actionable defect
 * is an author-added hook (a class, an id, or a custom element tag) that
 * nothing styles — the user named it, then never wrote the rule.
 */
function styleSuggestions(node, model, target) {
  if (UNSTYLED.has(node.tag)) return [];
  const rules = model.matched?.[node.id] ?? [];
  const specific = rules.filter((rule) => rule.selector !== '*' && !rule.dynamic);
  if (specific.length) return [];

  const hook = node.classes?.[node.classes.length - 1] ?? (node.domId ? `#${node.domId}` : null);
  const customElement = node.tag.includes('-');
  if (!hook && !customElement) return [];

  return [
    suggestion({
      id: 'style:unused-hook',
      kind: 'style',
      severity: 'warn',
      title: hook ? `No rule uses "${hook}"` : `No rule targets <${node.tag}>`,
      detail: `The element is named but inherits every style from its parent. Add a rule in ${target?.file ?? 'a stylesheet'} to control its shape, size or colour.`,
      ops: [],
    }),
  ];
}

/* ----------------------------------------------------------- recommendations */

/**
 * Shape/size/colour proposals. These use the page's own tokens when they exist,
 * so the result matches the surrounding design instead of inventing a palette.
 */
function shapeSuggestions(node, model, target) {
  if (!target?.file) return [];
  const rules = model.matched?.[node.id] ?? [];
  const decls = effectiveDecls(rules);
  const tokens = tokensFrom(rules);
  const selector = target.selector ?? node.classes?.[node.classes.length - 1];
  if (!selector) return [];

  const out = [];

  /** A declaration edit against this node's rule; the panel fills file/version. */
  const setDecl = (property, value) => ({ op: 'setDecl', selector, property, value, create: true });

  if (node.children.length >= 2) {
    // A container of siblings is the case where layout advice is actionable.
    if (!decls.display || decls.display === 'block' || decls.display === 'inline') {
      out.push(
        suggestion({
          id: 'shape:flex-row',
          kind: 'shape',
          severity: 'info',
          title: 'Lay the children out as a row',
          detail: `${node.children.length} children are stacked as blocks. \`display:flex\` with a gap spaces them without margins.`,
          ops: [setDecl('display', 'flex'), setDecl('gap', token(tokens, '--hf-gap', '0.75rem'))],
        }),
      );
    }
    if (!decls.gap && decls.display?.includes('flex')) {
      out.push(
        suggestion({
          id: 'shape:gap',
          kind: 'shape',
          severity: 'info',
          title: 'Add a gap between children',
          detail: 'Flex children have no spacing; `gap` avoids margin hacks on each child.',
          ops: [setDecl('gap', token(tokens, '--hf-gap', '0.75rem'))],
        }),
      );
    }
    if (node.children.length >= 3 && decls.display === 'flex' && decls['flex-direction'] !== 'column') {
      out.push(
        suggestion({
          id: 'shape:wrap',
          kind: 'shape',
          severity: 'info',
          title: 'Allow the row to wrap',
          detail: `${node.children.length} children in one row overflow on narrow screens. \`flex-wrap: wrap\` keeps them reachable.`,
          ops: [setDecl('flex-wrap', 'wrap')],
        }),
      );
    }
  }

  if ((node.children.length >= 2 || node.tag === 'section') && !decls.padding) {
    out.push(
      suggestion({
        id: 'size:padding',
        kind: 'size',
        severity: 'info',
        title: 'Add padding',
        detail: 'The element is a container with no padding, so its content sits flush against the edge.',
        ops: [setDecl('padding', token(tokens, '--hf-space', '1rem'))],
      }),
    );
  }

  if (node.tag === 'button' || node.tag === 'a') {
    if (!decls['border-radius']) {
      out.push(
        suggestion({
          id: 'shape:radius',
          kind: 'shape',
          severity: 'info',
          title: 'Round the corners',
          detail: 'Follows the page radius token when one exists.',
          ops: [setDecl('border-radius', token(tokens, '--hf-radius', '0.5rem'))],
        }),
      );
    }
  }

  // Colour: only propose when the element does not already set one.
  if (!decls.color) {
    out.push(
      suggestion({
        id: 'colour:foreground',
        kind: 'colour',
        severity: 'info',
        title: 'Set an explicit text colour',
        detail: 'It currently inherits its colour, so a parent restyle silently changes it.',
        ops: [setDecl('color', token(tokens, '--hf-fg', 'currentColor'))],
      }),
    );
  }
  if (!decls.background && !decls['background-color'] && (node.tag === 'button' || node.tag === 'section' || node.classes?.length)) {
    out.push(
      suggestion({
        id: 'colour:surface',
        kind: 'colour',
        severity: 'info',
        title: 'Give it a surface',
        detail: 'A background separates the element from the page.',
        ops: [setDecl('background', token(tokens, '--hf-surface', 'transparent'))],
      }),
    );
  }

  return out;
}

/** Logic: state the foundation/component supports but the markup never uses. */
function logicSuggestions(node, model, target, index) {
  const out = [];
  const component = node.component;

  if (component?.kind === 'foundation') {
    const meta = (model.foundations ?? []).find((entry) => entry.name === component.name);
    const schema = meta?.options ?? {};
    const current = component.options ?? {};
    for (const [key, fallback] of Object.entries(schema)) {
      if (key in current) continue;
      out.push(
        suggestion({
          id: `logic:${component.name}:option:${key}`,
          kind: 'logic',
          severity: 'info',
          title: `Set the "${key}" option`,
          detail: `The default is ${JSON.stringify(fallback)}. Writing it makes the intended behaviour explicit in the markup.`,
          ops: [
            {
              op: 'setAttr',
              nodeId: node.id,
              name: 'data-hf-options',
              value: JSON.stringify({ ...current, [key]: fallback }),
            },
          ],
        }),
      );
    }

    // Unused parts are inert markup the user probably forgot to wire up.
    for (const part of partsOf(node, index)) {
      if (!meta?.parts?.[part.name]) continue;
      if (part.node.children.length || textOf(part.node)) continue;
      out.push(
        suggestion({
          id: `logic:${component.name}:empty:${part.name}`,
          kind: 'logic',
          severity: 'info',
          title: `Fill the "${part.name}" part`,
          detail: `The part exists but is empty, so ${component.name} has a control with nothing to show.`,
          ops: [],
        }),
      );
    }
  }

  if (component?.kind === 'component') {
    const meta = (model.components ?? []).find((entry) => entry.name === component.name);
    const props = meta?.props ?? {};
    const current = component.props ?? {};
    for (const [key, type] of Object.entries(props)) {
      if (key in current) continue;
      const attr = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      const fallback = meta?.defaults?.[key];
      if (fallback === undefined) continue;
      out.push(
        suggestion({
          id: `logic:${component.name}:prop:${key}`,
          kind: 'logic',
          severity: 'info',
          title: `Set the "${key}" prop`,
          detail: `Default is ${JSON.stringify(fallback)} (${type}). Writing it keeps the usage explicit.`,
          ops: [{ op: 'setAttr', nodeId: node.id, name: attr, value: String(fallback) }],
        }),
      );
    }
  }

  // Interactive markup with no behaviour attached is the main "logic" gap.
  if (!component || component.kind === 'plain') {
    const interactive = ['button', 'a', 'input', 'select', 'textarea', 'details'].includes(node.tag);
    if (interactive && !('data-hf' in (node.attrs ?? {}))) {
      out.push(
        suggestion({
          id: 'logic:headless',
          kind: 'logic',
          severity: 'info',
          title: 'Use a headless foundation',
          detail: `A bare <${node.tag}> has no behaviour layer. A foundation supplies the ARIA state and keyboard handling and keeps your styling.`,
          ops: [],
        }),
      );
    }
  }

  return out;
}

/* ------------------------------------------------------------------ public */

/**
 * @param {object} node   serialized tree node (`id`, `tag`, `attrs`, `component`, `parts`, ...)
 * @param {object} model  page model (`matched`, `foundations`, `components`, ...)
 * @param {object} target stylesheet target for this node (`file`, `version`, `selector`)
 * @returns {Array} suggestions, most severe first
 */
export function suggestionsFor(node, model, target, index = indexTree(model.tree)) {
  if (!node) return [];
  const severityRank = { error: 0, warn: 1, info: 2 };
  const all = [
    ...foundationSuggestions(node, model, index),
    ...a11ySuggestions(node, index),
    ...structureSuggestions(node, model, index),
    ...styleSuggestions(node, model, target),
    ...shapeSuggestions(node, model, target),
    ...logicSuggestions(node, model, target, index),
  ];
  // Stable within a severity so shape/size/colour keep their order.
  return all
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (severityRank[a.entry.severity] - severityRank[b.entry.severity]) || (a.index - b.index))
    .map(({ entry }) => entry);
}

export const SEVERITY_LABEL = { error: 'Error', warn: 'Warning', info: 'Suggestion' };
