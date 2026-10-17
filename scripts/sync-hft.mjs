// Copies HFT's sources from the engine's own repository into hft/src.
//
//   npm run hft:sync [-- path/to/Project-1-Low-Latency-Order-Book]
//
// The engine is developed and tested there (several hundred tests, sanitizers,
// CI). This project carries a copy so that it builds on its own.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.resolve(process.argv[2] ?? path.join(ROOT, '..', 'Project 1'));
const to = path.join(ROOT, 'hft', 'src');

if (!fs.existsSync(path.join(from, 'hft', 'main.cpp')) || !fs.existsSync(path.join(from, 'include', 'lob'))) {
  console.error(`No HFT sources at ${from}. Pass the path of the engine's repository.`);
  process.exit(1);
}

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(path.join(to, 'hft'), { recursive: true });
fs.cpSync(path.join(from, 'include', 'lob'), path.join(to, 'include', 'lob'), { recursive: true });
for (const name of fs.readdirSync(path.join(from, 'hft'))) {
  if (name.endsWith('.hpp') || name.endsWith('.cpp')) fs.copyFileSync(path.join(from, 'hft', name), path.join(to, 'hft', name));
}

let version = 'unknown';
try {
  version = execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['-C', from, 'status', '--porcelain', '--', 'include', 'hft'], { encoding: 'utf8' }).trim()) version += ' (with uncommitted changes)';
} catch {
  // not a git checkout
}
fs.writeFileSync(path.join(ROOT, 'hft', 'VERSION'), `${version}\n`);
console.log(`\x1b[36mhft\x1b[0m sources copied from ${from} at ${version}. Now run: npm run hft:build`);
