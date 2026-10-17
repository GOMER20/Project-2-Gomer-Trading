// Assembles everything the desktop app ships with into desktop/staging/,
// which electron-builder copies into the app's Contents/Resources:
//
//   server/     the backend, bundled into three self-contained scripts
//   web/        the interface, exported as static files
//   postgres/   PostgreSQL server binaries
//   redis/      redis-server
//   hft/        HFT, the order book engine the server runs beside itself
//   tunnel/     cloudflared and tailscale, for sharing on the internet
//
// Run from anywhere: `npm run stage -w desktop`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ensureHft } from '../../scripts/build-hft.mjs';
import { DEPLOYMENT_TARGET, ensureRedis } from './build-redis.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const STAGING = path.join(DESKTOP, 'staging');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const step = (message) => console.log(`\x1b[36mstage\x1b[0m ${message}`);
const megabytes = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return `${(total / 1024 / 1024).toFixed(0)} MB`;
};

function fail(message) {
  console.error(`\x1b[31mstage failed:\x1b[0m ${message}`);
  process.exit(1);
}

fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

// --- server ----------------------------------------------------------------
// One file per process, dependencies included, so the app carries no node_modules.
step('bundling the backend');
await build({
  absWorkingDir: BACKEND,
  entryPoints: { api: 'src/index.ts', worker: 'src/workers/leaderboard.worker.ts', seed: 'src/db/seed.ts', backup: 'src/db/backup.ts' },
  outdir: path.join(STAGING, 'server'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Optional native accelerators and the dev-only log formatter are never loaded in the app.
  external: ['pg-native', 'bufferutil', 'utf-8-validate', 'pino-pretty'],
  // Bundled CommonJS dependencies expect these Node globals, which ES modules do not have.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'warning',
});
fs.cpSync(path.join(BACKEND, 'db', 'migrations'), path.join(STAGING, 'server', 'migrations'), { recursive: true });

// --- web -------------------------------------------------------------------
step('exporting the interface');
const exported = spawnSync(NPM, ['run', 'build', '-w', 'frontend', '--silent'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, DESKTOP_BUILD: '1', NEXT_PUBLIC_DESKTOP: '1', NEXT_TELEMETRY_DISABLED: '1' },
});
if (exported.status !== 0) fail('the frontend build did not succeed (see the output above).');
const out = path.join(FRONTEND, 'out');
if (!fs.existsSync(path.join(out, 'index.html'))) fail(`expected a static export in ${out}.`);
fs.cpSync(out, path.join(STAGING, 'web'), { recursive: true });

// --- postgres --------------------------------------------------------------
step('copying PostgreSQL');
const postgres = path.join(ROOT, 'node_modules', '@embedded-postgres', `${process.platform}-${process.arch}`, 'native');
if (!fs.existsSync(path.join(postgres, 'bin', 'postgres'))) {
  fail(`PostgreSQL binaries not found at ${postgres}. Run \`npm install\` first.`);
}
for (const part of ['bin', 'lib', 'share']) {
  // verbatimSymlinks keeps the relative links between versioned libraries intact.
  fs.cpSync(path.join(postgres, part), path.join(STAGING, 'postgres', part), { recursive: true, verbatimSymlinks: true });
}

// --- redis -----------------------------------------------------------------
step('preparing Redis');
let redis;
try {
  redis = await ensureRedis((message) => step(`  ${message}`));
} catch (err) {
  // Offline or no compiler: fall back to the binary the dev environment built.
  // That one targets this machine's macOS version only.
  redis = path.join(ROOT, 'node_modules', '.cache', 'redis-memory-server', 'redis-binaries', 'stable', 'redis-server');
  if (!fs.existsSync(redis)) fail(`could not build Redis (${err.message}) and no dev binary exists. Run \`npm run services\` once, or fix the build.`);
  console.warn(`\x1b[33mstage warning:\x1b[0m could not build a portable Redis (${err.message.split('\n')[0]}). Using the dev binary; the app will only run on this macOS version or newer.`);
}
fs.mkdirSync(path.join(STAGING, 'redis'));
fs.copyFileSync(redis, path.join(STAGING, 'redis', 'redis-server'));
fs.chmodSync(path.join(STAGING, 'redis', 'redis-server'), 0o755);

// --- hft -------------------------------------------------------------------
// HFT is this project's own order book engine (hft/), compiled here for the
// same macOS versions and processor as the rest of the app. Without it the app
// still builds and trades; the Admin console reports that HFT is not installed.
step('compiling HFT, the order book engine');
try {
  const hft = ensureHft({ deploymentTarget: DEPLOYMENT_TARGET, arch: 'x86_64', log: (message) => step(`  ${message}`) });
  fs.mkdirSync(path.join(STAGING, 'hft'));
  fs.copyFileSync(hft, path.join(STAGING, 'hft', 'hft'));
  fs.chmodSync(path.join(STAGING, 'hft', 'hft'), 0o755);
} catch (err) {
  console.warn(`\x1b[33mstage warning:\x1b[0m ${err.message.split('\n')[0]} This build will run without HFT.`);
}

// --- tunnel ----------------------------------------------------------------
// Cloudflare's tunnel program powers "Share on the Internet". It is open source
// (Apache 2.0), so it ships inside the app with its licence beside it. Without
// it the app still builds; that one menu item reports that sharing is missing.
step('adding the internet sharing tunnel');
const cloudflared = [process.env.CLOUDFLARED_PATH, '/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'].find((candidate) => candidate && fs.existsSync(candidate));
if (cloudflared) {
  const binary = fs.realpathSync(cloudflared);
  fs.mkdirSync(path.join(STAGING, 'tunnel'));
  fs.copyFileSync(binary, path.join(STAGING, 'tunnel', 'cloudflared'));
  fs.chmodSync(path.join(STAGING, 'tunnel', 'cloudflared'), 0o755);
  const licence = path.join(path.dirname(binary), '..', 'LICENSE');
  if (fs.existsSync(licence)) fs.copyFileSync(licence, path.join(STAGING, 'tunnel', 'LICENSE-cloudflared.txt'));
} else {
  console.warn('\x1b[33mstage warning:\x1b[0m cloudflared is not installed (`brew install cloudflared`), so this build cannot share on the internet.');
}

// Tailscale's open-source client (BSD 3-clause) provides the permanent address.
const tailscaleBin = [process.env.TAILSCALE_DIR, '/usr/local/opt/tailscale/bin', '/opt/homebrew/opt/tailscale/bin'].find(
  (candidate) => candidate && fs.existsSync(path.join(candidate, 'tailscaled')) && fs.existsSync(path.join(candidate, 'tailscale')),
);
if (tailscaleBin) {
  fs.mkdirSync(path.join(STAGING, 'tunnel'), { recursive: true });
  for (const program of ['tailscale', 'tailscaled']) {
    fs.copyFileSync(fs.realpathSync(path.join(tailscaleBin, program)), path.join(STAGING, 'tunnel', program));
    fs.chmodSync(path.join(STAGING, 'tunnel', program), 0o755);
  }
  const licence = path.join(fs.realpathSync(tailscaleBin), '..', 'LICENSE');
  if (fs.existsSync(licence)) fs.copyFileSync(licence, path.join(STAGING, 'tunnel', 'LICENSE-tailscale.txt'));
} else {
  console.warn('\x1b[33mstage warning:\x1b[0m tailscale is not installed (`brew install tailscale`), so this build cannot offer a permanent address.');
}

// --- icon ------------------------------------------------------------------
if (!fs.existsSync(path.join(DESKTOP, 'build', 'icon.icns'))) {
  step('drawing the icon');
  const icon = spawnSync(process.execPath, [path.join(DESKTOP, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
  if (icon.status !== 0) fail('could not create the icon.');
}

for (const part of fs.readdirSync(STAGING)) step(`  ${part.padEnd(9)} ${megabytes(path.join(STAGING, part))}`);
step('done');
