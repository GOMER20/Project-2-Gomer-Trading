// Runs Gomer Trading as one server for many people: the interface, the API and
// the live feed all on a single address (http://<this machine>:4000 by default).
// Use this on a machine everyone can reach. The desktop app does the same job
// for people on one network.
//
//   npm run build:server     once, and again after every update
//   npm run serve
//
// Needs PostgreSQL and Redis (see DATABASE_URL / REDIS_URL in .env; `docker
// compose up -d` provides both) and, in .env, JWT_SECRET and SEED_ADMIN_PASSWORD.
// The first start creates the database tables and the admin account.
//
// It supervises its two processes: if the trading server or the leaderboard
// worker ever exits, it is started again, and every balance and resting order
// is rebuilt from the database.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'frontend', 'out');
const DIST = path.join(ROOT, 'backend', 'dist');
const MAX_RESTARTS_PER_MINUTE = 5;

const say = (line) => console.log(`[serve] ${line}`);
const fail = (line) => {
  console.error(`[serve] ${line}`);
  process.exit(1);
};

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // configuration can also come from the real environment
}
if (!fs.existsSync(path.join(DIST, 'index.js')) || !fs.existsSync(path.join(WEB, 'index.html'))) fail('Not built yet. Run `npm run build:server` first.');
if (!process.env.JWT_SECRET) fail('JWT_SECRET is not set. Put a long random value in .env (openssl rand -hex 48).');

// The engine's journal must outlive a reboot, so it is kept with the project rather than in a temporary folder.
const env = { ENGINE_JOURNAL: path.join(ROOT, 'backend', '.engine.journal'), ...process.env, NODE_ENV: 'production', STATIC_DIR: WEB };
const port = env.API_PORT ?? env.PORT ?? '4000';

/** Runs a script to completion. */
function once(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST, script)], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

const children = new Map();
const restarts = new Map();
let stopping = false;

/** Starts a long-running script and starts it again if it ever exits. */
function keepRunning(name, script) {
  const child = spawn(process.execPath, [path.join(DIST, script)], { env, stdio: 'inherit' });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    const recent = (restarts.get(name) ?? []).filter((at) => Date.now() - at < 60_000);
    if (recent.length >= MAX_RESTARTS_PER_MINUTE) fail(`${name} keeps stopping (exit ${code ?? signal}). Giving up; check the log above.`);
    restarts.set(name, [...recent, Date.now()]);
    say(`${name} stopped (exit ${code ?? signal}); starting it again`);
    setTimeout(() => !stopping && keepRunning(name, script), 1000);
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  say('stopping');
  for (const child of children.values()) child.kill('SIGTERM');
  const deadline = Date.now() + 12_000;
  while (children.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const child of children.values()) child.kill('SIGKILL');
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  await once('db/seed.js'); // creates or updates the tables, and the admin account on first start
} catch (err) {
  fail(`Could not prepare the database: ${err.message}`);
}
keepRunning('api', 'index.js');
keepRunning('worker', path.join('workers', 'leaderboard.worker.js'));

const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  .map((entry) => `http://${entry.address}:${port}`);
say(`Gomer Trading is starting on port ${port}`);
say(`  on this machine:   http://localhost:${port}`);
if (addresses.length) say(`  on your network:   ${addresses.join('  ')}`);
say('  from the internet: put it behind HTTPS (a reverse proxy or a tunnel); see the README');
