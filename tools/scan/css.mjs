/**
 * CSS scanner: rules, declarations and exact source ranges.
 *
 * Used to write tokens back into `styles/*.css`, to enumerate the design
 * tokens an editor can offer, and to reject edits on syntax we cannot
 * round-trip (nested at-rules we do not model are reported, not guessed).
 */

/** @typedef {{selector: string, selectorStart: number, bodyStart: number, bodyEnd: number, start: number, end: number, decls: object[]}} Rule */

function skipString(source, pos) {
  const quote = source[pos];
  let i = pos + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function skipComment(source, pos) {
  const end = source.indexOf('*/', pos + 2);
  return end === -1 ? source.length : end + 2;
}

/** Finds the matching `}` for the `{` at `open`. */
function matchBrace(source, open) {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '*') {
      i = skipComment(source, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(source, i);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function parseDeclarations(source, from, to) {
  const decls = [];
  let pos = from;
  while (pos < to) {
    while (pos < to && /\s/.test(source[pos])) pos += 1;
    if (pos >= to) break;
    if (source[pos] === '/' && source[pos + 1] === '*') {
      pos = skipComment(source, pos);
      continue;
    }
    if (source[pos] === ';') {
      pos += 1;
      continue;
    }
    const start = pos;
    let colon = -1;
    let depth = 0;
    let nested = false;
    while (pos < to) {
      const ch = source[pos];
      if (ch === '/' && source[pos + 1] === '*') {
        pos = skipComment(source, pos);
        continue;
      }
      if (ch === '"' || ch === "'") {
        pos = skipString(source, pos);
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ':' && depth === 0 && colon === -1) colon = pos;
      else if (ch === ';' && depth === 0) break;
      else if (ch === '{' && depth === 0) {
        // Nested rule inside a declaration block: skip the whole block.
        const close = matchBrace(source, pos);
        nested = true;
        pos = close === -1 ? to : close + 1;
        break;
      }
      pos += 1;
    }
    if (nested) continue;
    const end = pos;
    if (colon !== -1) {
      let valueEnd = end;
      while (valueEnd > colon && /\s/.test(source[valueEnd - 1])) valueEnd -= 1;
      const property = source.slice(start, colon).trim().toLowerCase();
      if (property) {
        decls.push({
          property,
          value: source.slice(colon + 1, valueEnd).trim(),
          start,
          end,
          colon,
          valueStart: colon + 1,
          valueEnd,
        });
      }
    }
    if (source[pos] === ';') pos += 1;
  }
  return decls;
}

/**
 * @param {string} source
 * @returns {{rules: Rule[], customProps: {name: string, value: string, start: number, end: number}[], problems: {message: string, offset: number}[]}}
 */
export function scanCss(source) {
  const rules = [];
  const problems = [];
  const customProps = [];
  let pos = 0;

  while (pos < source.length) {
    while (pos < source.length && /\s/.test(source[pos])) pos += 1;
    if (pos >= source.length) break;
    if (source[pos] === '/' && source[pos + 1] === '*') {
      pos = skipComment(source, pos);
      continue;
    }
    if (source[pos] === '@') {
      const brace = source.indexOf('{', pos);
      const semi = source.indexOf(';', pos);
      if (semi !== -1 && (brace === -1 || semi < brace)) {
        pos = semi + 1;
        continue;
      }
      if (brace === -1) break;
      const close = matchBrace(source, brace);
      if (close === -1) {
        problems.push({ message: 'unbalanced at-rule block', offset: pos });
        break;
      }
      // Nested rules inside at-rules (e.g. @media) are still scanned.
      const prelude = source.slice(pos, brace).trim();
      const start = pos;
      const innerRules = scanCss(source.slice(brace + 1, close)).rules;
      for (const rule of innerRules) {
        rules.push({
          selector: rule.selector,
          selectorStart: rule.selectorStart + brace + 1,
          bodyStart: rule.bodyStart + brace + 1,
          bodyEnd: rule.bodyEnd + brace + 1,
          start: rule.start + brace + 1,
          end: rule.end + brace + 1,
          decls: rule.decls.map((decl) => ({ ...decl, start: decl.start + brace + 1, end: decl.end + brace + 1 })),
          atRule: prelude,
        });
      }
      for (const prop of scanCss(source.slice(brace + 1, close)).customProps) {
        customProps.push({ ...prop, start: prop.start + brace + 1, end: prop.end + brace + 1 });
      }
      // Keep the block itself so selectors inside @media are addressable.
      rules.push({
        selector: prelude,
        selectorStart: start,
        bodyStart: brace + 1,
        bodyEnd: close,
        start,
        end: close + 1,
        decls: parseDeclarations(source, brace + 1, close),
        atRule: prelude,
        block: true,
      });
      pos = close + 1;
      continue;
    }
    const brace = source.indexOf('{', pos);
    if (brace === -1) break;
    const close = matchBrace(source, brace);
    if (close === -1) {
      problems.push({ message: 'unbalanced rule block', offset: pos });
      break;
    }
    const selectorStart = pos;
    const selector = source.slice(selectorStart, brace).trim();
    const decls = parseDeclarations(source, brace + 1, close);
    rules.push({ selector, selectorStart, bodyStart: brace + 1, bodyEnd: close, start: selectorStart, end: close + 1, decls });
    for (const decl of decls) {
      if (decl.property.startsWith('--')) {
        customProps.push({ name: decl.property, value: decl.value, start: decl.start, end: decl.end });
      }
    }
    pos = close + 1;
  }

  return { rules, customProps, problems };
}

/** Rules whose selector list includes `selector` (exact match on any comma part). */
export function rulesFor(css, selector) {
  const wanted = selector.trim();
  return css.rules.filter((rule) => {
    if (rule.block || rule.atRule) return false;
    return rule.selector.split(',').some((part) => part.trim() === wanted);
  });
}

export function findDecl(rule, property) {
  const lower = property.toLowerCase();
  return rule.decls.find((decl) => decl.property === lower) || null;
}

/** Design tokens grouped for a settings UI. */
export function tokenGroups(css) {
  const groups = new Map();
  for (const prop of css.customProps) {
    const name = prop.name;
    const group = name.replace(/^--/, '').split('-')[0] || 'base';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name, value: prop.value });
  }
  return Array.from(groups, ([group, tokens]) => ({ group, tokens }));
}
