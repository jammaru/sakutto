import { describe, expect, it } from 'vitest';
import { traitsOfName } from '@/pdf/fonts';
import { groupLines } from '@/pdf/lines';
import { isEquation, isTick, layoutPage } from '@/pdf/layout';
import { isImageOnlyPage } from '@/pdf/extract';
import { piece } from './support/pdf-pieces';

describe('equation detection beyond Computer Modern', () => {
  it('recognises MathJax and Times-style math faces as math', () => {
    for (const name of [
      'MJXTEX-I',
      'ABCDEF+MathJax_Math-Italic',
      'ABCDEF+NTXMI10',
      'ABCDEF+Symbol',
      'ABCDEF+MTExtra',
    ]) {
      expect(traitsOfName(name).math, name).toBe(true);
    }
    expect(traitsOfName('ABCDEF+TimesNewRomanPS-ItalicMT').math).toBe(false);
    expect(traitsOfName('CBRNUA+CMR10').math).toBe(false);
  });

  it('treats an indented operator line without a math face as a display equation', () => {
    const lines = groupLines([
      piece('The update is then written as', 49, 100, 200),
      piece('S = (I − β)S', 150, 130, 72, { italic: true }),
      piece('Here the loss is summed over the sequence.', 49, 160, 400),
    ]);
    expect(
      isEquation(
        lines.filter((line) => line.text.includes('=')),
        49,
      ),
    ).toBe(true);
    const layout = layoutPage(lines);
    expect(layout.skipped.some((block) => block.role === 'equation')).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('S = (I'))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('loss is summed'))).toBe(true);
  });
});

describe('figure labels versus ticks', () => {
  it('keeps a caption even when the drawing’s box covers the line under it', () => {
    const lines = groupLines([
      piece('Router', 150, 300, 40),
      piece('Figure 2. Routing of tokens to experts.', 49, 380, 220),
    ]);
    const figures = { images: [{ x: 40, y: 260, width: 320, height: 140 }] };
    const layout = layoutPage(lines, figures);
    const caption = layout.blocks.find((block) => block.text.startsWith('Figure 2'));
    expect(caption?.role).toBe('caption');
  });

  it('keeps even a full sentence inside a figure as a figure-label, never prose', () => {
    const lines = groupLines([
      piece('A pipeline that scores each module before it is shown.', 49, 80, 280),
      piece(
        'This sentence is drawn inside the diagram and must not be painted over.',
        90,
        240,
        220,
      ),
    ]);
    const figures = { images: [{ x: 70, y: 180, width: 260, height: 160 }] };
    const layout = layoutPage(lines, figures);
    expect(layout.blocks.some((block) => block.text.includes('drawn inside the diagram'))).toBe(
      false,
    );
    expect(
      layout.skipped.some(
        (block) =>
          block.text.includes('drawn inside the diagram') && block.role === 'figure-label',
      ),
    ).toBe(true);
  });

  it('leaves a diagram node untranslated so it cannot overflow the box beside it', () => {
    const lines = groupLines([
      piece('The model routes each token to two of its experts', 49, 600, 250),
      piece('Encoder', 150, 300, 40),
      piece('0.5', 190, 340, 16),
      piece('k', 300, 340, 8),
    ]);
    const figures = { images: [{ x: 120, y: 270, width: 300, height: 120 }] };
    const layout = layoutPage(lines, figures);
    const texts = layout.blocks.map((block) => block.text);
    expect(texts).toContain('The model routes each token to two of its experts');
    expect(texts).not.toContain('Encoder');
    expect(texts.some((text) => text === '0.5')).toBe(false);
    expect(
      layout.skipped.some((block) => block.text === 'Encoder' && block.role === 'figure-label'),
    ).toBe(true);
    expect(
      layout.skipped.some((block) => block.text === '0.5' && block.role === 'figure-label'),
    ).toBe(true);
  });

  it('leaves tight flowchart labels and table-in-figure numbers on the drawing', () => {
    const lines = groupLines([
      piece('A pipeline that scores each module before it is shown.', 49, 80, 280),
      piece('LOC', 90, 220, 24),
      piece('3', 200, 250, 8),
      piece('Evaluation by LLM', 90, 290, 90),
      piece('m1', 90, 400, 16),
      piece('m2', 200, 430, 16),
    ]);
    const figures = { images: [{ x: 70, y: 180, width: 260, height: 260 }] };
    const layout = layoutPage(lines, figures);
    expect(
      layout.skipped.some((block) => block.text === 'LOC' && block.role === 'figure-label'),
    ).toBe(true);
    expect(
      layout.skipped.some(
        (block) => block.text === 'Evaluation by LLM' && block.role === 'figure-label',
      ),
    ).toBe(true);
    expect(
      layout.skipped.some((block) => block.text === 'm1' && block.role === 'figure-label'),
    ).toBe(true);
    expect(layout.blocks.some((block) => block.text === 'LOC')).toBe(false);
    expect(layout.blocks.some((block) => block.text === 'Evaluation by LLM')).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('pipeline that scores'))).toBe(true);
  });

  it('leaves a tiny diagram word untranslated because the type would be unreadable', () => {
    const lines = groupLines([
      piece('The recent advances on transformer-based models', 49, 100, 252),
      piece('Summarization', 76, 300, 29, { em: 4 }),
    ]);
    const layout = layoutPage(lines);
    expect(layout.blocks.some((block) => block.text.includes('Summarization'))).toBe(false);
  });
});

describe('isTick', () => {
  it('accepts numbers, units and single letters, and rejects words', () => {
    expect(isTick('0.5')).toBe(true);
    expect(isTick('10^2')).toBe(true);
    expect(isTick('k')).toBe(true);
    expect(isTick('Encoder')).toBe(false);
    expect(isTick('Training loss')).toBe(false);
  });
});

describe('code, furniture, and image-only pages', () => {
  it('leaves a monospaced listing untranslated', () => {
    const lines = groupLines([
      piece('for block in page:', 60, 200, 140, { family: 'monospace', em: 8 }),
      piece('    emit(translate(block))', 60, 212, 160, { family: 'monospace', em: 8 }),
      piece('A paragraph that follows the listing continues in the body face.', 49, 240, 400),
    ]);
    const layout = layoutPage(lines);
    expect(layout.skipped.some((block) => block.role === 'code')).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('for block'))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('paragraph that follows'))).toBe(true);
  });

  it('keeps a wrapped body-face pseudocode listing entirely untranslated', () => {
    const lines = groupLines([
      piece('evalModules = modules for the evaluation;', 80, 200, 220),
      piece('for each (m : evalModules) {', 80, 214, 180),
      piece('devEval = the readability of m by a', 80, 228, 210),
      piece('developer;', 80, 242, 70),
      piece('output evaluation = calibModel.predict(m);', 80, 256, 240),
      piece('}', 80, 270, 10),
      piece('The listing is the procedure a reader follows on each module.', 49, 310, 400),
    ]);
    const layout = layoutPage(lines);
    const code = layout.skipped.filter((block) => block.role === 'code');
    expect(code.length).toBeGreaterThan(0);
    const joined = code.map((block) => block.text).join(' ');
    expect(joined).toContain('evalModules');
    expect(joined).toContain('developer;');
    expect(joined).toContain('output evaluation');
    expect(layout.blocks.some((block) => /\bdeveloper;?\b/u.test(block.text))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('output evaluation'))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('listing is the procedure'))).toBe(
      true,
    );
  });

  it('leaves a page number at the foot of the page untranslated', () => {
    const lines = groupLines([
      piece('A reader who wants an article in Japanese has three choices today.', 49, 100, 400),
      piece('12', 300, 780, 12),
    ]);
    const layout = layoutPage(lines, { images: [] }, { height: 800 });
    expect(layout.skipped.some((block) => block.role === 'furniture' && block.text === '12')).toBe(
      true,
    );
    expect(layout.blocks.some((block) => block.text === '12')).toBe(false);
  });

  it('treats a page with no upright text as image-only', () => {
    expect(isImageOnlyPage([], { images: [] }, 595, 842)).toBe(true);
    const stamp = piece('ID:demo-stamp-2024', 32, 232, 20, { em: 20, orientation: 90 });
    stamp.box = { x: 32, y: 212, width: 20, height: 245 };
    expect(isImageOnlyPage(groupLines([stamp]), { images: [] }, 595, 842)).toBe(true);
  });

  it('treats a full-page image with only a watermark as image-only', () => {
    const lines = groupLines([piece('DRAFT', 40, 40, 40, { em: 8 })]);
    expect(
      isImageOnlyPage(lines, { images: [{ x: 0, y: 0, width: 595, height: 842 }] }, 595, 842),
    ).toBe(true);
  });
});

describe('first-page identity and captions', () => {
  it('leaves names, affiliations, and emails untranslated, and keeps the title', () => {
    const lines = groupLines([
      piece('Fitting Translated Text Into a Page Layout', 40, 48, 500, { em: 16, bold: true }),
      piece('Alex Example, Blair Sample, and Casey Demo', 40, 72, 400, { em: 10 }),
      piece('Demo University, Institute of Computing', 40, 86, 360, { em: 9 }),
      piece('casey.demo@example.org', 40, 100, 180, { em: 8 }),
      piece('Abstract', 40, 140, 80, { em: 11, bold: true }),
      piece('A reader who wants an article in Japanese has three choices today.', 40, 160, 500),
    ]);
    const layout = layoutPage(lines, { images: [] }, { height: 800, width: 600, index: 0 });
    expect(layout.blocks.some((block) => block.text.startsWith('Fitting Translated'))).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('Alex Example'))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('Demo University'))).toBe(false);
    expect(layout.blocks.some((block) => block.text.includes('@example.org'))).toBe(false);
    expect(layout.skipped.some((block) => block.role === 'identity')).toBe(true);
    expect(layout.blocks.some((block) => block.text.includes('three choices'))).toBe(true);
    expect(
      layout.blocks.some((block) => block.text === 'Abstract' && block.role === 'heading'),
    ).toBe(true);
  });

  it('translates ABSTRACT and leaves Author, Affiliation, and Email untranslated', () => {
    const lines = groupLines([
      piece('Fitting Translated Text Into a Page Layout', 40, 48, 500, { em: 16, bold: true }),
      piece('Author', 40, 68, 50, { em: 10 }),
      piece('Alex Example', 40, 82, 90, { em: 10 }),
      piece('Affiliation', 40, 100, 70, { em: 9 }),
      piece('Demo University', 40, 114, 110, { em: 9 }),
      piece('Email', 40, 132, 40, { em: 8 }),
      piece('casey.demo@example.org', 40, 146, 180, { em: 8 }),
      piece('ABSTRACT', 40, 180, 80, { em: 10 }),
      piece('A reader who wants an article in Japanese has three choices today.', 40, 210, 500),
    ]);
    const layout = layoutPage(lines, { images: [] }, { height: 800, width: 600, index: 0 });
    const abstract = layout.blocks.find((block) => block.text === 'ABSTRACT');
    expect(abstract?.role).toBe('heading');
    expect(
      layout.skipped.some((block) => block.text === 'Author' && block.role === 'identity'),
    ).toBe(true);
    expect(
      layout.skipped.some((block) => block.text === 'Affiliation' && block.role === 'identity'),
    ).toBe(true);
    expect(
      layout.skipped.some((block) => block.text === 'Email' && block.role === 'identity'),
    ).toBe(true);
    expect(layout.blocks.some((block) => block.text === 'Author')).toBe(false);
  });

  it('keeps a title on a later page translatable even when it looks like names', () => {
    const lines = groupLines([
      piece('Alex Example and Blair Sample', 40, 80, 300, { em: 10 }),
      piece('A following paragraph continues the body of this later page.', 40, 120, 400),
    ]);
    const layout = layoutPage(lines, { images: [] }, { height: 800, width: 600, index: 2 });
    expect(layout.skipped.some((block) => block.role === 'identity')).toBe(false);
  });

  it('keeps a figure caption apart from the table header under it', () => {
    const lines = groupLines([
      piece('Figure 1: Comparison of translation backends on a long document.', 40, 200, 420),
      piece('Backend', 40, 230, 70, { em: 8, bold: true }),
      piece('GPU', 140, 230, 40, { em: 8, bold: true }),
      piece('CPU', 210, 230, 40, { em: 8, bold: true }),
      piece('wllama', 40, 244, 50, { em: 8 }),
      piece('32', 140, 244, 24, { em: 8 }),
      piece('2', 210, 244, 16, { em: 8 }),
    ]);
    const layout = layoutPage(lines, { images: [] }, { height: 800, width: 600 });
    const caption = layout.blocks.find((block) => block.role === 'caption');
    expect(caption?.text.startsWith('Figure 1:')).toBe(true);
    expect(caption?.text.includes('Backend')).toBe(false);
    expect(
      layout.blocks.some((block) => block.role !== 'caption' && /\bBackend\b/u.test(block.text)),
    ).toBe(true);
  });
});
