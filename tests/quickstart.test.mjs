import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools/quickstart.mjs');

/** Binds `port` so the quickstart has to move on to the next one. */
async function occupy(port) {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '0.0.0.0', done);
  });
  return server;
}

/** Runs the script, collecting output until it prints the studio URL. */
function run(args, { cwd = ROOT, timeout = 15000 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd });
    let out = '';
    let err = '';
    const finish = (code) => {
      child.kill('SIGTERM');
      done({ code, out, err });
    };
    child.stdout.on('data', (chunk) => {
      out += chunk;
      // Once the studio prints its URL the bind worked; stop the server.
      if (out.includes('/__studio')) setTimeout(() => finish(0), 250);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('exit', (code) => finish(code ?? 0));
    setTimeout(() => finish(124), timeout);
  });
}

async function project() {
  const base = await mkdtemp(join(tmpdir(), 'hf-quickstart-'));
  await writeFile(join(base, 'index.html'), '<!doctype html><html><body><p>hi</p></body></html>\n', 'utf8');
  return base;
}

test('quickstart binds IPv4 and prints the token URL', async () => {
  const base = await project();
  try {
    const { out } = await run(['--root', base, '--port', '0']);
    assert.match(out, /binding 0\.0\.0\.0:\d+ \(IPv4\)/, 'binds the IPv4 wildcard');
    assert.match(out, /reachable from \d+\.\d+\.\d+\.\d+/, 'reports IPv4 interfaces');
    assert.match(out, /studio http:\/\/0\.0\.0\.0:\d+\/__studio\?token=[0-9a-f]{32}/, 'prints a token URL');
    assert.match(out, /token required on every request/, 'says the bind is gated');
    assert.doesNotMatch(out, /127\.0\.0\.1/, 'does not claim a loopback-only bind');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('quickstart moves past a busy default port when none is given', async () => {
  const base = await project();
  // Occupy the default so auto-selection has to walk forward.
  const busy = await occupy(4174);
  try {
    const { out } = await run(['--root', base]);
    const used = Number(out.match(/binding 0\.0\.0\.0:(\d+)/)?.[1]);
    assert.ok(used > 4174, `moved past the busy default port (used ${used})`);
  } finally {
    await new Promise((done) => busy.close(done));
    await rm(base, { recursive: true, force: true });
  }
});

test('quickstart fails loudly when the requested port is taken', async () => {
  const base = await project();
  const busy = await occupy(46000);
  try {
    const { code, err } = await run(['--root', base, '--port', '46000']);
    // An explicit port is a promise: silently binding a different one would
    // leave the user opening the wrong URL.
    assert.notEqual(code, 0);
    assert.match(err, /EADDRINUSE|address already in use/i);
  } finally {
    await new Promise((done) => busy.close(done));
    await rm(base, { recursive: true, force: true });
  }
});

test('quickstart takes a project path and a pinned token', async () => {
  const base = await project();
  try {
    const { out } = await run([base, '--port', '0', '--token', 'pinned-token']);
    assert.match(out, new RegExp(`quickstart ${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'echoes the project');
    assert.match(out, /token=pinned-token/, 'uses the pinned token');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('quickstart rejects a missing directory and a bad port without starting', async () => {
  const missing = await run(['--root', join(tmpdir(), 'hf-does-not-exist-xyz'), '--port', '0']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such directory/);
  assert.doesNotMatch(missing.out, /__studio/, 'never binds');

  const badPort = await run(['--port', 'nope']);
  assert.equal(badPort.code, 2);
  assert.match(badPort.err, /--port must be an integer/);
});

test('quickstart prints help and exits without binding', async () => {
  const { code, out } = await run(['--help'], { timeout: 5000 });
  assert.equal(code, 0);
  assert.match(out, /npm run quickstart/);
  assert.doesNotMatch(out, /binding 0\.0\.0\.0/);
});
