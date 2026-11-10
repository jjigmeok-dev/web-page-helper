/**
 * run-web.sh — the bash entry point for a network (IPv4) studio bind.
 *
 * The script is a thin wrapper: it picks a free port, reports the reachable
 * IPv4 addresses, and execs `tools/cli.mjs studio --host 0.0.0.0`. These tests
 * cover the wrapper's own decisions, not the server (see studio.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../run-web.sh', import.meta.url).pathname;

function sh(args, options = {}) {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, ...args], { timeout: 15_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** The CLI colors its banner; assertions read the plain text. */
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Starts the script and resolves its stdout once the studio reports a URL. */
function runStudio(args, root) {
  const child = spawn('bash', [SCRIPT, ...args], { cwd: root });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no studio url; stdout so far:\n${plain(out)}`));
    }, 20_000);
    const onData = (chunk) => {
      out += String(chunk);
      const text = plain(out);
      const match = text.match(/studio http:\/\/([^/\s]+)\/__studio(\?token=(\S+))?/);
      // The project line prints after the URL; wait for it so callers can
      // assert on the whole startup banner.
      if (!match || !/· project /.test(text)) return;
      clearTimeout(timer);
      resolve({ child, host: match[1], token: match[3] ?? null, stdout: text, stop: () => child.kill('SIGKILL') });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
}

test('run-web.sh --help prints usage and exits without binding', async () => {
  const { code, stdout } = await sh(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /run-web\.sh/);
  assert.match(stdout, /0\.0\.0\.0/);
  assert.doesNotMatch(stdout, /set -euo/, 'the shebang body must not leak into the help');
});

test('run-web.sh rejects an unknown flag with exit 2', async () => {
  const { code, stderr } = await sh(['--nope']);
  assert.equal(code, 2);
  assert.match(stderr, /알 수 없는 옵션/);
});

test('run-web.sh binds 0.0.0.0, prints the lan addresses and requires the token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-web-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>web</title><p>hi');
  const studio = await runStudio([], root);
  try {
    assert.match(studio.host, /^0\.0\.0\.0:/, 'the script must bind the IPv4 wildcard');
    assert.match(studio.stdout, /접속 가능/, 'reachable addresses are listed before the server starts');
    assert.ok(studio.token, 'a network bind must generate a token');

    const port = studio.host.split(':')[1];
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/__studio`);
    assert.equal(unauthenticated.status, 401, 'the network bind is token-gated');

    const authenticated = await fetch(`http://127.0.0.1:${port}/__studio?token=${studio.token}`);
    assert.equal(authenticated.status, 200, 'the printed token opens the editor');
  } finally {
    studio.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('run-web.sh forwards --port and pins --token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-web-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>web</title>');
  const studio = await runStudio(['-p', '4523', '-t', 'fixed-token'], root);
  try {
    assert.equal(studio.host, '0.0.0.0:4523');
    assert.equal(studio.token, 'fixed-token');
  } finally {
    studio.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('run-web.sh moves to the next free port when the default is busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-web-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>web</title>');
  const blocker = createServer(() => {});
  await new Promise((resolve) => blocker.listen(4174, '0.0.0.0', resolve));
  const studio = await runStudio([], root);
  try {
    assert.equal(studio.host, '0.0.0.0:4175', 'a busy 4174 must not abort the run');
  } finally {
    studio.stop();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('run-web.sh passes a project directory through as --root', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'hf-web-'));
  const project = join(outer, 'site');
  await mkdir(project);
  await writeFile(join(project, 'index.html'), '<!doctype html><title>site</title>');
  const studio = await runStudio([project], outer);
  try {
    assert.match(studio.stdout, new RegExp(`project ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    studio.stop();
    await rm(outer, { recursive: true, force: true });
  }
});

test('run-web.sh stops before binding when the project directory is missing', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'hf-web-'));
  try {
    const { code, stderr } = await sh([join(outer, 'missing')]);
    assert.equal(code, 1, 'a missing directory is an error, not a silent bind');
    assert.match(stderr, /no such directory/);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});
