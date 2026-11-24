import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BenchPoint {
  readonly x: number;
  readonly y: number;
}
export type BenchQuad = readonly [BenchPoint, BenchPoint, BenchPoint, BenchPoint];
export interface FixtureLine {
  readonly id: string;
  readonly text: string;
  readonly quad: BenchQuad;
}
export interface OcrFixture {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: 'horizontal' | 'vertical';
  readonly lines: readonly FixtureLine[];
  readonly svg: string;
}
interface LineSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  width?: number;
  height?: number;
  vertical?: boolean;
  color?: string;
  weight?: number;
}

export const FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../../bench/ocr/fixtures/', import.meta.url),
);
export const FIXTURE_MANIFEST = join(FIXTURE_DIRECTORY, 'manifest.json');
const FONT = 'Inter, Arial, Droid Sans Fallback, WenQuanYi Micro Hei, sans-serif';
const esc = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const rect = (x: number, y: number, width: number, height: number): BenchQuad => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];
function rotateQuad(quad: BenchQuad, degrees: number, cx: number, cy: number): BenchQuad {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return quad.map((point) => {
    const x = point.x - cx;
    const y = point.y - cy;
    return { x: cx + x * cos - y * sin, y: cy + x * sin + y * cos };
  }) as unknown as BenchQuad;
}
function makeFixture(
  id: string,
  title: string,
  width: number,
  height: number,
  specs: readonly LineSpec[],
  decorations: string[] = [],
  rotation = 0,
): OcrFixture {
  const orientation =
    specs.filter((line) => line.vertical).length * 2 >= specs.length ? 'vertical' : 'horizontal';
  const lines: FixtureLine[] = [];
  const texts: string[] = [];
  specs.forEach((line, index) => {
    const textWidth =
      line.width ?? Math.max(line.size * 2, Array.from(line.text).length * line.size * 0.62);
    let quad = line.vertical
      ? rect(
          line.x - line.size * 0.7,
          line.y - 4,
          line.size * 1.4,
          (line.height ?? Array.from(line.text).length * line.size) + 8,
        )
      : rect(line.x - 5, line.y - line.size, textWidth + 10, line.size * 1.3);
    if (rotation) quad = rotateQuad(quad, rotation, width / 2, height / 2);
    lines.push({ id: 'line-' + String(index + 1).padStart(2, '0'), text: line.text, quad });
    const vertical = line.vertical ? ' writing-mode="vertical-rl" text-orientation="upright"' : '';
    const textLength =
      !line.vertical && line.width
        ? ' textLength="' + line.width + '" lengthAdjust="spacingAndGlyphs"'
        : '';
    texts.push(
      '<text x="' +
        line.x +
        '" y="' +
        line.y +
        '" font-size="' +
        line.size +
        '" font-weight="' +
        (line.weight ?? 400) +
        '" fill="' +
        (line.color ?? '#17202a') +
        '"' +
        vertical +
        textLength +
        '>' +
        esc(line.text) +
        '</text>',
    );
  });
  const transform = rotation
    ? ' transform="rotate(' + rotation + ' ' + width / 2 + ' ' + height / 2 + ')"'
    : '';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '">\n' +
    '<rect width="100%" height="100%" fill="#ffffff"/>\n<g font-family="' +
    FONT +
    '"\n' +
    transform +
    '>\n' +
    decorations.join('\n') +
    '\n' +
    texts.join('\n') +
    '\n</g>\n</svg>\n';
  return { id, title, width, height, orientation, lines, svg };
}

export const OCR_FIXTURES: readonly OcrFixture[] = [
  makeFixture(
    'en-scan',
    'English scan',
    900,
    650,
    [
      { text: 'LOCAL TRANSLATION NOTES', x: 80, y: 90, size: 30, width: 405, weight: 700 },
      { text: 'A private tool for every reader.', x: 80, y: 150, size: 27, width: 410 },
      { text: 'Open a page and choose a language.', x: 80, y: 205, size: 27, width: 460 },
      { text: 'The text stays on this device.', x: 80, y: 260, size: 27, width: 390 },
      { text: 'No account is required.', x: 80, y: 315, size: 27, width: 310 },
      { text: 'Version 2.4  March 2026', x: 80, y: 385, size: 25, width: 340 },
      { text: 'Please keep this receipt.', x: 80, y: 440, size: 27, width: 340 },
    ],
    [
      '<rect x="45" y="40" width="790" height="540" rx="4" fill="none" stroke="#a8adb3" stroke-width="2"/>',
    ],
  ),
  makeFixture('ja-horizontal', 'Japanese horizontal document', 900, 650, [
    { text: 'ローカル翻訳のご案内', x: 85, y: 100, size: 34 },
    { text: 'この文章は端末の中で処理します。', x: 85, y: 175, size: 30 },
    { text: '翻訳する言語を選んでください。', x: 85, y: 245, size: 30 },
    { text: '画像から文字を読み取ります。', x: 85, y: 315, size: 30 },
    { text: '結果を確認してから共有できます。', x: 85, y: 385, size: 30 },
    { text: '静かな場所でも利用できます。', x: 85, y: 455, size: 30 },
  ]),
  makeFixture(
    'ja-vertical',
    'Japanese vertical document',
    900,
    650,
    [
      { text: '地域の声を未来へつなぐ', x: 760, y: 70, size: 34, vertical: true },
      { text: '小さな発見を記録する', x: 620, y: 90, size: 34, vertical: true },
      { text: '言葉の意味を確かめる', x: 480, y: 70, size: 34, vertical: true },
      { text: '新しい翻訳を試す', x: 340, y: 110, size: 34, vertical: true },
      { text: '毎日の読書を支える', x: 200, y: 80, size: 34, vertical: true },
    ],
    ['<line x1="820" y1="40" x2="820" y2="590" stroke="#bb3333" stroke-width="3"/>'],
  ),
  makeFixture(
    'slides',
    'Presentation slide',
    1000,
    700,
    [
      {
        text: 'DESIGN FOR EVERYONE',
        x: 80,
        y: 105,
        size: 42,
        width: 570,
        color: '#ffffff',
        weight: 700,
      },
      { text: 'Fast, local, accessible', x: 85, y: 205, size: 34, width: 400, color: '#ffffff' },
      { text: '01  Capture the page', x: 100, y: 340, size: 30, width: 355 },
      { text: '02  Read the text', x: 100, y: 415, size: 30, width: 310 },
      { text: '03  Translate privately', x: 100, y: 490, size: 30, width: 370 },
      { text: 'sakutto.example / 2026', x: 590, y: 625, size: 22, width: 320, color: '#34495e' },
    ],
    [
      '<rect x="35" y="35" width="930" height="200" rx="16" fill="#315b7d"/>',
      '<circle cx="840" cy="420" r="100" fill="#e7f1f7"/>',
      '<rect x="65" y="280" width="560" height="280" rx="12" fill="#f2f6f8"/>',
    ],
  ),
  makeFixture(
    'low-res-skew',
    'Low resolution skewed scan',
    900,
    650,
    [
      { text: 'FIELD REPORT 07', x: 125, y: 130, size: 22, width: 205, weight: 700 },
      { text: 'Rain stopped before dawn.', x: 125, y: 205, size: 19, width: 260 },
      { text: 'The north road is open.', x: 125, y: 265, size: 19, width: 250 },
      { text: 'Battery level: 82 percent', x: 125, y: 325, size: 19, width: 265 },
      { text: 'Return by Friday evening.', x: 125, y: 385, size: 19, width: 270 },
      { text: 'Recorded by M. Tanaka', x: 125, y: 445, size: 18, width: 240 },
    ],
    ['<rect x="85" y="80" width="650" height="450" fill="#fafafa" stroke="#777"/>'],
    -4,
  ),
  makeFixture(
    'two-column',
    'Two-column newsletter',
    1000,
    720,
    [
      { text: 'COMMUNITY GARDEN', x: 65, y: 90, size: 25, width: 340, weight: 700 },
      { text: 'Spring planting begins.', x: 65, y: 160, size: 23, width: 320 },
      { text: 'Volunteers meet at nine.', x: 65, y: 220, size: 23, width: 340 },
      { text: 'Bring gloves and water.', x: 65, y: 280, size: 23, width: 320 },
      { text: 'CITY LIBRARY NEWS', x: 545, y: 90, size: 25, width: 340, weight: 700 },
      { text: 'New books arrive Monday.', x: 545, y: 160, size: 23, width: 340 },
      { text: 'Reading club welcomes all.', x: 545, y: 220, size: 23, width: 350 },
      { text: 'Return books by Friday.', x: 545, y: 280, size: 23, width: 330 },
    ],
    ['<line x1="500" y1="55" x2="500" y2="350" stroke="#999" stroke-width="2"/>'],
  ),
  makeFixture('mixed-ja-en', 'Mixed Japanese and English guide', 900, 650, [
    { text: 'Sakutto 翻訳ガイド', x: 75, y: 100, size: 34 },
    { text: 'START を押して開始します。', x: 75, y: 180, size: 30 },
    { text: 'English と日本語を読み取ります。', x: 75, y: 255, size: 29 },
    { text: 'Privacy first: 外部送信なし。', x: 75, y: 330, size: 29 },
    { text: 'OCR version 6 を使用します。', x: 75, y: 405, size: 29 },
    { text: '詳細は README をご覧ください。', x: 75, y: 480, size: 29 },
  ]),
  makeFixture(
    'small-text',
    'Small text and captions',
    1000,
    720,
    [
      { text: 'QUICK REFERENCE', x: 70, y: 80, size: 19, width: 205, weight: 700 },
      { text: 'Select the source language.', x: 70, y: 135, size: 15, width: 225 },
      { text: 'Drop an image on the page.', x: 70, y: 185, size: 15, width: 225 },
      { text: 'Check names and numbers.', x: 70, y: 235, size: 15, width: 220 },
      { text: 'Small captions remain legible.', x: 70, y: 285, size: 14, width: 240 },
      { text: 'Zoom in when the print is faint.', x: 70, y: 335, size: 14, width: 255 },
      { text: 'Support: help@example.test', x: 70, y: 385, size: 14, width: 220 },
      { text: 'Document ID: SA-006-2026', x: 70, y: 435, size: 13, width: 205 },
    ],
    ['<rect x="40" y="35" width="380" height="455" fill="#fcfcfc" stroke="#b0b0b0"/>'],
  ),
];

export function groundTruth(fixture: OcrFixture): string {
  return fixture.lines.map((line) => line.text).join('\n');
}

export async function materializeFixtureSources(): Promise<void> {
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });
  for (const fixture of OCR_FIXTURES) {
    await writeFile(join(FIXTURE_DIRECTORY, fixture.id + '.svg'), fixture.svg, 'utf8');
  }
  const manifest = {
    schema: 1,
    license: 'CC0-1.0',
    attribution: 'Generated for the Sakutto PP-OCRv6 benchmark; no third-party text or images.',
    generator: 'scripts/bench/ocr-render.ts',
    fixtures: OCR_FIXTURES.map((fixture) => ({
      id: fixture.id,
      title: fixture.title,
      width: fixture.width,
      height: fixture.height,
      orientation: fixture.orientation,
      lines: fixture.lines,
      groundTruth: groundTruth(fixture),
    })),
  };
  await writeFile(FIXTURE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export async function readFixtureManifest(): Promise<typeof OCR_FIXTURES> {
  const parsed = JSON.parse(await readFile(FIXTURE_MANIFEST, 'utf8')) as {
    fixtures: typeof OCR_FIXTURES;
  };
  return parsed.fixtures;
}
