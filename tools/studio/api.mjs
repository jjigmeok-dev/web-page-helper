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
import { discover, readSource, StudioError } from './discover.mjs';
import { profileProject } from './profile.mjs';

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

export function createApi(root) {
  const handlers = {
    async project() {
      const project = await discover(root);
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
      const profile = await profileProject(root);
      return { status: 200, body: { ok: true, ...profile } };
    },

    async page(query) {
      const model = await buildPageModel(root, pagePath(query.file));
      return { status: 200, body: { ok: true, ...model } };
    },

    async plan(body) {
      const { files } = await planEdits(root, body.ops);
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
      const snapshot = await createSnapshot(root, label);
      try {
        const result = await applyEdits(root, body.ops, {
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
      const result = await undo(root, body.id);
      return { status: 200, body: { ok: true, ...result } };
    },

    async history() {
      return { status: 200, body: { ok: true, snapshots: await listSnapshots(root) } };
    },

    async source(query) {
      const source = await readSource(root, pagePath(query.file));
      return {
        status: 200,
        body: { ok: true, file: source.rel, text: source.text, version: source.version, eol: source.eol },
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
