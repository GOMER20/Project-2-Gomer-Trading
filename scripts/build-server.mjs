// Builds the single-address server: the compiled backend plus the interface
// exported as static files, which the API then serves itself.
//
//   npm run build:server   then   npm run serve

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, args, env = {}) {
  console.log(`\x1b[36mbuild\x1b[0m ${label}`);
  const result = spawnSync(NPM, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('compiling the backend', ['run', 'build', '-w', 'backend', '--silent']);
// HFT, the order book engine the server runs beside itself. The server works without it,
// so a machine with no C++ compiler still gets a build.
console.log('\x1b[36mbuild\x1b[0m compiling HFT');
if (spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-hft.mjs')], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
  console.warn('\x1b[33mbuild warning:\x1b[0m HFT was not built. The server will run without it.');
}
// These two switches produce a static export that talks to whatever address served it,
// so the same build works on localhost, a LAN address or a public domain, http or https.
run('exporting the interface', ['run', 'build', '-w', 'frontend', '--silent'], { DESKTOP_BUILD: '1', NEXT_PUBLIC_DESKTOP: '1', NEXT_TELEMETRY_DISABLED: '1' });
console.log('\x1b[36mbuild\x1b[0m done. Start it with: npm run serve');
