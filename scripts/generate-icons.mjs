import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'public', 'icon');
const SVG_PATH = join(ROOT, 'scripts', 'icon.svg');
const SIZES = [16, 32, 48, 128];
const DESIGN_SIZE = 128;
const SAMPLES_PER_AXIS = 6;

const COLORS = {
  background: [16, 24, 40],
  primary: [248, 250, 252],
  accent: [125, 211, 252],
};

const BACKGROUND = { x: 0, y: 0, width: 128, height: 128, radius: 26 };
const TOP_ARROW = {
  bar: { x1: 28, y1: 46, x2: 84, y2: 46, width: 11 },
  head: [
    [79, 33],
    [103, 46],
    [79, 59],
  ],
};
const BOTTOM_ARROW = {
  bar: { x1: 44, y1: 82, x2: 100, y2: 82, width: 11 },
  head: [
    [49, 69],
    [25, 82],
    [49, 95],
  ],
};

function isInsideRoundedRect(x, y, rect) {
  const maxX = rect.x + rect.width;
  const maxY = rect.y + rect.height;
  if (x < rect.x || x > maxX || y < rect.y || y > maxY) return false;

  const innerX = Math.min(Math.max(x, rect.x + rect.radius), maxX - rect.radius);
  const innerY = Math.min(Math.max(y, rect.y + rect.radius), maxY - rect.radius);
  const dx = x - innerX;
  const dy = y - innerY;
  return dx * dx + dy * dy <= rect.radius * rect.radius;
}

function isInsideCapsule(x, y, bar) {
  const dx = bar.x2 - bar.x1;
  const dy = bar.y2 - bar.y1;
  const lengthSquared = dx * dx + dy * dy;
  const projection = ((x - bar.x1) * dx + (y - bar.y1) * dy) / lengthSquared;
  const t = Math.min(Math.max(projection, 0), 1);
  const nearestX = bar.x1 + t * dx;
  const nearestY = bar.y1 + t * dy;
  const distanceX = x - nearestX;
  const distanceY = y - nearestY;
  const radius = bar.width / 2;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
}

function triangleSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function isInsideTriangle(x, y, triangle) {
  const [a, b, c] = triangle;
  const first = triangleSign(x, y, a[0], a[1], b[0], b[1]);
  const second = triangleSign(x, y, b[0], b[1], c[0], c[1]);
  const third = triangleSign(x, y, c[0], c[1], a[0], a[1]);
  const hasNegative = first < 0 || second < 0 || third < 0;
  const hasPositive = first > 0 || second > 0 || third > 0;
  return !(hasNegative && hasPositive);
}

function isInsideArrow(x, y, arrow) {
  return isInsideCapsule(x, y, arrow.bar) || isInsideTriangle(x, y, arrow.head);
}

function colorAt(x, y) {
  if (isInsideArrow(x, y, BOTTOM_ARROW)) return COLORS.accent;
  if (isInsideArrow(x, y, TOP_ARROW)) return COLORS.primary;
  if (isInsideRoundedRect(x, y, BACKGROUND)) return COLORS.background;
  return null;
}

function renderRgba(size) {
  const data = Buffer.alloc(size * size * 4);
  const scale = DESIGN_SIZE / size;
  const sampleCount = SAMPLES_PER_AXIS * SAMPLES_PER_AXIS;

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let sumRed = 0;
      let sumGreen = 0;
      let sumBlue = 0;
      let sumAlpha = 0;

      for (let sampleY = 0; sampleY < SAMPLES_PER_AXIS; sampleY += 1) {
        for (let sampleX = 0; sampleX < SAMPLES_PER_AXIS; sampleX += 1) {
          const x = (pixelX + (sampleX + 0.5) / SAMPLES_PER_AXIS) * scale;
          const y = (pixelY + (sampleY + 0.5) / SAMPLES_PER_AXIS) * scale;
          const color = colorAt(x, y);
          if (color === null) continue;

          sumRed += color[0];
          sumGreen += color[1];
          sumBlue += color[2];
          sumAlpha += 1;
        }
      }

      const offset = (pixelY * size + pixelX) * 4;
      if (sumAlpha === 0) continue;

      data[offset] = Math.round(sumRed / sumAlpha);
      data[offset + 1] = Math.round(sumGreen / sumAlpha);
      data[offset + 2] = Math.round(sumBlue / sumAlpha);
      data[offset + 3] = Math.round((sumAlpha / sampleCount) * 255);
    }
  }

  return data;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBytes = Buffer.from(type, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);

  return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * stride] = 0;
    rgba.copy(raw, row * stride + 1, row * size * 4, (row + 1) * size * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderSvg() {
  const topBar = TOP_ARROW.bar;
  const bottomBar = BOTTOM_ARROW.bar;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title">
  <title id="title">Sakutto</title>
  <rect width="128" height="128" rx="${BACKGROUND.radius}" fill="#101828"/>
  <g fill="none" stroke="#f8fafc" stroke-width="${topBar.width}" stroke-linecap="round">
    <path d="M${topBar.x1} ${topBar.y1}H${topBar.x2}"/>
  </g>
  <path d="M${TOP_ARROW.head[0][0]} ${TOP_ARROW.head[0][1]}L${TOP_ARROW.head[1][0]} ${TOP_ARROW.head[1][1]}L${TOP_ARROW.head[2][0]} ${TOP_ARROW.head[2][1]}Z" fill="#f8fafc"/>
  <g fill="none" stroke="#7dd3fc" stroke-width="${bottomBar.width}" stroke-linecap="round">
    <path d="M${bottomBar.x1} ${bottomBar.y1}H${bottomBar.x2}"/>
  </g>
  <path d="M${BOTTOM_ARROW.head[0][0]} ${BOTTOM_ARROW.head[0][1]}L${BOTTOM_ARROW.head[1][0]} ${BOTTOM_ARROW.head[1][1]}L${BOTTOM_ARROW.head[2][0]} ${BOTTOM_ARROW.head[2][1]}Z" fill="#7dd3fc"/>
</svg>
`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function assertPngSize(buffer, expectedSize) {
  const signatureMatches = PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
  if (!signatureMatches) throw new Error(`icon ${expectedSize}px is not a PNG file`);

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`icon ${expectedSize}px has unexpected dimensions ${width}x${height}`);
  }
}

await mkdir(OUTPUT_DIR, { recursive: true });

for (const size of SIZES) {
  const path = join(OUTPUT_DIR, `${size}.png`);
  await writeFile(path, encodePng(size, renderRgba(size)));
  assertPngSize(await readFile(path), size);
}

await writeFile(SVG_PATH, renderSvg(), 'utf8');
