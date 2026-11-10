#!/usr/bin/env node
/**
 * `./tools/quickstart.mjs` (or `hf-quickstart`) — open the studio on the IPv4
 * network in one step.
 *
 * The studio already knows how to bind (`hf studio --host`), mint a token for
 * a non-loopback bind, and print every reachable URL. This script only removes
 * the two things that make the first run slow:
 *
 *   - guessing a port, when 4174 is often taken by the previous run;
 *   - re-typing the flag dance and then hunting for the token in the output.
 *
 * It never starts its own HTTP server: it picks a free port, then hands off to
 * `tools/cli.mjs studio --host 0.0.0.0`. The CLI stays the single place that decides how
 * a network bind is secured, so the two can never drift.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '0.0.0.0';
const FIRST_PORT = 4174;

/** Every non-internal IPv4 address, so the summary shows what a phone can open. */
function ipv4Addresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out;
}

/** True when `port` on `host` can be bound right now. */
function isFree(port, host) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, host);
  });
}

/**
 * First free port at or after `from`. A busy port is the common case (the
 * previous studio is still running), and asking the user to resolve it is
 * worse than moving one number along.
 */
async function pickPort(from) {
  for (let port = from; port < from + 50; port += 1) {
    if (await isFree(port, HOST)) return port;
  }
  return null;
}

function parseArgs(argv) {
  const options = { root: process.cwd(), port: null, token: null, proxy: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--port' || arg === '-p') options.port = Number(next());
    else if (arg === '--root' || arg === '-r') options.root = resolve(next());
    else if (arg === '--token') options.token = next();
    else if (arg === '--proxy') options.proxy = next();
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else options.root = resolve(arg);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error('--port must be an integer 0-65535');
  }
  return options;
}

const HELP = `
quickstart — studio on the IPv4 network, one command

  ./tools/quickstart.mjs                 this directory, first free port from 4174
  ./tools/quickstart.mjs ~/my-site       another project
  ./tools/quickstart.mjs --port 5000     a specific port
  ./tools/quickstart.mjs --proxy http://127.0.0.1:8000

  hf-quickstart                          same thing after \`npm link\`
  npm run quickstart                     same thing through npm (no npm needed)

Binds 0.0.0.0, so the studio answers on every IPv4 interface and a phone on
the same network can open it. Any non-loopback bind requires a token; the CLI
generates one and prints the exact URLs, including the ?token= query.
Pass --token to pin it. Ctrl-C stops the server.
`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    console.error('  npm run quickstart -- --help');
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!existsSync(options.root)) {
    console.error(`✗ no such directory: ${options.root}`);
    process.exit(2);
  }

  const port = options.port ?? (await pickPort(FIRST_PORT));
  if (port === null) {
    console.error(`✗ no free port between ${FIRST_PORT} and ${FIRST_PORT + 49}`);
    process.exit(2);
  }

  const args = [join(ROOT, 'tools/cli.mjs'), 'studio', '--root', options.root, '--host', HOST, '--port', String(port)];
  if (options.token) args.push('--token', options.token);
  if (options.proxy) args.push('--proxy', options.proxy);

  const addresses = ipv4Addresses();
  console.log(`\x1b[36m·\x1b[0m quickstart ${options.root}`);
  console.log(`\x1b[36m·\x1b[0m binding ${HOST}:${port} (IPv4)`);
  if (addresses.length) {
    console.log(`\x1b[36m·\x1b[0m reachable from ${addresses.join(', ')}`);
  } else {
    console.log('\x1b[33m!\x1b[0m no external IPv4 interface found — only this machine can connect');
  }

  // Inherit stdio so the CLI's own URL/token lines stream through unchanged.
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: options.root });

  const forward = (signal) => child.kill(signal);
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 0 : (code ?? 0);
  });
  child.on('error', (error) => {
    console.error(`✗ could not start the studio: ${error.message}`);
    process.exitCode = 1;
  });
}

await main();
