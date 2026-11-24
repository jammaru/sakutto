// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import { ocrResultToPageLayout, ocrResultToTextLines } from '@/pdf/ocr';
import { pageMetrics } from '@/pdf/metrics';
import { placePage } from '@/pdf/place';

function quad(x: number, y: number, width: number, height: number): OcrQuad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function region(text: string, x: number, y: number, width: number, height = 15): OcrRegion {
  return {
    quad: quad(x, y, width, height),
    confidence: 0.95,
    vertical: false,
    text,
    recognitionConfidence: 0.9,
    symbolScores: [0.9],
  };
}

function resultFromLines(rows: readonly (readonly OcrRegion[])[]): OcrResult {
  const lines: ReadingLine<OcrRegion>[] = rows.map((items) => ({
    orientation: 'horizontal',
    items: [...items],
    indices: items.map((_, index) => index),
  }));
  return {
    regions: rows.flatMap((items) => [...items]),
    lines,
    text: rows.flatMap((items) => items.map((item) => item.text)).join('\n'),
  };
}

const OPTIONS = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };

/** Geometry measured on bench/pdf/image-only-paper.pdf page 1 (two 222pt columns, 25pt gutter). */
function twoColumnBody(startY: number, rows: number): OcrRegion[][] {
  const out: OcrRegion[][] = [];
  for (let index = 0; index < rows; index += 1) {
    const y = startY + index * 16;
    out.push([
      region('日本語の本文が左の欄に続いている行', 59, y, 220),
      region('右の欄にも本文が同じ高さに続いている', 306, y, 220),
    ]);
  }
  return out;
}

describe('image-only Japanese paper: columns and spanning rows', () => {
  it('splits paired short Japanese section headings above a two-column body', () => {
    const rows = [
      [region('ローカルLLMを用いたブラウザ翻訳システム', 119, 73, 357, 22)],
      [region('Sakuttoの設計と実装', 208, 99, 178, 20)],
      [
        region(
          '概要:Sakuttoは大規模言語モデルを利用してブラウザ上のコンテンツを翻訳する',
          59,
          160,
          470,
        ),
      ],
      [region('1.はじめに', 59, 270, 105), region('3. ローカル推論基盤', 306, 270, 160)],
      ...twoColumnBody(297, 8),
    ];
    const lines = ocrResultToTextLines(resultFromLines(rows), OPTIONS);
    expect(lines.map((line) => line.text)).toContain('1.はじめに');
    expect(lines.map((line) => line.text)).toContain('3. ローカル推論基盤');
    expect(lines.some((line) => line.text.includes('1.はじめに 3.'))).toBe(false);
    const headings = lines.filter((line) => /^[135]\./u.test(line.text));
    expect(headings.map((line) => line.columnHint)).toEqual([0, 1]);
    const layout = ocrResultToPageLayout(resultFromLines(rows), OPTIONS);
    expect(
      layout.blocks.some(
        (block) =>
          block.role === 'heading' &&
          block.text.includes('はじめに') &&
          block.text.includes('ローカル'),
      ),
    ).toBe(false);
    expect(
      layout.blocks.filter((block) => block.role === 'heading').map((block) => block.column),
    ).toEqual([-1, -1, 0, 1]);
  });

  it('splits a numbered heading pair with normal spacing on page 2', () => {
    const rows = [
      [region('Sakutto 技術論文サンプル OCR評価用', 59, 30, 167)],
      [region('5. PDF翻訳とOCR', 59, 75, 150), region('7. OCR評価用の処理構成', 306, 75, 200)],
      ...twoColumnBody(103, 8),
    ];
    const lines = ocrResultToTextLines(resultFromLines(rows), OPTIONS);
    expect(lines.map((line) => line.text)).toEqual(
      expect.arrayContaining(['5. PDF翻訳とOCR', '7. OCR評価用の処理構成']),
    );
    expect(lines.find((line) => line.text.startsWith('5. PDF'))?.columnHint).toBe(0);
    expect(lines.find((line) => line.text.startsWith('7. OCR'))?.columnHint).toBe(1);
  });

  it('splits a formula in the left column from prose in the right column', () => {
    const rows = [
      ...twoColumnBody(103, 4),
      [
        region('CER = (S + D + I) / N', 121, 462, 158),
        region('Sakuttoの翻訳機能をより多様な文書に適用する', 306, 462, 223),
      ],
      ...twoColumnBody(486, 3),
    ];
    const lines = ocrResultToTextLines(resultFromLines(rows), OPTIONS);
    expect(lines.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        'CER = (S + D + I) / N',
        'Sakuttoの翻訳機能をより多様な文書に適用する',
      ]),
    );
  });

  it('keeps full-width title and abstract rows whole and out of both column rooms', () => {
    const rows = [
      [region('ローカルLLMを用いたブラウザ翻訳システム', 119, 73, 357, 22)],
      [region('Design and Implementation of Sakutto', 204, 129, 188, 18)],
      [
        region(
          '概要:Sakuttoは大規模言語モデルを利用してブラウザ上のコンテンツを翻訳する',
          59,
          160,
          470,
        ),
      ],
      [
        region(
          'である。翻訳処理を利用者の端末内で完結させることで外部サービスへの原文送信を必要としない',
          61,
          177,
          472,
        ),
      ],
      [region('1.はじめに', 59, 270, 105), region('3. ローカル推論基盤', 306, 270, 160)],
      ...twoColumnBody(297, 8),
    ];
    const result = resultFromLines(rows);
    const lines = ocrResultToTextLines(result, OPTIONS);
    expect(
      lines.filter((line) => line.text.startsWith('概要')).map((line) => line.columnHint),
    ).toEqual([undefined]);
    expect(
      lines.filter((line) => line.text.startsWith('である。')).map((line) => line.columnHint),
    ).toEqual([undefined]);
    const layout = ocrResultToPageLayout(result, OPTIONS);
    const abstract = layout.blocks.find((block) => block.text.startsWith('概要'));
    expect(abstract?.column).toBe(-1);
    expect(abstract?.room.width).toBeLessThanOrEqual((abstract?.box.width ?? 0) + 1);
  });

  it('keeps figure labels inside their column without merging body lines', () => {
    const rows = [
      ...twoColumnBody(297, 6),
      [
        region('画像PDFを翻訳する場合の処理構成を図1に示す', 306, 420, 220),
        region('テキスト情報を保持するPDFでは文字列と位置情報を取得し', 59, 420, 220),
      ],
      [region('画像PDF', 401, 460, 41)],
      [region('文字領域の検出・認識', 370, 480, 102)],
      [region('ローカルLLMによる翻訳', 366, 502, 111)],
      ...twoColumnBody(540, 3),
    ];
    const layout = ocrResultToPageLayout(resultFromLines(rows), OPTIONS);
    const figureLabels = layout.blocks.filter((block) => block.text.includes('文字領域'));
    expect(figureLabels.length).toBe(1);
    expect(figureLabels[0]?.column).toBe(1);
    expect(
      layout.blocks.some(
        (block) =>
          block.text.includes('画像PDFを翻訳') && block.text.includes('テキスト情報を保持'),
      ),
    ).toBe(false);
  });

  it('reports no cross-column painted cover for the corrected two-column paper geometry', () => {
    const rows = [
      [region('1.はじめに', 59, 270, 105), region('3. ローカル推論基盤', 306, 270, 160)],
      ...twoColumnBody(297, 8),
    ];
    const layout = ocrResultToPageLayout(resultFromLines(rows), OPTIONS);
    const placed = placePage({
      layout,
      translationOf: (block: { text: string }) => block.text,
      target: 'ja',
      measure: (_block: unknown, text: string, size: number) => text.length * size * 0.7,
      pageWidth: OPTIONS.pageWidth,
      pageHeight: OPTIONS.pageHeight,
    });
    const metrics = pageMetrics(layout, placed, {
      x: 0,
      y: 0,
      width: OPTIONS.pageWidth,
      height: OPTIONS.pageHeight,
    });
    expect(metrics.crossColumnCovers).toBe(0);
    expect(metrics.overlapPairs).toBe(0);
  });
});
