// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { AnyBlockRole, LayoutBlock, PageLayout } from '@/pdf/layout';
import { isPdfBlockSettled, PdfSession, type PdfEngine } from '@/pdf/session';
import { isNoiseBlockText } from '@/pdf/prose-detect';
import type { TranslationChunk } from '@/engine/types';

function block(text: string, role: AnyBlockRole = 'prose'): LayoutBlock {
  return {
    box: { x: 40, y: 80, width: 220, height: 24 },
    room: { x: 40, y: 80, width: 220, height: 24 },
    lines: [],
    text,
    role,
    fontSize: 10,
    lineHeight: 1.2,
    align: 'left',
    bold: false,
    italic: false,
    column: 0,
    advance: 220,
    writing: 0,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('OCR noise blocks never reach translation', () => {
  it('recognises punctuation, arrow and wrapped-tail fragments but keeps real headings', () => {
    expect(isNoiseBlockText('')).toBe(true);
    expect(isNoiseBlockText('.')).toBe(true);
    expect(isNoiseBlockText('V')).toBe(true);
    expect(isNoiseBlockText('X')).toBe(true);
    expect(isNoiseBlockText('る。', 'heading')).toBe(true);
    expect(isNoiseBlockText('I need it.')).toBe(true);
    expect(isNoiseBlockText('1. はじめに', 'heading')).toBe(false);
    expect(isNoiseBlockText('概要', 'heading')).toBe(false);
    expect(isNoiseBlockText('Oral', 'label')).toBe(false);
    expect(isNoiseBlockText('テキスト情報を保持するPDFでは')).toBe(false);
  });

  it('does not call the engine for noise blocks while translating real prose', async () => {
    const requested: string[] = [];
    const engine: PdfEngine = {
      translate: (segments: readonly { id: string; text: string }[]) => {
        requested.push(...segments.map((segment) => segment.text));
        return (async function* (): AsyncGenerator<TranslationChunk> {
          for (const segment of segments) {
            yield { id: segment.id, textDelta: '訳文' };
            yield { id: segment.id, final: '訳文' };
          }
        })();
      },
    };
    const session = new PdfSession({
      engine,
      targetLanguage: 'en',
      form: 'polite',
      onChange: () => undefined,
      measure: (text, size) => text.length * size * 0.5,
      concurrency: 4,
    });
    const layout: PageLayout = {
      blocks: [
        block('I need it.'),
        block('V'),
        block('る。', 'heading'),
        block('画像PDFを翻訳する場合の処理構成を図1に示す'),
      ],
      skipped: [],
      bodySize: 10,
      lineHeight: 12,
      pageWidth: 595,
      pageHeight: 842,
      pageIndex: 0,
      obstacles: [],
    };
    session.addPage(0, layout, 842);
    await waitFor(() => session.pageBlocks(0).every(isPdfBlockSettled));
    expect(requested).toEqual(['画像PDFを翻訳する場合の処理構成を図1に示す']);
    expect(
      session
        .pageBlocks(0)
        .slice(0, 3)
        .map((state) => state.intentionallyKept),
    ).toEqual([true, true, true]);
    session.dispose();
  });
});
