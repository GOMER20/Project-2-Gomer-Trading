// One-command development environment:
//   1. creates .env from .env.example (with a freshly generated JWT secret)
//   2. starts local Postgres + Redis unless they are already running
//   3. applies migrations and seeds the demo data
//   4. runs the API, the leaderboard worker and the Next.js frontend together
//
// Usage: npm run dev            (Ctrl+C stops everything)

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isListening, startServices } from './dev-services.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const WEB_PORT = 3000;
const COLORS = { setup: 90, services: 35, api: 36, worker: 33, web: 32 };

const tag = (name) => `\x1b[${COLORS[name]}m${name.padEnd(8)}\x1b[0m`;
const log = (name, line) => console.log(`${tag(name)} ${line}`);

function ensureEnvFile() {
  const target = path.join(ROOT, '.env');
  if (fs.existsSync(target)) return;
  const template = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(target, template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`), { mode: 0o600 });
  log('setup', 'created .env from .env.example with a new JWT secret');
}

function pipeLines(stream, name) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) log(name, line);
  });
}

/** Runs an npm script to completion, streaming its output. */
function run(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(NPM, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    pipeLines(child.stdout, name);
    pipeLines(child.stderr, name);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited with code ${code}`))));
  });
}

const children = new Set();
let stopServices = async () => {};
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  log('setup', 'shutting down...');
  for (const child of children) {
    // Each child leads its own process group, so this reaches tsx/next grandchildren too.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await stopServices();
  process.exit(code);
}

/** Starts a long-running npm script. If any of them dies, the whole environment comes down. */
function start(name, args) {
  const child = spawn(NPM, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  children.add(child);
  pipeLines(child.stdout, name);
  pipeLines(child.stderr, name);
  child.on('exit', (code) => {
    children.delete(child);
    if (!shuttingDown) {
      log(name, `exited with code ${code}`);
      void shutdown(code ?? 1);
    }
  });
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    throw new Error('Dependencies are not installed. Run `npm install` first.');
  }
  ensureEnvFile();
  process.loadEnvFile(path.join(ROOT, '.env'));

  // Check before starting anything: a second copy would only crash on the ports.
  const apiPort = Number(process.env.API_PORT ?? 4000);
  const taken = [];
  if (await isListening(WEB_PORT)) taken.push(`${WEB_PORT} (web)`);
  if (await isListening(apiPort)) taken.push(`${apiPort} (API)`);
  if (taken.length) {
    log('setup', `\x1b[33m${taken.length > 1 ? 'Ports' : 'Port'} ${taken.join(' and ')} ${taken.length > 1 ? 'are' : 'is'} already in use.\x1b[0m`);
    log('setup', `Gomer Trading is probably already running: open http://localhost:${WEB_PORT}`);
    log('setup', 'To restart it, stop the other copy first (Ctrl+C in its terminal), then run this again.');
    process.exit(1);
  }

  stopServices = await startServices((line) => log('services', line));
  await run('setup', ['run', 'db:seed', '--silent']); // seed runs the migrations first

  start('api', ['run', 'dev', '-w', 'backend', '--silent']);
  start('worker', ['run', 'dev:worker', '-w', 'backend', '--silent']);
  start('web', ['run', 'dev', '-w', 'frontend', '--silent']);

  log('setup', '');
  log('setup', 'Trading terminal  http://localhost:3000');
  log('setup', `API               http://localhost:${process.env.API_PORT ?? 4000}`);
  log('setup', 'Demo logins are listed under "Seed data" in .env');
  log('setup', '');
} catch (err) {
  log('setup', `\x1b[31m${err.message}\x1b[0m`);
  await shutdown(1);
}
