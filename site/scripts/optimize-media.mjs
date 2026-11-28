/**
 * Generate right-sized, compressed site media from the checked-in originals.
 *
 * Run from site/:  node scripts/optimize-media.mjs
 *
 * Originals live in media-source/ (outside the deployed public/ tree); the
 * generated outputs are committed to public/ because the site is static.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const sourceDir = path.join(root, "media-source");

/** The 1152px candidate matches the desktop wall box exactly at 1x. */
const heroWidths = [768, 1024, 1152, 1280, 1440];
const hero = path.join(sourceDir, "tea-garden.webp");
const posterSources = [
  ["story-captions-poster.webp", "story-captions-poster-720.webp"],
  ["story-write-poster.webp", "story-write-poster-720.webp"],
];
const plant = path.join(publicDir, "reader/indigo-plant.webp");

async function write(output, buffer) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, buffer);
  console.log(`  ${path.relative(root, output)} ${(buffer.length / 1024).toFixed(1)} KiB`);
}

console.log("Hero wall:");
for (const width of heroWidths) {
  const resized = sharp(hero).resize({ width, withoutEnlargement: true });
  await write(
    path.join(publicDir, `reader/tea-garden-${width}.avif`),
    await resized.clone().avif({ quality: 38, effort: 6 }).toBuffer(),
  );
  await write(
    path.join(publicDir, `reader/tea-garden-${width}.webp`),
    await resized.clone().webp({ quality: 64, effort: 6 }).toBuffer(),
  );
}

console.log("Story posters:");
for (const [from, to] of posterSources) {
  const source = sharp(path.join(sourceDir, from));
  await write(
    path.join(publicDir, "media", to),
    await source.clone().webp({ quality: 72, effort: 6 }).toBuffer(),
  );
  const small = to.replace("-720.webp", "-512.webp");
  await write(
    path.join(publicDir, "media", small),
    await source.clone().resize({ width: 512 }).webp({ quality: 72, effort: 6 }).toBuffer(),
  );
}

console.log("Feature illustration:");
await write(
  path.join(publicDir, "reader/indigo-plant-320.webp"),
  await sharp(plant).resize({ width: 320 }).webp({ quality: 72, effort: 6 }).toBuffer(),
);
