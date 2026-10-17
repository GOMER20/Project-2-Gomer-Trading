// Builds the redis-server binary the app ships with.
//
// It is compiled from source against an old deployment target so the app runs
// on every macOS version Electron supports, not just the one it was built on.
// The result is cached in desktop/.cache, so this only happens once.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://download.redis.io/redis-stable.tar.gz';
/** Matches the minimum macOS version of the Electron runtime and the bundled PostgreSQL. */
export const DEPLOYMENT_TARGET = '13.0';

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed:\n${(result.stderr ?? '').trim().split('\n').slice(-12).join('\n')}`);
}

/** Returns the path of a redis-server built for DEPLOYMENT_TARGET, compiling it on first use. */
export async function ensureRedis(log = console.log) {
  const cached = path.join(DESKTOP, '.cache', `redis-server-${process.arch}-macos${DEPLOYMENT_TARGET}`);
  if (fs.existsSync(cached)) return cached;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gomer-redis-'));
  try {
    log(`downloading Redis source from ${SOURCE_URL}`);
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    const tarball = path.join(work, 'redis.tar.gz');
    fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
    run('tar', ['-xzf', tarball, '-C', work, '--strip-components=1']);

    log(`compiling redis-server for macOS ${DEPLOYMENT_TARGET}+ (about a minute)`);
    run('make', ['-j', String(Math.max(2, os.cpus().length)), 'MALLOC=libc', 'BUILD_TLS=no', 'redis-server'], {
      cwd: path.join(work, 'src'),
      env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET },
    });

    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(path.join(work, 'src', 'redis-server'), cached);
    fs.chmodSync(cached, 0o755);
    return cached;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await ensureRedis());
}
