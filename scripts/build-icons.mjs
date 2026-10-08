import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const grid = readFileSync(new URL('assets/icon-grid.txt', root), 'utf8').trim().split(/\r?\n/);
if (grid.length !== 12 || grid.some(row => !/^[.#]{12}$/.test(row))) throw new Error('Expected a 12 x 12 icon grid');
const lit = (x, y, size) => grid[Math.floor(y * 12 / size)][Math.floor(x * 12 / size)] === '#';

// Hint the small Windows sizes on whole pixels. Larger frames are exact integer
// multiples, so Windows never receives a stretched 12-cell diagonal.
function desktopLit(x, y, size) {
  const base = size % 16 === 0 ? 16 : size % 20 === 0 ? 20 : 24;
  const scale = size / base;
  const padding = base === 16 ? 2 : 3;
  const extent = base - padding * 2;
  x = Math.floor(x / scale) - padding;
  y = Math.floor(y / scale) - padding;
  if (x < 0 || y < 0 || x >= extent || y >= extent) return false;
  const stroke = Math.round(extent / 6);
  const headStart = Math.round(extent / 3);
  return (y < stroke && x >= headStart)
    || (x >= extent - stroke && y < extent - headStart)
    || (x + y >= Math.round(extent * 10 / 12) && x + y < Math.round(extent * 13 / 12));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function png(size, pixel = lit) {
  const stride = Math.ceil(size / 8), raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (pixel(x, y, size)) raw[y * (stride + 1) + 1 + (x >> 3)] |= 1 << (7 - x % 8);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 1;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function dib(size) {
  const rgba = Buffer.alloc(size * size * 4), mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = ((size - y - 1) * size + x) * 4, value = desktopLit(x, y, size) ? 255 : 0;
    rgba.fill(value, offset, offset + 3); rgba[offset + 3] = 255;
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(rgba.length + mask.length, 20);
  return Buffer.concat([header, rgba, mask]);
}
const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const frames = sizes.map(size => size === 256 ? png(size, desktopLit) : dib(size));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const start = 6 + index * 16;
  directory[start] = directory[start + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, start + 4); directory.writeUInt16LE(size === 256 ? 1 : 32, start + 6);
  directory.writeUInt32LE(frames[index].length, start + 8); directory.writeUInt32LE(offset, start + 12);
  offset += frames[index].length;
});
const blocks = grid.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [`<rect x="${x * 2}" y="${y * 2}" width="2" height="2"/>`] : []));
writeFileSync(new URL('assets/icon.svg', root), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" shape-rendering="crispEdges"><rect width="24" height="24" fill="#000"/><g fill="#fff">${blocks.join('')}</g></svg>\n`);
writeFileSync(new URL('assets/icon-24.png', root), png(24));
const iconDirectory = new URL('apps/windows/desktop/assets/', root);
mkdirSync(fileURLToPath(iconDirectory), { recursive: true });
writeFileSync(new URL('Terminal-plus.ico', iconDirectory), Buffer.concat([directory, ...frames]));
console.log('Built shared 24 px icon and Windows ICO (16–256 px).');
