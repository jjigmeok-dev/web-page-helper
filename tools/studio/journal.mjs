/**
 * Journal: snapshots every write so edits can be undone without git.
 *
 *   .hf/backups/<undo-id>/<flat-file>.bak   previous contents
 *   .hf/journal.jsonl                       append-only log
 *
 * Each entry records the undo id, timestamp, label, and per-file hashes so
 * undo can verify it is restoring exactly what it replaced.
 */
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashOf, safeRelPath, StudioError } from './discover.mjs';

const JOURNAL_DIR = '.hf';
const BACKUP_DIR = '.hf/backups';
const JOURNAL_FILE = '.hf/journal.jsonl';
const MAX_ENTRIES = 50;

function undoId() {
  return `u-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function flatName(rel) {
  return rel.replaceAll('/', '__');
}

async function readJournal(root) {
  const file = join(root, JOURNAL_FILE);
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* ignore a torn line */
    }
  }
  return entries;
}

/**
 * Creates a snapshot directory for one save batch.
 * @returns {{ id: string, save: (rel: string, before: string, after: string) => Promise<void>, finish: (label: string) => Promise<void> }}
 */
export async function createSnapshot(root, label = 'edit') {
  const id = undoId();
  const dir = join(root, BACKUP_DIR, id);
  await mkdir(dir, { recursive: true });
  const files = [];
  let finished = false;

  return {
    id,
    async save(rel, before, after) {
      const { rel: normalized } = safeRelPath(root, rel);
      await writeFile(join(dir, flatName(normalized)), before, 'utf8');
      files.push({ file: normalized, before: hashOf(before), after: hashOf(after) });
    },
    async finish(reason = label) {
      if (finished) return;
      finished = true;
      await appendFile(
        join(root, JOURNAL_FILE),
        `${JSON.stringify({ id, at: new Date().toISOString(), label: reason, files })}\n`,
        'utf8',
      );
      await prune(root);
    },
    async discard() {
      finished = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Keeps the newest MAX_ENTRIES snapshots. */
async function prune(root) {
  const entries = await readJournal(root);
  const expired = entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES));
  if (!expired.length) return;
  for (const entry of expired) {
    await rm(join(root, BACKUP_DIR, entry.id), { recursive: true, force: true });
  }
  const keep = entries.slice(-MAX_ENTRIES);
  await writeFile(join(root, JOURNAL_FILE), keep.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
}

/** Most recent entries, newest first. */
export async function listSnapshots(root, limit = 20) {
  const entries = await readJournal(root);
  return entries
    .slice(-limit)
    .reverse()
    .map((entry) => ({ id: entry.id, at: entry.at, label: entry.label, files: entry.files.map((file) => file.file) }));
}

/**
 * Restores the snapshot with `id` (default: newest).
 * Refuses when a file changed after the edit that is being undone.
 */
export async function undo(root, id) {
  const entries = await readJournal(root);
  if (!entries.length) throw new StudioError('NO_UNDO', 'there is nothing to undo');
  const entry = id ? entries.find((candidate) => candidate.id === id) : entries[entries.length - 1];
  if (!entry) throw new StudioError('NO_UNDO', `no snapshot ${id}`);

  const dir = join(root, BACKUP_DIR, entry.id);
  const restored = [];
  const stale = [];

  for (const file of entry.files) {
    const { rel, abs } = safeRelPath(root, file.file);
    const backupPath = join(dir, flatName(rel));
    if (!existsSync(backupPath)) {
      stale.push({ file: rel, reason: 'backup is missing' });
      continue;
    }
    const before = await readFile(backupPath, 'utf8');
    const current = existsSync(abs) ? await readFile(abs, 'utf8') : null;
    if (current !== null && hashOf(current) !== file.after) {
      stale.push({ file: rel, reason: 'file changed after this edit' });
      continue;
    }
    restored.push({ rel, abs, before, current });
  }

  if (stale.length) {
    throw new StudioError('STALE_UNDO', 'some files changed after the edit; undo would lose work', { stale });
  }

  for (const item of restored) {
    await writeFile(item.abs, item.before, 'utf8');
  }

  // Drop the undone entry so repeated undo walks backwards.
  const remaining = entries.filter((candidate) => candidate.id !== entry.id);
  await writeFile(join(root, JOURNAL_FILE), remaining.map((candidate) => `${JSON.stringify(candidate)}\n`).join(''), 'utf8');
  await rm(dir, { recursive: true, force: true });

  return { id: entry.id, label: entry.label, restored: restored.map((item) => item.rel) };
}
