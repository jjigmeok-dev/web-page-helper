/**
 * Project registry.
 *
 * A registry entry is the promise "this directory is a frontend I edit often".
 * It lives outside the project (`~/.hf/projects.json`) so registering a
 * directory never writes into it — a user pointing the tool at somebody's
 * repository should not find a stray config file afterwards.
 *
 * Each entry records the resolved absolute root plus the last profile summary,
 * so `hf projects` can list what it knows without re-scanning every project.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const REGISTRY_ENV = 'HF_HOME';

/** `~/.hf` by default; `HF_HOME` lets tests keep their registry isolated. */
export function registryDir() {
  const override = process.env[REGISTRY_ENV];
  return override ? resolve(override) : join(homedir(), '.hf');
}

export function registryFile() {
  return join(registryDir(), 'projects.json');
}

/** A stable, readable id: the directory name, de-duplicated by path hash. */
function idFor(root) {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  let hash = 0;
  for (let i = 0; i < root.length; i += 1) hash = (hash * 31 + root.charCodeAt(i)) >>> 0;
  return `${slug}-${hash.toString(36).slice(0, 6)}`;
}

async function readRegistry() {
  const file = registryFile();
  if (!existsSync(file)) return { version: 1, projects: [] };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`the project registry is not valid JSON (${file}): ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.projects)) return { version: 1, projects: [] };
  return { version: 1, ...parsed };
}

async function writeRegistry(registry) {
  const dir = registryDir();
  await mkdir(dir, { recursive: true });
  const file = registryFile();
  // Write-then-rename: a crash mid-write must not lose every registration.
  const temp = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify({ version: 1, ...registry }, null, 2)}\n`;
  await writeFile(temp, body, 'utf8');
  await rename(temp, file);
  return file;
}

/**
 * Registers (or refreshes) a project root.
 * @param {string} input directory to register
 * @param {{name?: string, profile?: object}} [meta]
 */
export async function addProject(input, meta = {}) {
  const root = resolve(input);
  const registry = await readRegistry();
  const existing = registry.projects.find((entry) => entry.root === root);
  const now = new Date().toISOString();
  const entry = {
    id: existing?.id ?? idFor(root),
    root,
    name: meta.name ?? existing?.name ?? basename(root),
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    ...(meta.profile ? { profile: meta.profile } : existing?.profile ? { profile: existing.profile } : {}),
  };
  registry.projects = existing
    ? registry.projects.map((candidate) => (candidate.root === root ? entry : candidate))
    : [...registry.projects, entry];
  await writeRegistry(registry);
  return entry;
}

/** Finds a project by id, absolute path, or name. */
export async function findProject(reference) {
  const registry = await readRegistry();
  if (!reference) return null;
  const target = resolve(reference);
  return (
    registry.projects.find((entry) => entry.id === reference) ??
    registry.projects.find((entry) => entry.root === target) ??
    registry.projects.find((entry) => entry.name === reference) ??
    null
  );
}

export async function listProjects() {
  const registry = await readRegistry();
  return [...registry.projects].sort((a, b) => a.name.localeCompare(b.name));
}

/** Removes a registration. Returns the removed entry, or null. */
export async function removeProject(reference) {
  const registry = await readRegistry();
  const target = resolve(reference);
  const found =
    registry.projects.find((entry) => entry.id === reference) ??
    registry.projects.find((entry) => entry.root === target) ??
    registry.projects.find((entry) => entry.name === reference);
  if (!found) return null;
  registry.projects = registry.projects.filter((entry) => entry.id !== found.id);
  await writeRegistry(registry);
  return found;
}

/** Stores the latest profile summary on an entry (called after a scan). */
export async function recordProfile(reference, profile) {
  return addProject(reference, { profile });
}
