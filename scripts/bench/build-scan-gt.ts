/**
 * Generates the reading-ordered ground truth for bench/pdf/scan.pdf page 1.
 *
 * scan.pdf is an image-only PDF: paper.html was rendered in Chromium at 1240x1754 (150 DPI)
 * and packed as one JPEG per page. The document is exactly one page tall, so scan p1 carries
 * the whole fixture in a two-column screen layout. paper.pdf is a *print* render with margins
 * and different page breaks; its text layer is therefore not ground truth for the scan raster.
 *
 * This script reads the visible words from the same DOM the scan was captured from, assigns
 * each word to its section and CSS column, and writes the reading order a human follows:
 * title block, abstract, left body column, right body column, references columns. Committed
 * output: bench/pdf/scan-p1.gt.txt.
 *
 *   pnpm exec node --experimental-transform-types --no-warnings --import ./scripts/bench/register-ts.mjs scripts/bench/build-scan-gt.ts
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const OUT = join(ROOT, 'bench/pdf/scan-p1.gt.txt');

interface CharBox {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly section: number;
  readonly column: number;
  readonly domIndex: number;
  readonly tokenIndex: number;
}
interface Token {
  readonly section: number;
  readonly column: number;
  readonly domIndex: number;
  readonly value: CharBox[];
  text: string;
  y: number;
}
interface Line {
  readonly section: number;
  readonly column: number;
  readonly domIndex: number;
  y: number;
  words: Token[];
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    executablePath: process.env['CHROME_PATH'] || '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT } });
    await page.goto('file://' + join(ROOT, 'bench/pdf/paper.html'), { waitUntil: 'load' });
    const chars = await page.evaluate(
      ({ width, height }) => {
        const result: CharBox[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let domIndex = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const text = (node.textContent || '').replace(/\u00ad/gu, '');
          if (!text.trim()) continue;
          let section = -1;
          let ancestor = node.parentElement;
          while (ancestor && ancestor !== document.body) {
            if (ancestor.matches('.title-block')) {
              section = 0;
              break;
            }
            if (ancestor.matches('.abstract')) {
              section = 1;
              break;
            }
            if (ancestor.matches('.references')) {
              section = ancestor.matches('h2') ? 3 : 4;
              break;
            }
            if (ancestor.matches('.columns')) {
              section = 2;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (section < 0) continue;
          let offset = 0;
          for (const piece of text.split(/(\s+)/u)) {
            const end = offset + piece.length;
            if (piece.trim()) {
              const tokenIndex = domIndex * 100000 + offset;
              for (let index = 0; index < piece.length; index += 1) {
                const range = document.createRange();
                range.setStart(node, offset + index);
                range.setEnd(node, offset + index + 1);
                for (const rect of Array.from(range.getClientRects())) {
                  if (rect.width <= 0 || rect.height <= 0 || rect.top >= height || rect.bottom <= 0)
                    continue;
                  result.push({
                    text: piece[index] ?? '',
                    x: rect.left,
                    y: rect.top,
                    section,
                    column: section >= 3 ? (rect.left + rect.right < width ? 0 : 1) : 0,
                    domIndex,
                    tokenIndex,
                  });
                }
              }
            }
            offset = end;
          }
          domIndex += 1;
        }
        return result;
      },
      { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    );
    const tokens = new Map<string, Token>();
    for (const character of chars) {
      const key = [
        character.section,
        character.column,
        character.domIndex,
        character.tokenIndex,
        Math.round(character.y / 3),
      ].join('|');
      const existing = tokens.get(key);
      if (existing) existing.value.push(character);
      else
        tokens.set(key, {
          section: character.section,
          column: character.column,
          domIndex: character.domIndex,
          value: [character],
          text: '',
          y: character.y,
        });
    }
    for (const token of tokens.values()) {
      token.value.sort((left, right) => left.x - right.x);
      token.text = token.value.map((character) => character.text).join('');
      token.y = Math.min(...token.value.map((character) => character.y));
    }
    const sorted = [...tokens.values()].sort(
      (left, right) =>
        left.section - right.section ||
        left.column - right.column ||
        left.domIndex - right.domIndex ||
        left.y - right.y,
    );
    const lines: Line[] = [];
    for (const token of sorted) {
      const last = lines.at(-1);
      if (
        last &&
        last.section === token.section &&
        last.column === token.column &&
        last.domIndex === token.domIndex &&
        Math.abs(last.y - token.y) < 3
      ) {
        last.words.push(token);
      } else {
        lines.push({
          section: token.section,
          column: token.column,
          domIndex: token.domIndex,
          y: token.y,
          words: [token],
        });
      }
    }
    for (const line of lines) {
      line.words.sort(
        (left, right) => left.y - right.y || (left.value[0]?.x ?? 0) - (right.value[0]?.x ?? 0),
      );
    }
    const text =
      lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n') + '\n';
    await writeFile(OUT, text);
    console.log('wrote ' + OUT + ' (' + tokens.size + ' words, ' + lines.length + ' lines)');
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
