/**
 * Page model: scanned HTML tree + CSS rules + component classification,
 * serialized for the studio panel.
 *
 * The server has no DOM, so selector matching is implemented here. It is a
 * static matcher: selectors that depend on user interaction (`:hover`,
 * `:focus-visible`) or generated content (`::before`) are reported as
 * `dynamic` instead of being silently treated as non-matching.
 */
import { attr, findNode, scanHtml } from '../scan/html.mjs';
import { rulesFor, scanCss } from '../scan/css.mjs';
import { discover, hashOf, readSource, resolveRef, safeRelPath, StudioError } from './discover.mjs';

const TEXT_LIMIT = 80;

/* ------------------------------------------------------------ selectors */

const DYNAMIC_PSEUDO = new Set([
  'hover', 'focus', 'focus-within', 'focus-visible', 'active', 'visited', 'target',
  'checked', 'disabled', 'enabled', 'placeholder-shown', 'invalid', 'valid', 'user-invalid',
  'autofill', 'default', 'indeterminate', 'fullscreen', 'modal', 'popover-open', 'open', 'closed',
]);

const STRUCTURAL = new Set([
  'root', 'empty', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type',
  'only-of-type', 'not', 'is', 'where', 'nth-child', 'nth-of-type',
]);

/** Splits on a top-level separator, respecting (), [] and quotes. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Parses one compound selector (no combinators) into a predicate descriptor. */
function parseCompound(text) {
  const test = { tag: null, id: null, classes: [], attrs: [], pseudos: [], dynamic: [], unsupported: [] };
  let i = 0;
  const readIdent = () => {
    let out = '';
    while (i < text.length && /[\w-]/.test(text[i])) {
      out += text[i];
      i += 1;
    }
    return out;
  };

  if (text[i] === '*') {
    i += 1;
  } else if (/[A-Za-z]/.test(text[i] ?? '')) {
    test.tag = readIdent().toLowerCase();
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '.') {
      i += 1;
      test.classes.push(readIdent());
    } else if (ch === '#') {
      i += 1;
      test.id = readIdent();
    } else if (ch === '[') {
      const end = text.indexOf(']', i);
      if (end === -1) {
        test.unsupported.push('unterminated attribute selector');
        break;
      }
      const body = text.slice(i + 1, end);
      i = end + 1;
      const match = body.match(/^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*(i)?)?\s*$/);
      if (!match) {
        test.unsupported.push(`[${body}]`);
        continue;
      }
      test.attrs.push({
        name: match[1].toLowerCase(),
        operator: match[2] ?? null,
        value: match[3] ?? match[4] ?? match[5] ?? '',
        insensitive: Boolean(match[6]),
      });
    } else if (ch === ':') {
      i += 1;
      if (text[i] === ':') {
        i += 1;
        const pseudoElement = readIdent();
        test.dynamic.push(`::${pseudoElement}`);
        continue;
      }
      const name = readIdent().toLowerCase();
      let arg = null;
      if (text[i] === '(') {
        const end = findCloseParen(text, i);
        arg = text.slice(i + 1, end);
        i = end + 1;
      }
      if (DYNAMIC_PSEUDO.has(name)) test.dynamic.push(`:${name}`);
      else if (STRUCTURAL.has(name)) test.pseudos.push({ name, arg });
      else test.unsupported.push(`:${name}`);
    } else {
      test.unsupported.push(ch);
      i += 1;
    }
  }
  return test;
}

function findCloseParen(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/**
 * Parses a complex selector into `[{compound, combinator}]`, right to left.
 * Returns null when the selector uses something we cannot evaluate.
 */
export function parseSelector(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokens = [];
  let buffer = '';
  let depth = 0;
  let quote = '';
  const flush = (combinator) => {
    const compound = buffer.trim();
    if (compound) tokens.push({ compound: parseCompound(compound), combinator });
    buffer = '';
  };
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote) {
      buffer += ch;
      if (ch === '\\') {
        buffer += trimmed[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (buffer.trim()) {
        // Look ahead for an explicit combinator.
        let j = i;
        while (j < trimmed.length && /\s/.test(trimmed[j])) j += 1;
        const next = trimmed[j];
        if (next === '>' || next === '+' || next === '~') {
          flush(next);
          i = j;
        } else {
          flush(' ');
        }
      }
      continue;
    }
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) {
      flush(ch);
      continue;
    }
    buffer += ch;
  }
  flush(null);

  for (const { compound } of tokens) {
    if (compound.unsupported.length) return null;
  }
  return tokens;
}

function siblingIndex(node) {
  return node.parent ? node.parent.children.indexOf(node) : 0;
}

function matchesCompound(node, test, tree) {
  if (node.tag === '#document') return false;
  if (test.tag && test.tag !== node.tag) return false;
  const classes = (attr(node, 'class')?.value ?? '').split(/\s+/).filter(Boolean);
  for (const name of test.classes) if (!classes.includes(name)) return false;
  if (test.id && attr(node, 'id')?.value !== test.id) return false;
  for (const wanted of test.attrs) {
    const found = attr(node, wanted.name);
    if (!found) return false;
    if (!wanted.operator) continue;
    const actual = wanted.insensitive ? found.value.toLowerCase() : found.value;
    const value = wanted.insensitive ? wanted.value.toLowerCase() : wanted.value;
    switch (wanted.operator) {
      case '=':
        if (actual !== value) return false;
        break;
      case '~=':
        if (!actual.split(/\s+/).includes(value)) return false;
        break;
      case '|=':
        if (!(actual === value || actual.startsWith(`${value}-`))) return false;
        break;
      case '^=':
        if (!actual.startsWith(value)) return false;
        break;
      case '$=':
        if (!actual.endsWith(value)) return false;
        break;
      case '*=':
        if (!actual.includes(value)) return false;
        break;
      default:
        return false;
    }
  }
  for (const pseudo of test.pseudos) {
    switch (pseudo.name) {
      case 'root':
        if (node.tag !== 'html') return false;
        break;
      case 'empty':
        if (node.children.length) return false;
        break;
      case 'first-child':
        if (siblingIndex(node) !== 0) return false;
        break;
      case 'last-child':
        if (siblingIndex(node) !== node.parent.children.length - 1) return false;
        break;
      case 'only-child':
        if (node.parent.children.length !== 1) return false;
        break;
      case 'first-of-type':
        if (node.parent.children.findIndex((c) => c.tag === node.tag) !== node.parent.children.indexOf(node)) return false;
        break;
      case 'last-of-type':
        if ([...node.parent.children].reverse().findIndex((c) => c.tag === node.tag) !== [...node.parent.children].reverse().indexOf(node)) return false;
        break;
      case 'only-of-type':
        if (node.parent.children.filter((c) => c.tag === node.tag).length !== 1) return false;
        break;
      case 'not': {
        const list = splitTopLevel(pseudo.arg ?? '', ',').map((part) => parseCompound(part.trim()));
        if (list.some((inner) => matchesCompound(node, inner, tree))) return false;
        break;
      }
      case 'is':
      case 'where': {
        const list = splitTopLevel(pseudo.arg ?? '', ',').map((part) => parseCompound(part.trim()));
        if (!list.some((inner) => matchesCompound(node, inner, tree))) return false;
        break;
      }
      case 'nth-child':
      case 'nth-of-type': {
        const siblings = node.parent.children.filter((c) => pseudo.name === 'nth-child' || c.tag === node.tag);
        const index = siblings.indexOf(node) + 1;
        if (!matchesNth(index, pseudo.arg ?? '')) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

function matchesNth(index, arg) {
  const text = arg.trim().toLowerCase();
  if (text === 'odd') return index % 2 === 1;
  if (text === 'even') return index % 2 === 0;
  if (/^-?\d+$/.test(text)) return index === Number(text);
  const match = text.match(/^(-?\d*)n\s*([+-]\s*\d+)?$/);
  if (!match) return false;
  const a = match[1] === '' || match[1] === '+' ? 1 : match[1] === '-' ? -1 : Number(match[1]);
  const b = match[2] ? Number(match[2].replace(/\s+/g, '')) : 0;
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

/** Matches a complex selector against a scanned node. */
export function matchesSelector(node, tokens) {
  const check = (current, index) => {
    const { compound, combinator } = tokens[index];
    if (!matchesCompound(current, compound, null)) return false;
    if (index === 0) return true;
    const previous = tokens[index - 1];
    if (combinator === '>') {
      return Boolean(current.parent) && check(current.parent, index - 1);
    }
    if (combinator === '+') {
      const siblings = current.parent?.children ?? [];
      const at = siblings.indexOf(current);
      return at > 0 && check(siblings[at - 1], index - 1);
    }
    if (combinator === '~') {
      const siblings = current.parent?.children ?? [];
      const at = siblings.indexOf(current);
      for (let i = at - 1; i >= 0; i -= 1) if (check(siblings[i], index - 1)) return true;
      return false;
    }
    // descendant
    let ancestor = current.parent;
    while (ancestor) {
      if (check(ancestor, index - 1)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  };
  return tokens.length > 0 && check(node, tokens.length - 1);
}

/** Selector text that identifies a node, used for the "add a rule" fallback. */
export function selectorFor(node) {
  if (!node || node.tag === '#document') return null;
  const cls = (attr(node, 'class')?.value ?? '').split(/\s+/).filter(Boolean);
  if (cls.length) return `.${cls[cls.length - 1]}`;
  const id = attr(node, 'id')?.value;
  if (id) return `#${id}`;
  return node.tag;
}

/* ------------------------------------------------------------ tree output */

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function textPreview(source, node) {
  if (!node.children.length) {
    const raw = source.slice(node.inner.start, node.inner.end).replace(/\s+/g, ' ').trim();
    return raw.length > TEXT_LIMIT ? `${raw.slice(0, TEXT_LIMIT)}…` : raw;
  }
  return '';
}

function attrsObject(node) {
  const out = {};
  for (const entry of node.attrs) out[entry.name] = entry.boolean ? '' : entry.value;
  return out;
}

/** Classifies a node as foundation / user component / part / plain. */
function classify(node, foundations, components) {
  const hfName = attr(node, 'data-hf')?.value;
  if (hfName) {
    const meta = foundations.find((entry) => entry.name === hfName);
    return {
      kind: 'foundation',
      name: hfName,
      options: parseOptions(attr(node, 'data-hf-options')?.value),
      summary: meta?.summary ?? '',
      optionSchema: meta?.options ?? {},
    };
  }
  const component = components.find((entry) => entry.tag === node.tag);
  if (component) {
    const props = {};
    for (const key of Object.keys(component.defaults ?? {})) {
      const value = attr(node, key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      if (value) props[key] = value.boolean ? true : value.value;
    }
    return { kind: 'component', name: component.name, props, propTypes: component.props, defaults: component.defaults };
  }
  const partName = attr(node, 'data-hf-part')?.value;
  if (partName) {
    const owner = node.parent && (function findOwner(current) {
      while (current) {
        if (attr(current, 'data-hf')) return current;
        current = current.parent;
      }
      return null;
    })(node.parent);
    return { kind: 'part', name: partName, owner: owner ? attr(owner, 'data-hf')?.value : null };
  }
  return { kind: 'plain', name: null };
}

function parseOptions(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeTree(tree, source, starts, foundations, components, file) {
  const serialize = (node) => {
    const out = {
      id: node.id,
      tag: node.tag,
      line: lineAt(starts, node.open.start),
      attrs: attrsObject(node),
      classes: (attr(node, 'class')?.value ?? '').split(/\s+/).filter(Boolean),
      component: classify(node, foundations, components),
      text: textPreview(source, node),
      range: [node.open.start, node.close ? node.close.end : node.inner.end],
      children: node.children.map(serialize),
    };
    if (attr(node, 'id')) out.domId = attr(node, 'id').value;
    return out;
  };
  const root = serialize(tree.root);
  root.file = file;
  return root;
}

/* ------------------------------------------------------------ page model */

async function stylesheetEntries(root, pageRel, pageHtml, inlineCss) {
  const entries = [];
  for (const match of pageHtml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const hrefMatch = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    const rel = resolveRef(pageRel, href ?? '');
    if (!rel) continue;
    try {
      const source = await readSource(root, rel);
      const css = scanCss(source.text);
      entries.push({
        file: rel,
        href,
        version: source.version,
        rules: css.rules.filter((rule) => !rule.block).map((rule) => ({
          selector: rule.selector,
          atRule: rule.atRule ?? null,
          decls: rule.decls.map((decl) => ({ property: decl.property, value: decl.value })),
        })),
        problems: css.problems,
      });
    } catch (error) {
      entries.push({ file: rel, href, error: error.message, rules: [], problems: [] });
    }
  }
  if (inlineCss) {
    const css = scanCss(inlineCss.source);
    entries.push({
      file: pageRel,
      inline: true,
      version: inlineCss.version,
      rules: css.rules.filter((rule) => !rule.block).map((rule) => ({
        selector: rule.selector,
        atRule: null,
        decls: rule.decls.map((decl) => ({ property: decl.property, value: decl.value })),
      })),
      problems: css.problems,
    });
  }
  return entries;
}

/** `<style>` blocks in a page, concatenated for scanning. */
function inlineStyles(source, tree) {
  const blocks = tree.nodes.filter((node) => node.tag === 'style');
  if (!blocks.length) return null;
  return { source: blocks.map((node) => source.slice(node.inner.start, node.inner.end)).join('\n'), blocks };
}

/**
 * Where does this element come from, and where do I edit it?
 *
 * Three separate questions, because a headless UI splits them across files:
 *   markup   - the HTML that must exist for this node to render
 *   behavior - the JS that wires events/ARIA (foundation or component)
 *   styles   - every stylesheet with a rule that matches
 *
 * A foundation instance is markup in the page + behavior in the foundation
 * module + CSS possibly somewhere else entirely. Naming all three is the point.
 */
function ownerOf(node, project, sheets, starts) {
  const owner = { markup: null, behavior: null, styles: [] };

  // Markup: whoever wrote the element. Nodes in the page tree are page markup;
  // a component's internals are not in this tree at all (see `internalOwner`).
  owner.markup = { file: node.file, line: lineAt(starts, node.open.start) };

  // Behavior: the nearest enclosing host that has one.
  let current = node;
  while (current) {
    const hfName = attr(current, 'data-hf')?.value;
    if (hfName) {
      const foundation = project.foundations.find((entry) => entry.name === hfName);
      owner.behavior = {
        kind: 'foundation',
        name: hfName,
        file: foundation?.file ?? null,
        // A part node is controlled by the foundation, not by itself.
        part: current === node ? null : attr(node, 'data-hf-part')?.value ?? null,
      };
      break;
    }
    const component = project.components.find((entry) => entry.tag === current.tag);
    if (component) {
      owner.behavior = { kind: 'component', name: component.name, file: component.file };
      break;
    }
    current = current.parent;
  }

  // Styles: the sheets whose rules actually matched this node...
  const seen = new Set();
  for (const rule of matchedRules(node, sheets)) {
    if (seen.has(rule.file)) continue;
    seen.add(rule.file);
    const sheet = sheets.find((entry) => entry.file === rule.file);
    owner.styles.push({
      file: rule.file,
      kind: sheet?.component ? 'component' : rule.inline ? 'inline' : 'page',
      component: sheet?.component ?? null,
    });
  }
  // ...plus the stylesheet of the component this node lives in, which styles
  // its internals and never matches the host element itself.
  const hostComponent = project.components.find((entry) => entry.tag === node.tag);
  if (hostComponent?.styles && !seen.has(hostComponent.styles)) {
    owner.styles.push({ file: hostComponent.styles, kind: 'component', component: hostComponent.name });
  }
  return owner;
}

/**
 * Attributes an element that only exists at runtime: the user clicked a
 * heading inside `<hf-example-card>`, which is rendered from the component's
 * template. Returns the template file and the matching element's markup.
 */
export function internalOwner(project, tag, descriptor) {
  const component = project.components.find((entry) => entry.tag === tag);
  if (!component) return null;
  const template = component.template ?? '';
  if (!template) return { component: component.name, file: component.file, styles: component.styles ?? null, found: false };
  const scanned = scanHtml(template);
  const match = scanned.nodes.find((node) => {
    if (node.tag !== descriptor.tag) return false;
    const classes = (attr(node, 'class')?.value ?? '').split(/\s+/).filter(Boolean);
    // Classes are the reliable runtime handle: template attributes such as
    // `{{ title }}` never survive to the DOM verbatim.
    return descriptor.classes.every((name) => classes.includes(name));
  });
  return {
    component: component.name,
    file: component.file,
    styles: component.styles ?? null,
    found: Boolean(match),
    markup: match ? template.slice(match.open.start, match.close ? match.close.end : match.inner.end).trim().slice(0, 200) : null,
    part: match ? attr(match, 'data-hf-part')?.value ?? null : null,
  };
}

/** Which rules apply to a node, per stylesheet. */
function matchedRules(node, sheets) {
  const result = [];
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      if (rule.selector.trim().startsWith('@')) continue;
      const parts = splitTopLevel(rule.selector, ',');
      let best = null;
      for (const part of parts) {
        const tokens = parseSelector(part);
        if (!tokens) {
          if (!best) best = { matched: false, dynamic: true, unsupported: part.trim() };
          continue;
        }
        const dynamic = tokens.some((token) => token.compound.dynamic.length);
        if (matchesSelector(node, tokens)) {
          if (!best || best.dynamic) best = { matched: true, dynamic, selector: part.trim() };
        } else if (!best && dynamic) {
          best = { matched: false, dynamic: true, selector: part.trim() };
        }
      }
      if (best?.matched) {
        result.push({
          file: sheet.file,
          inline: Boolean(sheet.inline),
          selector: best.selector ?? rule.selector,
          fullSelector: rule.selector,
          dynamic: Boolean(best.dynamic),
          atRule: rule.atRule ?? null,
          decls: rule.decls,
        });
      } else if (best && best.unsupported) {
        result.push({
          file: sheet.file,
          inline: Boolean(sheet.inline),
          selector: best.unsupported,
          fullSelector: rule.selector,
          unsupported: true,
          decls: rule.decls,
        });
      }
    }
  }
  return result;
}

export function tokensOf(sheets) {
  const groups = new Map();
  for (const sheet of sheets) {
    if (!sheet.rules) continue;
    // Custom properties live in the raw source; re-scan on demand by the caller.
  }
  return Array.from(groups, ([group, tokens]) => ({ group, tokens }));
}

/**
 * Builds the full editor model for one page.
 *
 * @param {string} root project root
 * @param {string} pageRel page file relative to root
 */
export async function buildPageModel(root, pageRel) {
  const project = await discover(root);
  const page = await readSource(root, pageRel);
  const tree = scanHtml(page.text, { file: pageRel });
  if (tree.problems.length) {
    throw new StudioError('SCAN_PROBLEMS', 'the page has syntax the editor cannot safely rewrite', {
      problems: tree.problems,
      file: pageRel,
    });
  }
  const starts = lineStarts(page.text);
  const inline = inlineStyles(page.text, tree);
  const sheets = await stylesheetEntries(root, pageRel, page.text, inline);

  // A user component links its own stylesheet at runtime (`linkStyles`), so it
  // never appears in the page's <link> tags. Pull it in for every component the
  // page actually instantiates, or its rules are invisible to the editor.
  const usedTags = new Set(tree.nodes.map((node) => node.tag));
  for (const component of project.components) {
    if (!usedTags.has(component.tag) || !component.styles) continue;
    if (sheets.some((sheet) => sheet.file === component.styles)) continue;
    try {
      const source = await readSource(root, component.styles);
      const css = scanCss(source.text);
      sheets.push({
        file: component.styles,
        href: component.styles,
        component: component.name,
        version: source.version,
        rules: css.rules.filter((rule) => !rule.block).map((rule) => ({
          selector: rule.selector,
          atRule: rule.atRule ?? null,
          decls: rule.decls.map((decl) => ({ property: decl.property, value: decl.value })),
        })),
        problems: css.problems,
      });
    } catch (error) {
      sheets.push({ file: component.styles, component: component.name, error: error.message, rules: [], problems: [] });
    }
  }

  // Design tokens, grouped by prefix, read from every linked stylesheet.
  const tokenMap = new Map();
  for (const sheet of sheets) {
    if (!sheet.rules) continue;
    try {
      const source = sheet.inline ? inline.source : (await readSource(root, sheet.file)).text;
      const css = scanCss(source);
      for (const prop of css.customProps) {
        const group = prop.name.replace(/^--/, '').split('-')[0] || 'base';
        if (!tokenMap.has(group)) tokenMap.set(group, new Map());
        tokenMap.get(group).set(prop.name, prop.value);
      }
    } catch {
      /* unreadable sheet already reported */
    }
  }
  const tokens = Array.from(tokenMap, ([group, map]) => ({
    group,
    tokens: Array.from(map, ([name, value]) => ({ name, value })),
  }));

  const perNode = new Map();
  for (const node of tree.nodes) perNode.set(node.id, matchedRules(node, sheets));

  // Ownership: for the selected node, which files own its markup, its
  // behavior, and its styling. This is the question "where do I edit this?"
  const owners = {};
  for (const node of tree.nodes) {
    owners[node.id] = ownerOf(node, project, sheets, starts);
  }

  return {
    file: pageRel,
    url: `/${pageRel}`,
    version: page.version,
    eol: page.eol,
    problems: tree.problems,
    tree: serializeTree(tree, page.text, starts, project.foundations, project.components, pageRel),
    sheets: sheets.map((sheet) => ({
      file: sheet.file,
      inline: Boolean(sheet.inline),
      // Naming the owning component lets the panel say "component stylesheet"
      // instead of implying a page-level sheet the user forgot about.
      component: sheet.component ?? null,
      href: sheet.href ?? null,
      version: sheet.version,
      error: sheet.error ?? null,
      rules: sheet.rules,
      problems: sheet.problems,
    })),
    tokens,
    matched: Object.fromEntries(perNode),
    owners,
    foundations: project.foundations,
    components: project.components,
    styles: project.styles,
    pages: project.pages,
    versionOf: {},
  };
}

/** Rules that apply to a node, from the serialized model. */
export function matchedFor(model, nodeId) {
  return model.matched[nodeId] ?? [];
}

/**
 * Applies a dry-run "what would this selector target" query; used by the
 * panel to show how many nodes a new rule would hit.
 */
export function countMatches(model, pageSource, selector) {
  const tokens = parseSelector(selector);
  if (!tokens) return { count: 0, unsupported: true };
  const tree = scanHtml(pageSource);
  return { count: tree.nodes.filter((node) => matchesSelector(node, tokens)).length, unsupported: false };
}

export { findNode, scanHtml, scanCss, rulesFor, safeRelPath, hashOf, resolveRef, splitTopLevel };
