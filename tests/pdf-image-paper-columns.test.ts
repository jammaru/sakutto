// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { OcrQuad, OcrRegion, OcrResult, ReadingLine } from '@/engine/ocr/types';
import { ocrResultToPageLayout, ocrResultToTextLines } from '@/pdf/ocr';
import { pageMetrics } from '@/pdf/metrics';
import { pageObstacles, placePage, wrapWidth } from '@/pdf/place';
import { isNoiseBlockText } from '@/pdf/prose-detect';

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

describe('section headings require an explicit separator', () => {
  const options = { pageIndex: 0, pageWidth: 595, pageHeight: 842 };

  function singleLineLayout(text: string) {
    return ocrResultToPageLayout(resultFromLines([[region(text, 59, 100, 220)]]), options);
  }

  it.each(['1.はじめに', '3. ローカル推論基盤', '1. Introduction', '2.1 Runtime'])(
    'keeps %s as a heading',
    (text) => {
      const block = singleLineLayout(text).blocks.find((candidate) => candidate.text === text);
      expect(block?.role).toBe('heading');
    },
  );

  it.each(['3Dプリンタの結果', '2024年度の報告', '3つの手法を比較する'])(
    'does not promote the word %s to a heading',
    (text) => {
      const block = singleLineLayout(text).blocks.find((candidate) => candidate.text === text);
      expect(block?.role).not.toBe('heading');
    },
  );

  it('keeps consecutive digit-prefixed words in one paragraph', () => {
    const rows = [
      [region('3Dプリンタの結果を報告する', 59, 100, 220)],
      [region('2024年度の実験データを示す', 59, 118, 220)],
    ];
    const layout = ocrResultToPageLayout(resultFromLines(rows), options);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]?.text).toBe('3Dプリンタの結果を報告する 2024年度の実験データを示す');
    expect(layout.blocks[0]?.role).toBe('prose');
  });
});

describe('image-only paper page 2: figure, fragments and formula', () => {
  /** Geometry measured on bench/pdf/image-only-paper.pdf page 2, in PDF points. */
  function pageTwoRows(): OcrRegion[][] {
    return [
      [region('5. PDF翻訳とOCR', 59, 76, 100)],
      [region('テキスト情報を保持するPDFでは、文字列と位', 60, 103, 220)],
      [region('置情報を取得し、翻訳結果を元のレイアウトに', 60, 119, 222)],
      [region('対応させる。段組み、表、図中の文字などにつ', 59, 135, 222)],
      [region('いても、読み順や領域の対応関係を考慮する必', 59, 151, 222)],
      [region('要がある。', 59, 166, 49)],
      [region('画像のみで構成されたPDFには抽出可能な文字', 60, 188, 220)],
      [region('列が存在しない。そのため、OCRによって文字', 60, 204, 222)],
      [region('領域を検出し、認識結果を翻訳処理に渡す必要', 60, 220, 221)],
      [region('がある。OCRの認識誤りは翻訳品質にも影響す', 60, 236, 221)],
      [region('る。', 58, 250, 21, 21)],
      [region('Nを用いて次式で定義する。', 59, 428, 129)],
      [region('CER = (S + D + I) / N', 121, 462, 107)],
      [region('翻訳精度に加え、文字認識の正確さやレイアウ', 60, 486, 221)],
      [region('トの再現性を個別に評価する。', 60, 502, 194)],
      [region('7. OCR評価用の処理構成', 306, 75, 137)],
      [region('画像PDFを翻訳する場合の処理構成を図1に示す', 306, 103, 224)],
      [region('画像PDF', 401, 185, 41)],
      [region('V', 415, 210, 10)],
      [region('文字領域の検出・認識', 370, 229, 102)],
      [region('X', 415, 253, 11)],
      [region('ローカルLLMによる翻訳', 366, 272, 111)],
      [region('翻訳結果の表示', 386, 315, 72)],
      [region('図1画像PDFの翻訳処理（概念図）', 307, 342, 142)],
    ];
  }

  it('never exposes the wrapped Japanese tails as blocks to translate', () => {
    const layout = ocrResultToPageLayout(resultFromLines(pageTwoRows()), OPTIONS);
    const paragraph = layout.blocks.find((block) => block.text.startsWith('テキスト情報'));
    const second = layout.blocks.find((block) => block.text.startsWith('画像のみ'));
    expect(paragraph?.text).toContain('要がある。');
    expect(second?.text).toContain('る。');
    for (const block of layout.blocks) {
      const content = block.text.replace(/[\s\p{P}\p{S}\p{N}]/gu, '');
      expect(content.length > 3).toBe(true);
      expect(block.text).not.toContain('I need it');
    }
    expect(isNoiseBlockText('る。', 'heading')).toBe(true);
    expect(isNoiseBlockText('I need it.')).toBe(false);
  });

  it('gives every flowchart box one fitted label and keeps the caption separate', () => {
    const layout = ocrResultToPageLayout(resultFromLines(pageTwoRows()), OPTIONS);
    const labels = layout.blocks.filter((block) => block.singleLine === true);
    expect(labels.map((block) => block.text)).toEqual([
      '画像PDF',
      '文字領域の検出・認識',
      'ローカルLLMによる翻訳',
      '翻訳結果の表示',
    ]);
    for (const label of labels) {
      const source = label.lines[0];
      expect(source).toBeDefined();
      const centre = source!.box.x + source!.box.width / 2;
      expect(label.box.x).toBeLessThanOrEqual(source!.box.x);
      expect(label.box.x + label.box.width).toBeGreaterThanOrEqual(source!.box.x + source!.box.width);
      expect(centre).toBeGreaterThan(label.box.x);
      expect(centre).toBeLessThan(label.box.x + label.box.width);
      expect(label.box.height).toBeGreaterThanOrEqual(source!.box.height);
      expect(label.column).toBe(1);
    }
    const caption = layout.blocks.find((block) => block.role === 'caption');
    const lastBox = labels[labels.length - 1];
    expect(caption?.text).toBe('図1画像PDFの翻訳処理（概念図）');
    expect(lastBox?.text).not.toContain('図1');
    expect(caption!.box.y).toBeGreaterThanOrEqual(lastBox!.box.y + lastBox!.box.height);
    expect(layout.skipped.map((block) => block.text)).toEqual(
      expect.arrayContaining(['V', 'X']),
    );
  });

  it('shrinks a long figure label to one line inside its box', () => {
    const layout = ocrResultToPageLayout(resultFromLines(pageTwoRows()), OPTIONS);
    const label = layout.blocks.find((block) => block.singleLine === true && block.text.includes('文字領域'));
    expect(label).toBeDefined();
    const placed = placePage({
      layout,
      translationOf: (block) =>
        block.singleLine === true ? 'Detection and Recognition of Character Regions' : block.text,
      target: 'en',
      measure: (_block, text, size) => text.length * size * 0.35,
      pageWidth: OPTIONS.pageWidth,
      pageHeight: OPTIONS.pageHeight,
    }).find((entry) => entry.block === label);
    expect(placed?.paint).toBe(true);
    expect(placed?.fit?.lines).toHaveLength(1);
    expect(placed!.fit!.fontSize).toBeLessThan(label!.fontSize);
    expect(placed!.drawn!.width).toBeLessThanOrEqual(label!.box.width + 1);
    expect(placed!.drawn!.x).toBeGreaterThanOrEqual(label!.box.x - 1);
  });

  it('keeps the CER formula out of the paragraph that follows it', () => {
    const layout = ocrResultToPageLayout(resultFromLines(pageTwoRows()), OPTIONS);
    const formula = layout.skipped.find((block) => block.text.trim() === 'CER = (S + D + I) / N');
    expect(formula?.role).toBe('equation');
    expect(layout.blocks.some((block) => block.text.includes('CER ='))).toBe(false);
    expect(layout.blocks.some((block) => block.text.startsWith('翻訳精度に加え'))).toBe(true);
    expect(
      layout.blocks.some(
        (block) => block.text.includes('CER =') && block.text.includes('翻訳精度'),
      ),
    ).toBe(false);
  });

  it('wraps left-column prose inside the gutter instead of clipping it', () => {
    const rows = [
      ...twoColumnBody(103, 4),
      [
        region('CER = (S + D + I) / N', 121, 462, 107),
        region('Sakuttoの翻訳機能をより多様な文書に適用する', 306, 462, 223),
      ],
    ];
    const layout = ocrResultToPageLayout(resultFromLines(rows), OPTIONS);
    const prose = layout.blocks.find((block) => block.column === 0 && block.role === 'prose');
    expect(prose).toBeDefined();
    const translation =
      'In PDFs that store textual information, strings and positional information are mapped to the original layout';
    const obstacles = pageObstacles(layout);
    const width = wrapWidth(prose!, obstacles, OPTIONS.pageWidth);
    const placed = placePage({
      layout,
      translationOf: (block) => (block === prose ? translation : block.text),
      target: 'en',
      measure: (_block, text, size) => text.length * size * 0.45,
      pageWidth: OPTIONS.pageWidth,
      pageHeight: OPTIONS.pageHeight,
    }).find((entry) => entry.block === prose);
    expect(width).toBeLessThanOrEqual((placed?.drawn?.width ?? 0) + 1);
    expect(placed?.paint).toBe(true);
    expect(width + prose!.box.x).toBeLessThan(OPTIONS.pageWidth * 0.49 + 1);
  });
});
