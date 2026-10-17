// Compiles HFT, the matching engine in hft/src, into a program.
//
//   npm run hft:build     builds hft/bin/hft, which `npm run dev` and
//                         `npm run serve` start beside the trading server
//
// The desktop app's build calls ensureHft() itself, with a deployment target,
// so the copy it ships runs on every macOS version the app does. Builds are
// kept in hft/.cache under a name made from the sources, so nothing is
// compiled twice and a change to the sources is never missed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'hft', 'src');

/** A fingerprint of every source file, so a cached build is reused only for identical sources. */
function sourceFingerprint() {
  const hash = createHash('sha256');
  const files = fs
    .readdirSync(SOURCE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    hash.update(path.relative(SOURCE, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Returns the path of an HFT binary built from hft/src, compiling it on first
 * use. `deploymentTarget` is the oldest macOS it must run on, and `arch` the
 * processor to build for (`x86_64`, `arm64`); leave them out to build for
 * this machine only.
 */
export function ensureHft({ deploymentTarget, arch, log = console.log } = {}) {
  const name = `hft-${process.platform}-${arch ?? process.arch}-${deploymentTarget ? `macos${deploymentTarget}` : 'local'}-${sourceFingerprint()}`;
  const cached = path.join(ROOT, 'hft', '.cache', name);
  if (fs.existsSync(cached)) return cached;

  log('compiling HFT (about twenty seconds)');
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const partial = `${cached}.part`;
  const args = [
    '-std=c++20',
    '-O2',
    '-DNDEBUG',
    '-pthread',
    // No -march=native: the app is given to other people, whose processors differ.
    ...(deploymentTarget ? [`-mmacosx-version-min=${deploymentTarget}`] : []),
    ...(arch ? ['-arch', arch] : []),
    `-I${path.join(SOURCE, 'include')}`,
    `-I${SOURCE}`,
    path.join(SOURCE, 'hft', 'main.cpp'),
    '-o',
    partial,
  ];
  const result = spawnSync(process.env.CXX || 'c++', args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fs.rmSync(partial, { force: true });
    const detail = result.error ? result.error.message : (result.stderr ?? '').trim().split('\n').slice(-12).join('\n');
    throw new Error(`could not compile HFT. It needs a C++20 compiler (on a Mac: xcode-select --install).\n${detail}`);
  }
  fs.chmodSync(partial, 0o755);
  fs.renameSync(partial, cached);
  return cached;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const built = ensureHft({ log: (message) => console.log(`\x1b[36mhft\x1b[0m ${message}`) });
    const target = path.join(ROOT, 'hft', 'bin', 'hft');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(built, target);
    fs.chmodSync(target, 0o755);
    console.log(`\x1b[36mhft\x1b[0m ready at ${path.relative(ROOT, target)}`);
  } catch (err) {
    console.error(`\x1b[31mhft build failed:\x1b[0m ${err.message}`);
    process.exit(1);
  }
}
