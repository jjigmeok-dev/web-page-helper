/**
 * Edit engine.
 *
 * Every edit is an op with a source range resolved from a fresh scan, a
 * precondition checked against the current file, and a range replacement.
 * Nothing is re-serialized: bytes outside the edited ranges are untouched.
 *
 * Guarantees
 * 1. All-or-nothing per batch: one failed precondition → no writes.
 * 2. Post-scan verification: if an edit introduces syntax problems, no writes.
 * 3. Version fencing: a stale `version` → 409, the file is not touched.
 * 4. Atomic writes: temp file in the same directory, then rename.
 */
import { readFile, rename, unlink, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { attr, scanHtml } from '../scan/html.mjs';
import { scanCss } from '../scan/css.mjs';
import { hashOf, readSource, safeRelPath, StudioError } from './discover.mjs';
import { parseSelector, matchesSelector, selectorFor } from './model.mjs';

const MAX_OPS = 200;

/* ------------------------------------------------------------ utilities */

function escapeAttrValue(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Applies non-overlapping replacements to a string; later offsets first. */
function spliceEdits(source, edits) {
  // Descending offsets. For two insertions at the same offset, applying the
  // later op first keeps the batch's order in the output text.
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index)
    .map(({ edit }) => edit);
  let out = source;
  let lastStart = source.length + 1;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
      throw new StudioError('BAD_RANGE', 'an edit produced an out-of-range span');
    }
    if (edit.end > lastStart) {
      throw new StudioError('OVERLAP', 'two edits overlap; refusing to guess the intended order');
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

function indentOf(source, offset) {
  let lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let i = lineStart;
  let indent = '';
  while (i < source.length && (source[i] === ' ' || source[i] === '\t')) {
    indent += source[i];
    i += 1;
  }
  return indent;
}

function nodeAt(tree, id, file) {
  if (typeof id !== 'string') throw new StudioError('BAD_NODE', 'a node id is required');
  const node = tree.nodes.find((entry) => entry.id === id);
  if (!node) throw new StudioError('NODE_NOT_FOUND', `node ${id} is not in ${file}`, { node: id, file });
  return node;
}

function nodeHtml(source, node) {
  return source.slice(node.open.start, node.close ? node.close.end : node.inner.end);
}

/**
 * Re-indents a multi-line snippet so its first line sits at `indent` and the
 * rest keeps its relative shape. Snippets from the panel are written flush
 * left; dropping them in as-is breaks the file's indentation.
 */
/**
 * Removes `id` attributes from a markup block, so a copy cannot collide with
 * the original. `aria-*` references inside the block are dropped with them,
 * since they would point at the duplicate.
 */
function stripIds(block) {
  return block
    .replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(aria-(?:labelledby|describedby|controls|owns|activedescendant|details))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/**
 * Removes the common leading whitespace of a block, so it can be re-indented
 * for its new container.
 *
 * The first line is the element's own opening tag and carries no source
 * indentation, so the common prefix is measured on the following lines only.
 */
function dedent(block) {
  const lines = block.replace(/\s+$/, '').split('\n');
  if (lines.length === 1) return lines[0];
  const common = lines
    .slice(1)
    .filter((line) => line.trim())
    .reduce((min, line) => {
      const lead = line.match(/^[ \t]*/)[0].length;
      return min === null ? lead : Math.min(min, lead);
    }, null);
  if (!common) return lines.join('\n');
  const [first, ...rest] = lines;
  return [first, ...rest.map((line) => (line.trim() ? line.slice(common) : ''))].join('\n');
}

function reindent(block, indent) {
  // A snippet is written relative to its own first line; every line keeps its
  // intra-snippet nesting and only gains the destination indent.
  return block
    .split('\n')
    .map((line, index) => {
      if (!line.trim()) return '';
      return index === 0 ? `${indent}${line.trimStart()}` : `${indent}${line}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------ HTML ops */

function htmlEdits(source, tree, op, file) {
  const node = op.node === undefined ? null : nodeAt(tree, op.node, file);

  switch (op.op) {
    case 'setAttr': {
      if (!node) throw new StudioError('BAD_NODE', 'setAttr requires a node');
      if (typeof op.name !== 'string' || !/^[A-Za-z_:][-\w:.]*$/.test(op.name)) {
        throw new StudioError('BAD_ATTR', `invalid attribute name: ${op.name}`);
      }
      const existing = attr(node, op.name);
      const wanted = op.value === null || op.value === undefined || op.value === false ? null : String(op.value);
      if (op.expect !== undefined) {
        const current = existing ? (existing.boolean ? '' : existing.value) : null;
        if (current !== op.expect) {
          throw new StudioError('PRECONDITION', `${op.name} on ${op.node} changed since it was loaded`, {
            expected: op.expect,
            actual: current,
          });
        }
      }
      if (wanted === null) {
        if (!existing) return [];
        const start = source.lastIndexOf(' ', existing.start) === -1 ? existing.start : source.lastIndexOf(' ', existing.start);
        return [{ start, end: existing.end, text: '' }];
      }
      const rendered = wanted === 'true' && op.value === true ? op.name : `${op.name}="${escapeAttrValue(wanted)}"`;
      if (!existing) {
        const insertAt = node.selfClosing ? node.open.end - 2 : node.open.end - 1;
        return [{ start: insertAt, end: insertAt, text: ` ${rendered}` }];
      }
      if (existing.boolean) return [{ start: existing.nameStart, end: existing.nameEnd, text: rendered }];
      return [{ start: existing.start, end: existing.end, text: rendered }];
    }

    case 'removeAttr': {
      if (!node) throw new StudioError('BAD_NODE', 'removeAttr requires a node');
      const existing = attr(node, op.name);
      if (!existing) return [];
      const space = source.lastIndexOf(' ', existing.start);
      const start = space !== -1 && space >= node.open.start ? space : existing.start;
      return [{ start, end: existing.end, text: '' }];
    }

    case 'setText': {
      if (!node) throw new StudioError('BAD_NODE', 'setText requires a node');
      if (node.void) throw new StudioError('VOID_NODE', `<${node.tag}> cannot contain text`);
      if (node.children.length) {
        throw new StudioError('NOT_A_LEAF', `node ${node.id} has child elements; edit a leaf instead`);
      }
      const current = source.slice(node.inner.start, node.inner.end);
      if (op.expect !== undefined && current.trim() !== String(op.expect).trim()) {
        throw new StudioError('PRECONDITION', `text of ${op.node} changed since it was loaded`);
      }
      const lead = current.match(/^\s*/)?.[0] ?? '';
      const trail = current.match(/\s*$/)?.[0] ?? '';
      const value = op.value === null ? '' : escapeText(op.value);
      const text = value === '' ? '' : `${lead}${value}${trail}`;
      return [{ start: node.inner.start, end: node.inner.end, text }];
    }

    case 'appendToHead': {
      // Used when the editor creates a stylesheet: the new <link> must be in
      // <head> or the CSS never loads. Handles the headless page too.
      if (!op.html || typeof op.html !== 'string') throw new StudioError('BAD_OP', 'appendToHead requires html');
      const snippet = scanHtml(op.html.trim());
      if (snippet.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', 'the inserted markup is not well-formed', { problems: snippet.problems });
      }
      const head = tree.nodes.find((entry) => entry.tag === 'head');
      const line = reindent(op.html.trim(), head ? `${indentOf(source, head.open.start)}  ` : '  ');
      if (!head) return [{ start: source.length, end: source.length, text: `${line}\n` }];
      if (head.close) {
        const indent = indentOf(source, head.open.start);
        const at = head.close.start;
        const lineStart = source.lastIndexOf('\n', at - 1) + 1;
        if (lineStart > head.inner.start && source.slice(lineStart, at).trim() === '') {
          return [{ start: lineStart, end: at, text: `${line}\n${indent}` }];
        }
        return [{ start: at, end: at, text: `${line}\n${indent}` }];
      }
      return [{ start: head.inner.end, end: head.inner.end, text: `\n${line}\n` }];
    }

    case 'insertNode': {
      if (!op.html || typeof op.html !== 'string') throw new StudioError('BAD_OP', 'insertNode requires html');
      if (op.html.length > 20000) throw new StudioError('TOO_LARGE', 'inserted markup is too large');
      const position = op.position ?? 'append';
      if (!INSERT_POSITIONS.has(position)) {
        throw new StudioError('BAD_OP', `invalid insert position "${position}"`, {
          allowed: [...INSERT_POSITIONS],
        });
      }
      const anchor = node ?? tree.root;
      const snippet = scanHtml(op.html.trim());
      if (snippet.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', 'the inserted markup is not well-formed', { problems: snippet.problems });
      }
      const indent = indentOf(source, anchor.open.start);

      if (position === 'before' || position === 'after') {
        if (!anchor.parent) throw new StudioError('BAD_NODE', 'cannot insert beside the document node');
        const at = position === 'before' ? anchor.open.start : anchor.close ? anchor.close.end : anchor.inner.end;
        const lineStart = source.lastIndexOf('\n', at - 1) + 1;
        const lineIndent = indentOf(source, at);
        if (position === 'before') {
          return [{ start: lineStart, end: lineStart, text: `${reindent(op.html.trim(), lineIndent)}\n` }];
        }
        const lineEnd = source.indexOf('\n', at);
        if (lineEnd === -1) {
          return [{ start: source.length, end: source.length, text: `\n${reindent(op.html.trim(), lineIndent)}` }];
        }
        return [{ start: lineEnd + 1, end: lineEnd + 1, text: `${reindent(op.html.trim(), lineIndent)}\n` }];
      }

      if (anchor.void) throw new StudioError('VOID_NODE', `<${anchor.tag}> cannot have children`);
      const childIndent = `${indent}  `;
      const block = reindent(op.html.trim(), childIndent);
      if (position === 'prepend') {
        return [{ start: anchor.inner.start, end: anchor.inner.start, text: `\n${block}` }];
      }
      const at = anchor.inner.end;
      const closingIndent = indent;
      // A populated container ends with the closing tag's own indentation.
      // Appending after it would leave a blank, space-only line.
      const lineStart = source.lastIndexOf('\n', at - 1) + 1;
      if (lineStart > anchor.inner.start && source.slice(lineStart, at).trim() === '') {
        return [{ start: lineStart, end: at, text: `${block}\n${closingIndent}` }];
      }
      return [{ start: at, end: at, text: `\n${block}\n${closingIndent}` }];
    }

    case 'removeNode': {
      if (!node) throw new StudioError('BAD_NODE', 'removeNode requires a node');
      if (!node.parent) throw new StudioError('BAD_NODE', 'cannot remove the document node');
      if (op.expectHtml !== undefined && nodeHtml(source, node).trim() !== String(op.expectHtml).trim()) {
        throw new StudioError('PRECONDITION', `node ${op.node} changed since it was loaded`);
      }
      const start = source.lastIndexOf('\n', node.open.start - 1) + 1;
      const end = node.close ? node.close.end : node.inner.end;
      const lineEnd = source.indexOf('\n', end);
      const wholeLines =
        source.slice(start, node.open.start).trim() === '' &&
        (lineEnd === -1 || source.slice(end, lineEnd).trim() === '');
      return [{ start: wholeLines ? start : node.open.start, end: wholeLines && lineEnd !== -1 ? lineEnd + 1 : end, text: '' }];
    }

    case 'duplicateNode': {
      if (!node) throw new StudioError('BAD_NODE', 'duplicateNode requires a node');
      if (!node.parent) throw new StudioError('BAD_NODE', 'cannot duplicate the document node');
      // The copy must not reintroduce ids: duplicate ids are invalid HTML and
      // make every `getElementById`/`querySelector('#id')` ambiguous.
      const html = dedent(stripIds(nodeHtml(source, node)));
      if (op.expectHtml !== undefined && nodeHtml(source, node).trim() !== String(op.expectHtml).trim()) {
        throw new StudioError('PRECONDITION', `node ${op.node} changed since it was loaded`);
      }
      // Reuse the insert path so the copy lands on its own line with the
      // sibling indentation, exactly like a hand-written duplicate.
      return htmlEdits(source, tree, { op: 'insertNode', node: node.id, position: 'after', html }, file);
    }

    case 'moveNode': {
      if (!node) throw new StudioError('BAD_NODE', 'moveNode requires a node');
      const target = nodeAt(tree, op.target, file);
      if (!node.parent) throw new StudioError('BAD_NODE', 'cannot move the document node');
      if (target.id === node.id || target.id.startsWith(`${node.id}.`)) {
        throw new StudioError('BAD_OP', 'cannot move a node into itself');
      }
      // Capture the node at its own indentation, then dedent it so the insert
      // path can re-indent it for the destination.
      const html = dedent(nodeHtml(source, node));
      const removed = htmlEdits(source, tree, { op: 'removeNode', node: node.id }, file);
      // Apply the removal first so the insertion offsets are valid.
      const withoutNode = spliceEdits(source, removed);
      const newTree = scanHtml(withoutNode, { file });
      if (newTree.problems.length) throw new StudioError('SCAN_PROBLEMS', 'the move would break the page');

      // Structural ids shift when a node is removed, so the destination is
      // located by its source range mapped through the single removal edit:
      // before the cut offsets are unchanged, after it they shift left.
      const cut = removed[0];
      const cutStart = cut?.start ?? 0;
      const cutSize = cut ? cut.end - cut.start : 0;
      const wantStart = target.open.start >= cutStart + cutSize ? target.open.start - cutSize : target.open.start;
      if (target.open.start > cutStart && target.open.start < cutStart + cutSize) {
        throw new StudioError('BAD_OP', 'cannot move a node into its own removed range');
      }
      const wantEnd = wantStart + (target.open.end - target.open.start);
      const targetNow = newTree.nodes.find((entry) => entry.open.start === wantStart && entry.open.end === wantEnd);
      if (!targetNow) throw new StudioError('NODE_NOT_FOUND', 'the move destination disappeared');
      const inserted = htmlEdits(withoutNode, newTree, {
        op: 'insertNode',
        node: targetNow.id,
        position: op.position ?? 'append',
        html,
      }, file);
      return [{ final: true, text: spliceEdits(withoutNode, inserted) }];
    }

    case 'frameNode': {
      // Wrap a container's existing children in a frame skeleton, moving the
      // children into the element marked `data-hf-frame-slot`. Done as one
      // rewrite: a batch op cannot reference a node it just created.
      if (!node) throw new StudioError('BAD_NODE', 'frameNode requires a node');
      // `<body />` is legal HTML (the end tag is optional) and means "empty
      // document". It must be rewritten as `<body>…</body>`; treating it as a
      // void element blocked framing a bare page.
      const selfClosingContainer = node.selfClosing && !node.void;
      if (node.void) throw new StudioError('VOID_NODE', `<${node.tag}> cannot contain a frame`);
      if (!op.html || typeof op.html !== 'string') throw new StudioError('BAD_OP', 'frameNode requires html');
      const snippet = scanHtml(op.html.trim());
      if (snippet.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', 'the frame markup is not well-formed', { problems: snippet.problems });
      }
      const marker = snippet.nodes.find((entry) => attr(entry, op.marker ?? 'data-hf-frame-slot'));
      if (!marker) throw new StudioError('BAD_OP', `the frame needs a ${op.marker ?? 'data-hf-frame-slot'} element`);
      if (marker.void) throw new StudioError('VOID_NODE', 'the frame slot cannot be a void element');

      const inner = source.slice(node.inner.start, node.inner.end);
      const body = inner.trim() ? dedent(inner) : '';
      const indent = indentOf(source, node.open.start);
      const frameIndent = `${indent}  `;

      // Build the frame text with a placeholder where the content goes, then
      // reindent once so the placeholder lands at the right depth.
      const markerMarker = '\u0000HF_CONTENT\u0000';
      const pieces = [
        { start: marker.inner.start, end: marker.inner.end, text: markerMarker },
      ];
      const markerAttr = attr(marker, op.marker ?? 'data-hf-frame-slot');
      const markerSpace = op.html.trim().lastIndexOf(' ', markerAttr.start);
      pieces.push({
        start: markerSpace !== -1 && markerSpace >= marker.open.start ? markerSpace : markerAttr.start,
        end: markerAttr.end,
        text: '',
      });
      const frameSource = spliceEdits(op.html.trim(), pieces);
      const frame = reindent(frameSource, frameIndent);

      const resolved = frame
        .split('\n')
        .map((line) => {
          if (!line.includes(markerMarker)) return line;
          if (!body) return line.replace(markerMarker, '');
          const childIndent = `${line.match(/^[ \t]*/)[0]}  `;
          const block = body
            .split('\n')
            .map((child) => (child.trim() ? `${childIndent}${child}` : ''))
            .join('\n');
          return line.replace(markerMarker, `\n${block}\n${line.match(/^[ \t]*/)[0]}`).replace(/\n\n/g, '\n');
        })
        .join('\n')
        .replace(/[ \t]+$/gm, '');

      if (selfClosingContainer) {
        // Rewrite `<body />` as `<body>…</body>` so the frame has a home.
        const openTag = source.slice(node.open.start, node.open.end);
        const name = openTag.match(/^<([A-Za-z][\w-]*)/)?.[1] ?? node.tag;
        return [{ start: node.open.start, end: node.open.end, text: `<${name}>\n${resolved}\n${indent}</${name}>` }];
      }
      return [{ start: node.inner.start, end: node.inner.end, text: `\n${resolved}\n${indent}` }];
    }

    case 'frameDocument': {
      // A page with no <body> at all (a fragment, or an empty file) still needs
      // a shell before a frame can wrap anything. Creating the document is the
      // one case where the editor writes structure the file did not have.
      if (!op.html || typeof op.html !== 'string') throw new StudioError('BAD_OP', 'frameDocument requires html');
      if (tree.nodes.some((entry) => entry.tag === 'body')) {
        throw new StudioError('BAD_NODE', 'the page already has a <body> element');
      }
      const snippet = scanHtml(op.html.trim());
      if (snippet.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', 'the frame markup is not well-formed', { problems: snippet.problems });
      }
      const marker = snippet.nodes.find((entry) => attr(entry, op.marker ?? 'data-hf-frame-slot'));
      if (!marker) throw new StudioError('BAD_OP', `the frame needs a ${op.marker ?? 'data-hf-frame-slot'} element`);

      const content = source.trim() ? dedent(source) : '';
      const markerMarker = '\u0000HF_CONTENT\u0000';
      const markerAttr = attr(marker, op.marker ?? 'data-hf-frame-slot');
      const markerSpace = op.html.trim().lastIndexOf(' ', markerAttr.start);
      const frameSource = spliceEdits(op.html.trim(), [
        { start: marker.inner.start, end: marker.inner.end, text: markerMarker },
        {
          start: markerSpace !== -1 && markerSpace >= marker.open.start ? markerSpace : markerAttr.start,
          end: markerAttr.end,
          text: '',
        },
      ]);
      const frame = reindent(frameSource, '    ');
      const resolved = frame
        .split('\n')
        .map((line) => {
          if (!line.includes(markerMarker)) return line;
          if (!content) return line.replace(markerMarker, '');
          const childIndent = `${line.match(/^[ \t]*/)[0]}  `;
          const block = content
            .split('\n')
            .map((child) => (child.trim() ? `${childIndent}${child}` : ''))
            .join('\n');
          return line.replace(markerMarker, `\n${block}\n${line.match(/^[ \t]*/)[0]}`).replace(/\n\n/g, '\n');
        })
        .join('\n')
        .replace(/[ \t]+$/gm, '');

      // A stylesheet created in the same batch cannot be linked by a separate
      // op: this op replaces the whole document, so the link must be written
      // here, against the text this op produces.
      const linkTag = op.stylesheet ? `  <link rel="stylesheet" href="${op.stylesheet}">\n` : '';
      const htmlNode = tree.nodes.find((entry) => entry.tag === 'html');
      if (htmlNode) {
        // <html> exists but <body> does not: wrap everything that is not
        // <head> in a body, keeping the existing document element.
        const head = htmlNode.children.find((entry) => entry.tag === 'head');
        const movable = htmlNode.children.filter((entry) => entry !== head);
        const firstStart = movable.length
          ? Math.min(...movable.map((entry) => entry.open.start))
          : (head?.close?.end ?? htmlNode.open.end);
        const lastEnd = movable.length
          ? Math.max(...movable.map((entry) => (entry.close ? entry.close.end : entry.inner.end)))
          : firstStart;
        const indent = indentOf(source, htmlNode.open.start);
        const edits = [
          {
            start: firstStart,
            end: lastEnd,
            text: `\n${indent}  <body>\n${resolved}\n${indent}  </body>`,
          },
        ];
        if (op.stylesheet) {
          const link = `${indent}  <link rel="stylesheet" href="${op.stylesheet}">\n`;
          const at = head?.close ? head.close.start : (head?.inner.end ?? htmlNode.open.end);
          edits.push({ start: at, end: at, text: link });
        }
        return edits;
      }
      return [{ start: 0, end: source.length, text: `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${op.title ?? 'Untitled'}</title>\n${linkTag}</head>\n<body>\n${resolved}\n</body>\n</html>\n` }];
    }

    case 'wrapNode': {
      if (!node) throw new StudioError('BAD_NODE', 'wrapNode requires a node');
      if (!op.html || typeof op.html !== 'string') throw new StudioError('BAD_OP', 'wrapNode requires html');
      const open = op.html.trim();
      // Accept either a complete element (`<div class="x"></div>`) or an
      // opening tag only (`<div class="x">`), which is what the panel sends.
      const complete = scanHtml(open);
      let tag;
      if (!complete.problems.length && complete.nodes.length === 1 && complete.nodes[0].close) {
        tag = complete.nodes[0].tag;
      } else {
        const opening = open.match(/^<([A-Za-z][\w-]*)(?:\s[^<>]*)?>$/);
        if (!opening) throw new StudioError('SCAN_PROBLEMS', 'the wrapper must be one opening tag or one element');
        if (/^(?:html|head|body|main|script|style|link|meta|title)$/i.test(opening[1])) {
          throw new StudioError('BAD_OP', `<${opening[1]}> cannot be used as a wrapper`);
        }
        tag = opening[1].toLowerCase();
      }
      const closeTag = `</${tag}>`;
      const indent = indentOf(source, node.open.start);
      // The node moves one level deeper, so re-indent its own lines (its
      // multi-line text included) by one step.
      const nodeStart = node.open.start;
      const nodeEnd = node.close ? node.close.end : node.inner.end;
      const block = source.slice(nodeStart, nodeEnd);
      const childIndent = `${indent}  `;
      // Shift every following line by one indent step, preserving relative
      // nesting inside the node's own subtree.
      const step = childIndent.slice(indent.length);
      const shifted = block
        .split('\n')
        .map((line, index) => {
          if (!line.trim()) return line;
          // The first line starts at the tag, so it has no base indent yet.
          return index === 0 ? `${childIndent}${line.trimStart()}` : `${step}${line}`;
        })
        .join('\n');
      // Two edits: rewrite the node's own range (now indented one level) and
      // append the close tag after it. Splicing applies the later offset
      // first, so both stay valid.
      return [
        { start: nodeStart, end: nodeEnd, text: `${open}\n${shifted}` },
        { start: nodeEnd, end: nodeEnd, text: `\n${indent}${closeTag}` },
      ];
    }

    default:
      throw new StudioError('BAD_OP', `unknown html op "${op.op}"`);
  }
}

/* ------------------------------------------------------------ CSS ops */

function cssRuleFor(css, selector) {
  const wanted = selector.trim();
  const candidates = css.rules.filter((rule) => !rule.block && !rule.atRule);
  // Prefer an exact selector-list member match.
  const exact = candidates.find((rule) => rule.selector.split(',').some((part) => part.trim() === wanted));
  if (exact) return { rule: exact, member: exact.selector.split(',').find((part) => part.trim() === wanted).trim() };
  return null;
}

const INSERT_POSITIONS = new Set(['append', 'prepend', 'before', 'after']);

/** Properties the tool writes must be plain CSS identifiers. */
const PROPERTY_NAME = /^-{0,2}[A-Za-z][-\w]*$/;

function cssEdits(source, op, file) {
  if (op.op === 'setDecl' || op.op === 'removeDecl' || op.op === 'setDecls') {
    // An empty selector used to produce a ` { … }` block, and an empty
    // property a `: value;` line: both are valid-looking files that no
    // browser applies. Reject them at the edge instead of writing junk.
    if (typeof op.selector !== 'string' || op.selector.trim() === '') {
      throw new StudioError('BAD_SELECTOR', `a selector is required to write ${file}`);
    }
    if (op.op !== 'setDecls' && (typeof op.property !== 'string' || !PROPERTY_NAME.test(op.property))) {
      throw new StudioError('BAD_PROPERTY', `invalid CSS property "${op.property ?? ''}"`);
    }
  }
  const css = scanCss(source);
  if (css.problems.length) {
    throw new StudioError('SCAN_PROBLEMS', `${file} has CSS the editor cannot safely rewrite`, { problems: css.problems });
  }
  // `appendCss` carries no selector; resolve it after the early return below.
  const found = op.op === 'appendCss' ? null : cssRuleFor(css, op.selector);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';

  if (op.op === 'setDecl' || op.op === 'removeDecl') {
    const value = op.value === null || op.value === undefined ? null : String(op.value);
    if (op.op === 'setDecl' && (value === null || value.trim() === '')) {
      return cssEdits(source, { ...op, op: 'removeDecl' }, file);
    }
    if (!found) {
      if (op.op === 'removeDecl') return [];
      if (op.create === false) {
        throw new StudioError('NO_RULE', `no CSS rule matches ${op.selector} in ${file}`);
      }
      // Create a new rule at the end of the file.
      const trimmed = source.replace(/\s*$/, '');
      const body = `${op.property}: ${value};`;
      const block = `${trimmed}${trimmed ? newline + newline : ''}${op.selector} {${newline}  ${body}${newline}}${newline}`;
      return [{ final: true, text: block }];
    }
    const { rule } = found;
    const decl = rule.decls.find((entry) => entry.property === op.property.toLowerCase());
    if (op.op === 'removeDecl') {
      if (!decl) return [];
      const lineStart = source.lastIndexOf('\n', decl.start - 1) + 1;
      const lineEnd = source.indexOf('\n', decl.end);
      const ownLine = source.slice(lineStart, decl.start).trim() === '';
      if (ownLine && lineEnd !== -1) {
        const rest = source.slice(decl.end, lineEnd);
        if (/^\s*;?\s*$/.test(rest)) return [{ start: lineStart, end: lineEnd + 1, text: '' }];
      }
      const semicolon = source.indexOf(';', decl.end);
      const end = semicolon !== -1 && semicolon < rule.bodyEnd ? semicolon + 1 : decl.end;
      return [{ start: decl.start, end, text: '' }];
    }
    if (decl) {
      if (op.expect !== undefined && decl.value !== op.expect) {
        throw new StudioError('PRECONDITION', `${op.property} on ${op.selector} changed since it was loaded`, {
          expected: op.expect,
          actual: decl.value,
        });
      }
      // Keep the file's own separator spacing: minified sheets use
      // `prop:value`, hand-written ones use `prop: value`. Rewriting either
      // into the other leaks formatting noise into the diff.
      const raw = source.slice(decl.colon + 1, decl.valueEnd);
      const lead = raw.match(/^\s*/)?.[0] ?? '';
      const trail = raw.match(/\s*$/)?.[0] ?? '';
      return [{ start: decl.valueStart, end: decl.valueEnd, text: `${lead}${value}${trail}` }];
    }
    // `bodyEnd` sits on the closing brace. Most blocks already end the last
    // declaration with a newline; adding another would leave a blank line.
    const insertAt = rule.bodyEnd;
    // A single-line (minified) block gets an inline declaration; a multi-line
    // block gets an indented one. Never mix the two styles.
    const multiline = source.slice(rule.bodyStart, rule.bodyEnd).includes('\n');
    if (!multiline) {
      // Minified block: match the separator the existing declarations use, so
      // the new one does not stand out as `prop: value` among `prop:value`.
      // `valueStart` is `colon + 1` exactly when the sheet wrote `prop:value`.
      const first = rule.decls[0];
      const sep = first && first.valueStart > first.colon + 1 ? ' ' : '';
      const previous = source.slice(rule.bodyStart, rule.bodyEnd).trimEnd();
      const needsSemicolon = previous && !previous.endsWith(';');
      return [{
        start: insertAt,
        end: insertAt,
        text: `${needsSemicolon ? ';' : ''}${op.property}:${sep}${value};`,
      }];
    }
    const closingIndent = indentOf(source, rule.bodyEnd);
    const lead = insertAt > 0 && source[insertAt - 1] === '\n' ? '' : newline;
    return [{ start: insertAt, end: insertAt, text: `${lead}  ${op.property}: ${value};${newline}${closingIndent}` }];
  }

  if (op.op === 'appendCss') {
    if (typeof op.text !== 'string' || !op.text.trim()) throw new StudioError('BAD_OP', 'appendCss requires text');
    if (op.text.length > 40000) throw new StudioError('TOO_LARGE', 'appended CSS is too large');
    // Validate before appending: a bad block must not corrupt the stylesheet.
    const probe = scanCss(`${source}\n${op.text}`);
    const before = css.problems.length;
    if (probe.problems.length > before) {
      throw new StudioError('SCAN_PROBLEMS', 'the appended CSS is not well-formed', {
        problems: probe.problems.slice(before),
      });
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const trimmed = source.replace(/\s*$/, '');
    const body = op.text.replace(/\r?\n/g, newline).replace(/^\n+/, '');
    const text = trimmed ? `${trimmed}${newline}${body}` : body;
    return [{ final: true, text: text.endsWith(newline) ? text : `${text}${newline}` }];
  }

  if (op.op === 'setDecls') {
    const edits = [];
    for (const [property, value] of Object.entries(op.decls ?? {})) {
      edits.push(...cssEdits(source, { op: 'setDecl', selector: op.selector, property, value, create: op.create }, file));
    }
    return edits;
  }

  throw new StudioError('BAD_OP', `unknown css op "${op.op}"`);
}

/* ------------------------------------------------------------ batching */

/**
 * Loads a file, or synthesises an empty one when the op says `create`.
 *
 * A page with no `<link rel=stylesheet>` has no CSS file to receive a layout
 * edit. Refusing meant the editor could not style a bare page at all; creating
 * the file is what the user asked for when they moved a layout control.
 */
async function readOrCreate(root, rel, allowCreate) {
  try {
    return await readSource(root, rel);
  } catch (error) {
    if (error?.code !== 'MISSING') throw error;
    if (!allowCreate) throw error;
    if (fileKind(rel) !== 'css') {
      throw new StudioError('BAD_FILE', `the editor only creates stylesheets, not ${rel}`);
    }
    const { abs } = safeRelPath(root, rel);
    if (!existsSync(dirname(abs))) throw error;
    return {
      rel,
      text: '',
      bytes: Buffer.alloc(0),
      version: hashOf(''),
      eol: '\n',
      created: true,
    };
  }
}

function fileKind(rel) {
  if (rel.endsWith('.html')) return 'html';
  if (rel.endsWith('.css')) return 'css';
  throw new StudioError('BAD_FILE', `the editor only writes .html and .css files: ${rel}`);
}

/**
 * Computes the new contents for every touched file without writing anything.
 * @returns {Promise<{files: Map<string, {before: string, after: string, version: string, eol: string}>}>}
 */
export async function planEdits(root, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new StudioError('BAD_OP', 'no operations supplied');
  if (ops.length > MAX_OPS) throw new StudioError('TOO_MANY_OPS', `at most ${MAX_OPS} operations per save`);

  const touched = new Map();
  const order = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new StudioError('BAD_OP', 'each operation must be an object');
    if (typeof op.file !== 'string') throw new StudioError('BAD_OP', 'each operation needs a file');
    if (!touched.has(op.file)) {
      touched.set(op.file, await readOrCreate(root, op.file, op.createFile === true));
      order.push(op.file);
    }
  }

  // Verify versions up front so a stale client cannot half-apply.
  // A missing version means "this file may not exist yet" (`createFile`): there
  // is no on-disk state to be stale against.
  const versions = ops.filter((op) => op.version !== undefined && op.version !== null);
  for (const op of versions) {
    const entry = touched.get(op.file);
    if (entry.version !== op.version) {
      throw new StudioError('STALE_VERSION', `${op.file} changed on disk; reload before saving`, {
        file: op.file,
        expected: op.version,
        actual: entry.version,
      });
    }
  }

  const working = new Map(order.map((rel) => [rel, touched.get(rel).text]));

  // Node ids are structural index paths. If every op were applied to the
  // freshly edited text, the second op would address a shifted document.
  // So edits are computed against one stable snapshot per file and spliced
  // once. Ops that rewrite the whole file (moves) flush the batch first.
  for (const rel of order) {
    const kind = fileKind(rel);
    const base = working.get(rel);
    let tree = null;
    if (kind === 'html') {
      tree = scanHtml(base, { file: rel });
      if (tree.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', `${rel} has markup the editor cannot safely rewrite`, {
          problems: tree.problems,
        });
      }
    }
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      working.set(rel, spliceEdits(working.get(rel), pending));
      pending = [];
    };

    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index];
      if (op.file !== rel) continue;
      try {
        // CSS ops are text-level and address rules by selector, not by a
        // positional id, so each must see the previous op's result: a second
        // declaration for a rule the first op created otherwise computes
        // against a file that still lacks that rule and rewrites the block.
        if (kind === 'css') {
          flush();
          for (const edit of cssEdits(working.get(rel), op, rel)) {
            working.set(rel, edit.final ? edit.text : spliceEdits(working.get(rel), [edit]));
          }
          continue;
        }
        const edits = htmlEdits(base, tree, op, rel);
        if (edits.length === 1 && edits[0].final) {
          flush();
          working.set(rel, edits[0].text);
          continue;
        }
        pending.push(...edits);
      } catch (error) {
        if (error instanceof StudioError) error.detail = { ...error.detail, op: index, file: rel, opKind: op.op };
        throw error;
      }
    }
    flush();
  }

  // Post-verification: nothing may introduce new syntax problems.
  for (const rel of order) {
    const kind = fileKind(rel);
    const text = working.get(rel);
    if (kind === 'html') {
      const tree = scanHtml(text, { file: rel });
      const before = scanHtml(touched.get(rel).text, { file: rel });
      if (tree.problems.length > before.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', `${rel} would become invalid; nothing was written`, {
          problems: tree.problems,
          file: rel,
        });
      }
    } else {
      const css = scanCss(text);
      if (css.problems.length) {
        throw new StudioError('SCAN_PROBLEMS', `${rel} would become invalid CSS; nothing was written`, {
          problems: css.problems,
          file: rel,
        });
      }
    }
  }

  const files = new Map();
  for (const rel of order) {
    const entry = touched.get(rel);
    const after = working.get(rel);
    files.set(rel, {
      before: entry.text,
      after,
      version: entry.version,
      nextVersion: hashOf(after),
      eol: entry.eol,
      created: Boolean(entry.created),
    });
  }
  return { files };
}

/**
 * Line diff for the review panel: LCS-based, so an inserted declaration is
 * one `add` line instead of a delete-and-readd pair. `context` is the number
 * of unchanged lines kept around each hunk; runs are joined by `gap` markers.
 */
export function diffLines(before, after, context = 3) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // Trivial prefixes/suffixes keep the quadratic table small on big files.
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head += 1;
  let tailA = n;
  let tailB = m;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }

  const rows = tailA - head;
  const cols = tailB - head;
  // lcs[i][j] = LCS length of a[head+i..tailA) and b[head+j..tailB)
  const lcs = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[head + i] === b[head + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  for (let k = 0; k < head; k += 1) ops.push({ type: 'context', line: a[k], aLine: k + 1, bLine: k + 1 });
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && a[head + i] === b[head + j]) {
      ops.push({ type: 'context', line: a[head + i], aLine: head + i + 1, bLine: head + j + 1 });
      i += 1;
      j += 1;
    } else if (j >= cols || (i < rows && lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ type: 'del', line: a[head + i], aLine: head + i + 1 });
      i += 1;
    } else {
      ops.push({ type: 'add', line: b[head + j], bLine: head + j + 1 });
      j += 1;
    }
  }
  for (let k = 0; k < n - tailA; k += 1) {
    ops.push({ type: 'context', line: a[tailA + k], aLine: tailA + k + 1, bLine: tailB + k + 1 });
  }

  // Keep only changes plus `context` neighbours, with `gap` between hunks.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === 'context') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep[k] = true;
  });

  const out = [];
  let lastKept = -1;
  ops.forEach((op, index) => {
    if (!keep[index]) return;
    if (lastKept !== -1 && index > lastKept + 1) out.push({ type: 'gap' });
    out.push(op);
    lastKept = index;
  });
  return out;
}

/**
 * Writes the planned files atomically.
 * @param {Map<string, {after: string}>} files
 * @param {(rel: string, before: string, after: string) => Promise<void>} [snapshot] called before each write
 */
export async function commitEdits(root, files, snapshot) {
  const written = [];
  try {
    for (const [rel, entry] of files) {
      if (entry.before === entry.after) continue;
      const { abs } = safeRelPath(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      // A created file has nothing to vanish; everything else must still exist
      // so a deleted file is never silently resurrected.
      if (!entry.created) {
        await stat(abs).catch(() => {
          throw new StudioError('MISSING', `file vanished: ${rel}`);
        });
      }
      if (snapshot) await snapshot(rel, entry.before, entry.after);
      const temp = join(dirname(abs), `.${randomBytes(6).toString('hex')}.hf-tmp`);
      await writeFile(temp, entry.after, 'utf8');
      await rename(temp, abs);
      written.push(rel);
    }
  } catch (error) {
    // Restore anything already written so a failed batch is a no-op.
    for (const rel of written.reverse()) {
      try {
        const entry = files.get(rel);
        const { abs } = safeRelPath(root, rel);
        await writeFile(abs, entry.before, 'utf8');
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
  return written;
}

/** Full apply: plan → snapshot → atomic write. */
export async function applyEdits(root, ops, { snapshot } = {}) {
  const { files } = await planEdits(root, ops);
  const diff = Object.fromEntries([...files].map(([rel, entry]) => [rel, diffLines(entry.before, entry.after)]));
  const written = await commitEdits(root, files, snapshot);
  return {
    written,
    versions: Object.fromEntries([...files].map(([rel, entry]) => [rel, entry.nextVersion])),
    diff,
    files: [...files].map(([rel, entry]) => ({
      file: rel,
      version: entry.version,
      nextVersion: entry.nextVersion,
      changed: entry.before !== entry.after,
    })),
  };
}

export { escapeAttrValue, escapeText, spliceEdits, nodeHtml, selectorFor, parseSelector, matchesSelector };
