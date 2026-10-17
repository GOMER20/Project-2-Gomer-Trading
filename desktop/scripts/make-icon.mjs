// Draws the Gomer Trading app icon (amber rounded tile, dark "GT") and writes
// build/icon.png (1024px) and build/icon.icns. No image libraries needed:
// the shapes are rasterised here and the .icns is assembled by macOS tools.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZE = 1024;
const SAMPLES = 4; // 4x4 supersampling per pixel

const CENTER = SIZE / 2;
// macOS icons sit inside a margin; the tile is a superellipse ("squircle").
const TILE_RADIUS = 412;
const TILE_EXPONENT = 5;
// The monogram "GT", two letters of equal height centred on the tile.
const CAP_HEIGHT = 300;
const STROKE = 60;
const BASELINE = CENTER + CAP_HEIGHT / 2;
const CAP_TOP = CENTER - CAP_HEIGHT / 2;
// G: a ring open at the upper right, plus a crossbar.
const G = { x: 363, outer: CAP_HEIGHT / 2, inner: CAP_HEIGHT / 2 - STROKE, gapDegrees: 42 };
// T: a top bar and a stem.
const T = { left: 562, right: 814 };

const TOP = [248, 198, 74];
const BOTTOM = [232, 160, 18];
const INK = [8, 11, 15];

function inTile(x, y) {
  const dx = Math.abs(x - CENTER) / TILE_RADIUS;
  const dy = Math.abs(y - CENTER) / TILE_RADIUS;
  return dx ** TILE_EXPONENT + dy ** TILE_EXPONENT <= 1;
}

function inG(x, y) {
  const dx = x - G.x;
  const dy = y - CENTER;
  const distance = Math.hypot(dx, dy);
  if (distance > G.outer) return false;
  // The crossbar runs from just right of centre out to the ring's edge.
  if (dx >= 10 && dy >= -2 && dy <= STROKE - 2) return true;
  if (distance < G.inner) return false;
  // Screen y grows downward, so negate it to get a conventional angle.
  const degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return !(degrees > 0 && degrees < G.gapDegrees);
}

function inT(x, y) {
  if (x < T.left || x > T.right || y < CAP_TOP || y > BASELINE) return false;
  const stem = (T.left + T.right) / 2;
  return y <= CAP_TOP + STROKE || Math.abs(x - stem) <= STROKE / 2;
}

const inLetter = (x, y) => inG(x, y) || inT(x, y);

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) {
    const shade = py / (SIZE - 1);
    const background = TOP.map((c, i) => c + (BOTTOM[i] - c) * shade);
    for (let px = 0; px < SIZE; px++) {
      let tile = 0;
      let letter = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          if (!inTile(x, y)) continue;
          tile++;
          if (inLetter(x, y)) letter++;
        }
      }
      if (tile === 0) continue;
      const mix = letter / tile;
      const offset = (py * SIZE + px) * 4;
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(background[c] * (1 - mix) + INK[c] * mix);
      pixels[offset + 3] = Math.round((tile / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

function png(pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(BUILD_DIR, { recursive: true });
const master = path.join(BUILD_DIR, 'icon.png');
fs.writeFileSync(master, png(render()));

const iconset = path.join(BUILD_DIR, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const points of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = points * scale;
    const name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(pixels), String(pixels), master, '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD_DIR, 'icon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`icon written to ${path.relative(process.cwd(), BUILD_DIR)}/icon.{png,icns}`);
