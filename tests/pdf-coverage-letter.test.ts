import { describe, expect, it } from 'vitest';
import { groupLines, type TextPiece } from '@/pdf/lines';
import { layoutPage } from '@/pdf/layout';
import { hasDeliverableTranslation, PdfSession, type PdfEngine } from '@/pdf/session';
import type { TranslationChunk } from '@/engine/types';

function piece(
  text: string,
  x: number,
  baseline: number,
  width: number,
  options: { bold?: boolean } = {},
): TextPiece {
  const em = 10;
  return {
    text,
    box: { x, y: baseline - em, width, height: em },
    baseline,
    fontName: options.bold === true ? 'bold' : 'regular',
    family: 'serif',
    bold: options.bold === true,
    italic: false,
    math: false,
    orientation: 0,
    size: em,
    displayed: 0,
  };
}

function engineStub(final: string): PdfEngine {
  return {
    translate: async function* (segments): AsyncIterable<TranslationChunk> {
      const id = segments[0]?.id ?? 'b1';
      yield { id, final };
    },
  };
}

/**
 * A synthetic LETTER page: left column, right column, a run-in heading, and body prose in each.
 */
function syntheticLetterPage(): ReturnType<typeof layoutPage> {
  const y = (row: number) => 100 + row * 14;
  const pieces: TextPiece[] = [
    piece('2. Selection of a Detection Method', 72, y(0), 220),
    piece('Method A: the baseline counts every token as a positive.', 72, y(2), 210, {
      bold: true,
    }),
    piece(
      'Left column opening sentence with enough synthetic words to classify as prose.',
      72,
      y(4),
      210,
    ),
    piece(
      'Left column continuation about thresholds and configuration for the evaluation.',
      72,
      y(6),
      210,
    ),
    piece(
      'Right column opening whose blocks are queued after the left column completes.',
      300,
      y(4),
      210,
    ),
    piece(
      'Right column continuation with recall and precision definitions for the metrics.',
      300,
      y(6),
      210,
    ),
    piece('1 Training set', 72, y(12), 120),
    piece('2 Validation set', 200, y(12), 120),
  ];
  const page = groupLines(pieces);
  return layoutPage(page);
}

describe('synthetic two-column letter coverage', () => {
  it('translates at least ninety-seven percent of prose blocks on one page', async () => {
    const layout = syntheticLetterPage();
    const proseBlocks = layout.blocks.filter(
      (block) => block.role === 'prose' || block.role === 'heading',
    );
    expect(proseBlocks.length).toBeGreaterThanOrEqual(3);

    const session = new PdfSession({
      engine: engineStub('評価用の訳文です。'),
      targetLanguage: 'ja',
      form: 'polite',
      onChange: () => undefined,
      measure: (text, size) => text.length * size * 0.45,
      concurrency: 2,
    });
    session.addPage(0, layout);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const progress = session.progress();
      if (progress.pending === 0 && progress.failed === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const states = session.pageBlocks(0);
    const proseStates = states.filter(
      (state) => state.block.role === 'prose' || state.block.role === 'heading',
    );
    const covered = proseStates.filter((state) => hasDeliverableTranslation(state)).length;
    expect(covered / Math.max(1, proseStates.length)).toBeGreaterThanOrEqual(0.97);
    expect(layout.skipped.filter((block) => block.role === 'code')).toHaveLength(0);
  });
});
