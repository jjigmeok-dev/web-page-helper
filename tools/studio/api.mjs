/**
 * Studio API handlers. No HTTP types leak in or out, so every handler is
 * directly testable and the server stays a thin adapter.
 *
 *   GET  /api/project                 → project inventory
 *   GET  /api/profile                 → frontend profile (stack, pages, tokens, warnings)
 *   GET  /api/page?file=index.html    → page model (tree, styles, tokens)
 *   POST /api/plan                    → dry-run: diff without writing
 *   POST /api/apply                   → write files (atomic, journaled)
 *   POST /api/undo                    → restore the last snapshot
 *   GET  /api/history                 → recent snapshots
 */
import { applyEdits, planEdits, diffLines } from './edit.mjs';
import { createSnapshot, listSnapshots, undo } from './journal.mjs';
import { buildPageModel } from './model.mjs';
import { discover, pageList, readSource, StudioError } from './discover.mjs';
import { profileProject } from './profile.mjs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

function errorResponse(error) {
  if (error instanceof StudioError) {
    return {
      status: error.code === 'STALE_VERSION' || error.code === 'STALE_UNDO' ? 409 : 400,
      body: { ok: false, code: error.code, message: error.message, ...error.detail },
    };
  }
  return {
    status: 500,
    body: { ok: false, code: 'INTERNAL', message: String(error?.message ?? error) },
  };
}

/** Normalizes a page path; `?file=` may be absolute-looking (`/index.html`). */
function pagePath(input) {
  if (typeof input !== 'string' || !input) throw new StudioError('BAD_PATH', 'file is required');
  return input.replace(/^\/+/, '');
}

/* ---------------------------------------------------------- browse helpers */

/** Rejects anything that escapes the browse base, absolute or via `..`. */
function assertInside(base, target) {
  const root = resolve(base);
  const path = resolve(target);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new StudioError('OUT_OF_ROOT', `outside the browsable root: ${path}`);
  }
  return path;
}

/** Resolves a picker path; empty means "start at the base". */
function resolveBrowsePath(base, input) {
  const root = resolve(base);
  if (typeof input !== 'string' || !input.trim()) return root;
  return assertInside(root, isAbsolute(input) ? input : join(root, input));
}

/**
 * @param {string|(() => string)} root Project root, or a getter when the studio
 *   can switch projects without restarting (the server keeps one state object).
 * @param {{browseRoot?: () => string, state?: object}} [options]
 */
export function createApi(root, { browseRoot = null, state = null } = {}) {
  // Resolved per call, never captured: a project switch must affect every
  // handler without rebuilding the API.
  const dir = () => (typeof root === 'function' ? root() : root);
  const handlers = {
    async project() {
      const project = await discover(dir());
      return {
        status: 200,
        body: {
          ok: true,
          root: project.root,
          pages: project.pages,
          styles: project.styles,
          scripts: project.scripts,
          assets: project.assets,
          components: project.components,
          foundations: project.foundations,
        },
      };
    },

    /** Full frontend profile: what the project is made of, and what blocks editing. */
    async profile() {
      const profile = await profileProject(dir());
      return { status: 200, body: { ok: true, ...profile } };
    },

    async page(query) {
      const model = await buildPageModel(dir(), pagePath(query.file));
      return { status: 200, body: { ok: true, ...model } };
    },

    async plan(body) {
      const { files } = await planEdits(dir(), body.ops);
      return {
        status: 200,
        body: {
          ok: true,
          files: [...files].map(([rel, entry]) => ({
            file: rel,
            version: entry.version,
            nextVersion: entry.nextVersion,
            changed: entry.before !== entry.after,
            diff: diffLines(entry.before, entry.after),
          })),
        },
      };
    },

    async apply(body) {
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : 'edit';
      const snapshot = await createSnapshot(dir(), label);
      try {
        const result = await applyEdits(dir(), body.ops, {
          snapshot: (rel, before, after) => snapshot.save(rel, before, after),
        });
        await snapshot.finish(label);
        return {
          status: 200,
          body: {
            ok: true,
            written: result.written,
            versions: result.versions,
            files: result.files,
            diff: result.diff,
            undo: snapshot.id,
          },
        };
      } catch (error) {
        await snapshot.discard();
        throw error;
      }
    },

    async undo(body) {
      const result = await undo(dir(), body.id);
      return { status: 200, body: { ok: true, ...result } };
    },

    async history() {
      return { status: 200, body: { ok: true, snapshots: await listSnapshots(dir()) } };
    },

    async source(query) {
      const source = await readSource(dir(), pagePath(query.file));
      return {
        status: 200,
        body: { ok: true, file: source.rel, text: source.text, version: source.version, eol: source.eol },
      };
    },

    /**
     * Lists one directory level for the folder picker.
     *
     * Confined to `browseRoot`: a directory listing of the whole filesystem
     * would let anyone who can reach the studio read the machine's layout, and
     * `open` would then be a way to point the editor anywhere.
     */
    async browse(query) {
      const base = browseRoot ? browseRoot() : join(dir(), '..');
      const target = resolveBrowsePath(base, query.dir);
      const entries = await readdir(target, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
      return {
        status: 200,
        body: {
          ok: true,
          path: target,
          base: resolve(base),
          parent: target === resolve(base) ? null : dirname(target),
          // A folder is openable when it holds an HTML page the studio can edit.
          openable: files.some((entry) => entry.name.endsWith('.html')),
          pages: files.filter((entry) => entry.name.endsWith('.html')).map((entry) => entry.name).sort(),
          dirs,
        },
      };
    },

    /** Switches the live project root. Returns the new inventory. */
    async open(body) {
      if (!state) throw new StudioError('NOT_SUPPORTED', 'this server cannot switch projects');
      const base = browseRoot ? browseRoot() : join(dir(), '..');
      const target = resolveBrowsePath(base, body.dir);
      const stats = await stat(target).catch(() => null);
      if (!stats?.isDirectory()) throw new StudioError('NOT_A_DIR', `not a directory: ${target}`);
      // The picker must not be able to point the editor at an arbitrary path.
      assertInside(resolve(base), target);
      const pages = await pageList(target);
      if (!pages.length) throw new StudioError('NO_PAGES', `no .html files in ${target}`);
      state.root = target;
      const project = await discover(target);
      return {
        status: 200,
        body: {
          ok: true,
          root: project.root,
          pages: project.pages,
          styles: project.styles,
          components: project.components,
          foundations: project.foundations,
        },
      };
    },
  };

  /**
   * @param {string} action handler name
   * @param {{query?: object, body?: object}} request
   */
  async function handle(action, { query = {}, body = {} } = {}) {
    const handler = handlers[action];
    if (!handler) return { status: 404, body: { ok: false, code: 'NO_ROUTE', message: `unknown action ${action}` } };
    try {
      return await handler({ ...query, ...body });
    } catch (error) {
      return errorResponse(error);
    }
  }

  return { handle, actions: Object.keys(handlers) };
}

export { StudioError };
