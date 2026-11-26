import { describe, expect, it } from 'vitest';
import { fitText, wrapBudget } from '@/pdf/fit';
import { gutterCandidates, staggeredGutterCandidates } from '@/pdf/gaps';
import { layoutPage } from '@/pdf/layout';
import type { TextLine, TextPiece } from '@/pdf/lines';
import {
  clippedPaintWidth,
  coverPaintLayout,
  DEFAULT_PAINT_SCALE,
  paintLineLimit,
  placePage,
  wrapWidth,
} from '@/pdf/place';
import { measure } from './support/pdf-pieces';

function makeLine(
  text: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  options: { bold?: boolean; family?: string } = {},
): TextLine {
  const baseline = y + height * 0.8;
  const piece: TextPiece = {
    text,
    box: { x, y, width, height },
    baseline,
    fontName: options.family === 'monospace' ? 'Courier' : 'Times',
    family: options.family ?? 'serif',
    bold: options.bold ?? false,
    italic: false,
    math: false,
    orientation: 0,
    size: height,
    displayed: 0,
  };
  return {
    text,
    box: { x, y, width, height },
    baseline,
    height,
    pieces: [piece],
    mathRatio: 0,
    proseChars: (text.match(/\p{L}/gu) ?? []).length,
  };
}

/** Builds a two-column page where the left and right columns use different leading (Issue #162). */
function staggeredTwoColumnLines(): TextLine[] {
  const leftTexts = [
    'The evolution of software engineering has been a continuous',
    'quest to enable developers to focus on solving complex problems',
    'by abstracting away lower-level, undifferentiated tasks. From',
    'early machine code to high-level programming languages and the',
    'adoption of APIs and libraries, each step has significantly',
    'boosted developer productivity across modern engineering teams',
    'working on distributed systems and large-scale cloud services',
    'throughout the industry today.',
  ];
  const rightTexts = [
    'rituals like daily standups and retrospectives. In contrast, the',
    'proper application of AI leads to rapid cycles, measured in',
    'hours or days. This needs continuous, real-time validation and',
    'feedback mechanisms, rendering many traditional rituals much',
    'less relevant. Would effort estimation still be as critical if',
    'AI diminishes the boundaries between simple, medium and hard',
    'tasks? Would metrics like velocity remain relevant or should we',
    'replace them with business value instead?',
  ];

  const lines: TextLine[] = [];
  // Left column: x = 36..299 (width 263), leading = 12.8pt
  leftTexts.forEach((text, index) => {
    const width = index === leftTexts.length - 1 ? 150 : 263;
    lines.push(makeLine(text, 36, 152 + index * 12.8, width, 10));
  });
  // Right column: x = 313..576 (width 263), leading = 12.2pt, shifted by -2.4pt at the top
  // Gutter is 299..313 (14pt = 1.4em).
  rightTexts.forEach((text, index) => {
    const width = index === rightTexts.length - 1 ? 170 : 263;
    lines.push(makeLine(text, 313, 149.6 + index * 12.2, width, 10));
  });
  return lines;
}

describe('staggeredGutterCandidates', () => {
  it('finds a clear column gutter when left and right columns use different leading', () => {
    const lines = staggeredTwoColumnLines();
    const candidates = staggeredGutterCandidates(lines, 10);
    expect(candidates.length).toBeGreaterThan(0);

    const best = candidates[0]!;
    expect(best.at).toBeCloseTo(306, 0);
    expect(best.width).toBeCloseTo(14, 0);
    expect(best.leftWidth).toBeGreaterThanOrEqual(200);
    expect(best.rightWidth).toBeGreaterThanOrEqual(200);
    expect(best.leftCount).toBe(8);
    expect(best.rightCount).toBe(8);
    expect(best.overlapLeft).toBeGreaterThanOrEqual(6);
    expect(best.overlapRight).toBeGreaterThanOrEqual(6);
    expect(best.crossings).toBe(0);
  });

  it('counts full-width title and author lines as crossings while keeping the gutter intact', () => {
    const lines = [
      makeLine('AI-Driven Development Lifecycle Method Definition', 56, 61, 500, 18, {
        bold: true,
      }),
      makeLine('Author Name, Cloud Services', 220, 89, 170, 9),
      makeLine('6', 304, 27, 4, 8),
      ...staggeredTwoColumnLines(),
    ];
    const best = staggeredGutterCandidates(lines, 10)[0];
    expect(best).toBeDefined();
    expect(best!.at).toBeCloseTo(306, 0);
    expect(best!.crossings).toBe(3);
    expect(best!.leftCount).toBe(8);
    expect(best!.rightCount).toBe(8);
  });

  it('reports zero pairwise vertical overlap for alternating unindented and indented lines', () => {
    const lines = [
      makeLine('for block in page:', 40, 100, 95, 10, { family: 'monospace' }),
      makeLine('if is_equation(block): continue', 155, 114, 160, 10, { family: 'monospace' }),
      makeLine('for line in block:', 40, 128, 95, 10, { family: 'monospace' }),
      makeLine('emit(translate(line))', 155, 142, 130, 10, { family: 'monospace' }),
    ];
    const candidates = staggeredGutterCandidates(lines, 10);
    for (const candidate of candidates) {
      expect(candidate.overlapLeft).toBe(0);
      expect(candidate.overlapRight).toBe(0);
    }
  });

  it('reports zero vertical overlap for disjoint top-left and bottom-right blocks', () => {
    const lines = [
      makeLine('Short heading line one', 40, 60, 140, 10),
      makeLine('Short heading line two', 40, 74, 140, 10),
      makeLine('Signed by the committee', 380, 620, 150, 10),
      makeLine('November 2026', 380, 634, 150, 10),
    ];
    const candidates = staggeredGutterCandidates(lines, 10);
    for (const candidate of candidates) {
      expect(candidate.overlapHeight).toBe(0);
      expect(candidate.overlapLeft).toBe(0);
      expect(candidate.overlapRight).toBe(0);
    }
  });

  it('returns no candidates when fewer than four lines exist', () => {
    const lines = [
      makeLine('Left line one', 36, 100, 200, 10),
      makeLine('Right line one', 313, 103, 200, 10),
      makeLine('Left line two', 36, 114, 200, 10),
    ];
    expect(staggeredGutterCandidates(lines, 10)).toEqual([]);
  });

  it('finds a gutter even when baseline-aligned gutterCandidates has too few paired rows', () => {
    const lines = staggeredTwoColumnLines();
    const aligned = gutterCandidates(lines, 10);
    const alignedBest = aligned[0]?.rows ?? 0;
    const staggered = staggeredGutterCandidates(lines, 10)[0];
    expect(alignedBest).toBeLessThan(4);
    expect(staggered?.overlapLeft).toBeGreaterThanOrEqual(6);
    expect(staggered?.overlapRight).toBeGreaterThanOrEqual(6);
  });
});

describe('layoutPage staggered two-column separation (Issue #162)', () => {
  it('keeps staggered two-column prose apart across a 1.4em gutter', () => {
    const lines = staggeredTwoColumnLines();
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });

    const crossingProse = layout.blocks.filter(
      (block) => block.box.x < 280 && block.box.x + block.box.width > 330,
    );
    expect(crossingProse).toEqual([]);

    const leftText = layout.blocks
      .filter((block) => block.box.x + block.box.width <= 306)
      .map((block) => block.text)
      .join(' ');
    const rightText = layout.blocks
      .filter((block) => block.box.x >= 306)
      .map((block) => block.text)
      .join(' ');

    expect(leftText).toContain('The evolution of software engineering');
    expect(leftText).not.toContain('daily standups');
    expect(rightText).toContain('daily standups');
    expect(rightText).not.toContain('software engineering');
  });

  it('keeps a full-width title above staggered columns without fusing either column', () => {
    const lines = [
      makeLine('AI-Driven Development Lifecycle (AI-DLC) Method Definition', 56, 61, 500, 18, {
        bold: true,
      }),
      makeLine('Raja SP, Amazon Web Services', 249, 89, 114, 9),
      makeLine('I. CONTEXT', 36, 126, 52, 11, { bold: true }),
      ...staggeredTwoColumnLines(),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });

    const title = layout.blocks.find((block) => block.text.includes('Method Definition'));
    expect(title).toBeDefined();
    expect(title!.box.width).toBeGreaterThan(400);

    const crossingBody = layout.blocks.filter(
      (block) => block.role === 'prose' && block.box.x < 280 && block.box.x + block.box.width > 330,
    );
    expect(crossingBody).toEqual([]);
  });

  it('does not glue a short left-column tail to a right-column line across a 1.4em gutter', () => {
    const lines = [
      ...staggeredTwoColumnLines(),
      // Short left-column tail (<= 28 chars) landing on the same baseline as a right-column line.
      makeLine('short tail phrase', 210, 260, 89, 10),
      makeLine('continues in the right column with normal body prose.', 313, 260, 263, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });

    const glued = layout.blocks.find(
      (block) =>
        block.text.includes('short tail phrase') &&
        block.text.includes('continues in the right column'),
    );
    expect(glued).toBeUndefined();
  });

  it('does not glue two full column lines on one baseline across a 1.4em gutter', () => {
    const lines = [
      makeLine(
        'This left column sentence continues smoothly without a period at the end',
        36,
        100,
        263,
        10,
      ),
      makeLine(
        'and this right column line begins with a lowercase continuation word',
        313,
        100,
        263,
        10,
      ),
      makeLine('Second line of the left column stays cleanly on the left side.', 36, 113, 263, 10),
      makeLine(
        'Second line of the right column stays cleanly on the right side.',
        313,
        113,
        263,
        10,
      ),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    const glued = layout.blocks.find(
      (block) =>
        block.text.includes('left column sentence') &&
        block.text.includes('right column line begins'),
    );
    expect(glued).toBeUndefined();
  });

  it('keeps single-column prose with indented paragraphs as a single column', () => {
    const lines = [
      makeLine(
        'This is the first paragraph of a single-column document spanning',
        60,
        100,
        480,
        10,
      ),
      makeLine(
        'the full width of the page with ordinary line spacing and margins.',
        60,
        114,
        480,
        10,
      ),
      makeLine('Done.', 60, 128, 30, 10),
      makeLine(
        'The second paragraph begins with a standard first-line indent to',
        84,
        148,
        456,
        10,
      ),
      makeLine(
        'signal a new paragraph while still belonging to the same column.',
        60,
        162,
        480,
        10,
      ),
      makeLine(
        'The third paragraph also starts indented on the first line here.',
        84,
        182,
        456,
        10,
      ),
      makeLine(
        'And wraps cleanly back to the left margin on the following line.',
        60,
        196,
        480,
        10,
      ),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });

    expect(layout.blocks.length).toBeGreaterThanOrEqual(2);
    expect(layout.blocks.every((block) => block.column === 0)).toBe(true);
  });

  it('does not split a single-column page at a small side-by-side figure label grid', () => {
    const lines = [
      makeLine('Introductory prose spanning the full width of the single column.', 60, 80, 480, 10),
      makeLine('More full-width prose describing the architecture diagram below.', 60, 94, 480, 10),
      makeLine('Another full-width sentence before the embedded diagram labels.', 60, 108, 480, 10),
      makeLine('Input', 120, 150, 35, 8),
      makeLine('Output', 380, 152, 42, 8),
      makeLine('Encoder', 120, 166, 48, 8),
      makeLine('Decoder', 380, 168, 48, 8),
      makeLine('Following prose continues across the full width of the page.', 60, 210, 480, 10),
      makeLine('Closing sentence of the single-column section on this page.', 60, 224, 480, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });

    const prose = layout.blocks.filter((block) => block.role === 'prose');
    expect(prose.length).toBeGreaterThanOrEqual(2);
    expect(prose.every((block) => block.box.width > 400)).toBe(true);
  });

  it('does not split a single-column page with a right-aligned footer below the body', () => {
    const lines = [
      makeLine('Dear editorial board, thank you for reviewing this manuscript.', 60, 100, 460, 10),
      makeLine('We have addressed every comment raised during the first round.', 60, 114, 460, 10),
      makeLine('Please find the revised version attached for your inspection.', 60, 128, 460, 10),
      makeLine('Sincerely,', 420, 320, 60, 10),
      makeLine('The Authors', 420, 334, 72, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });

    const body = layout.blocks.find((block) => block.text.includes('editorial board'));
    expect(body).toBeDefined();
    expect(body!.box.width).toBeGreaterThan(400);
  });

  it('keeps a numbered pseudocode block intact as a single skipped code block', () => {
    const lines = [
      makeLine('The translation scheduler processes each block in reading order:', 60, 72, 340, 10),
      makeLine('1 for block in page:', 60, 100, 120, 9, { family: 'monospace' }),
      makeLine('2', 60, 112, 6, 9, { family: 'monospace' }),
      makeLine('if is_equation(block): continue', 90, 112, 170, 9, { family: 'monospace' }),
      makeLine('3', 60, 124, 6, 9, { family: 'monospace' }),
      makeLine('emit(translate(block))', 90, 124, 130, 9, { family: 'monospace' }),
      makeLine('After the loop finishes, each translated block is painted back.', 60, 152, 340, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    const codeBlocks = layout.skipped.filter((block) => block.role === 'code');
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(layout.blocks.some((block) => block.text.includes('is_equation'))).toBe(false);
  });

  it('keeps a justified body line with 6 word-level runs merged instead of splitting as a diagram row', () => {
    const lines = [
      makeLine(
        'humans set the destination (the intent), and the system provides',
        313,
        529,
        263,
        10,
      ),
      makeLine('step-by-step', 313, 542, 51, 10),
      makeLine('directions', 376, 542, 41, 10),
      makeLine('(AI’s', 429, 542, 18, 10),
      makeLine('task', 459, 542, 17, 10),
      makeLine('decomposition', 488, 542, 60, 10),
      makeLine('and', 561, 542, 15, 10),
      makeLine('recommendations). Along the way, humans maintain oversight', 313, 554, 263, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]!.text).toContain('step-by-step directions');
    expect(layout.blocks[0]!.text).toContain('recommendations).');
  });

  it('splits an overlong paragraph at a justified mid-line sentence boundary without overlapping boxes', () => {
    const lines = [
      makeLine('The new method shall not demand extensive trainings and any', 313, 57, 263, 10),
      makeLine(
        'existing practitioner should be able to orient and start practicing',
        313,
        69,
        263,
        10,
      ),
      makeLine('it in a single day. To support easier adoption via associative', 313, 82, 263, 10),
      makeLine('learning, AI-DLC will preserve the underlying relationships', 313, 94, 263, 10),
      makeLine('between familiar terms in older methods while introducing', 313, 106, 263, 10),
      makeLine('modernized', 313, 118, 49, 10),
      makeLine('terminology.', 370, 118, 52, 10),
      makeLine('For', 431, 118, 13, 10),
      makeLine('example,', 452, 118, 38, 10),
      makeLine('Sprints', 498, 118, 28, 10),
      makeLine('in', 535, 118, 7, 10),
      makeLine('Scrum', 550, 118, 26, 10),
      makeLine(
        'represent iterative cycles for building and validating. But Sprints',
        313,
        130,
        263,
        10,
      ),
      makeLine(
        'are usually 4 to 6 weeks long in the pre-AI era. With AI-DLC, the',
        313,
        143,
        263,
        10,
      ),
      makeLine(
        'iteration cycles will be continuous and in terms of hours or days.',
        313,
        155,
        263,
        10,
      ),
      makeLine('Therefore, we need to intentionally rename Sprints. AI-DLC', 313, 167, 263, 10),
      makeLine(
        'rebrands Sprints as Bolts, emphasizing rapid, intense cycles that',
        313,
        179,
        263,
        10,
      ),
      makeLine('deliver unprecedented velocity.', 313, 191, 129, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    expect(layout.blocks.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < layout.blocks.length; index += 1) {
      const prev = layout.blocks[index - 1]!;
      const curr = layout.blocks[index]!;
      expect(prev.box.y + prev.box.height).toBeLessThanOrEqual(curr.box.y + 0.5);
    }
  });

  it('merges 2.1em justified word gaps inside the right column even when a left-column line shares the baseline', () => {
    const lines = [
      ...staggeredTwoColumnLines(),
      // Shared baseline y=280: left-column prose line + right-column justified line with ~21pt word gaps.
      makeLine('Left column paragraph continues independently on the left side.', 36, 280, 263, 10),
      makeLine('representation. The models comprise of static models', 330, 268, 246, 10),
      makeLine('(components,', 330, 280, 56, 10),
      makeLine('descriptions,', 407, 280, 52, 10),
      makeLine('responsibilities', 479, 280, 61, 10),
      makeLine('and', 561, 280, 15, 10),
      makeLine('relationships) and dynamic models in the right column.', 330, 292, 246, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    const rightMerged = layout.blocks.find((block) =>
      block.text.includes('(components, descriptions, responsibilities and'),
    );
    expect(rightMerged).toBeDefined();
    expect(rightMerged!.box.x).toBeGreaterThan(305);
  });

  it('classifies markdown hash headings as headings and paints their Japanese translations in place', () => {
    const lines = [
      ...staggeredTwoColumnLines(),
      makeLine('##Setup Prompt', 36, 300, 66, 10),
      makeLine('## User stories', 36, 330, 60, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    const setup = layout.blocks.find((block) => block.text === '##Setup Prompt');
    const stories = layout.blocks.find((block) => block.text === '## User stories');
    expect(setup?.role).toBe('heading');
    expect(stories?.role).toBe('heading');

    const placed = placePage({
      layout,
      translationOf: (block) => {
        if (block.text === '##Setup Prompt') return '## セットアッププロンプト';
        if (block.text === '## User stories') return '## ユーザーストーリー';
        return 'テスト翻訳テキストです。';
      },
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 792,
      pageWidth: 612,
    });
    const placedSetup = placed.find((entry) => entry.block.text === '##Setup Prompt');
    const placedStories = placed.find((entry) => entry.block.text === '## User stories');
    expect(placedSetup?.paint).toBe(true);
    expect(placedStories?.paint).toBe(true);
  });

  it('caps left-column wrap width to the column and lets 10pt single-line bullets shrink to 6pt', () => {
    const lines = [
      ...staggeredTwoColumnLines(),
      // Left-column paragraph far below the right column must not wrap past the left column cap.
      makeLine('design/core_component_model.md, units in the UNITS/ folder,', 36, 480, 263, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    const bottomLeft = layout.blocks.find((block) =>
      block.text.includes('core_component_model.md'),
    )!;
    const bottomWrap = wrapWidth(bottomLeft, [], 612);
    expect(
      bottomLeft.box.x + paintLineLimit(bottomLeft, bottomWrap, bottomLeft.box.x, 612),
    ).toBeLessThanOrEqual(302);

    const placed = placePage({
      layout,
      translationOf: (block) =>
        block.text.includes('core_component_model.md')
          ? 'タスク：コンポーネント設計モデルを参照：design/core_component_model.md、UNITS/フォルダ内のユニット、'
          : 'テスト翻訳テキストです。',
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 792,
      pageWidth: 612,
    });
    const placedBottom = placed.find((entry) =>
      entry.block.text.includes('core_component_model.md'),
    )!;
    expect(placedBottom.paint).toBe(true);
    expect(clippedPaintWidth(placedBottom, measure)).toBeLessThanOrEqual(0.01);

    const tightBullet = fitText(
      {
        box: { x: 313, y: 130, width: 252, height: 10 },
        growBudget: 0.2,
        fontSize: 10,
        lineHeight: 1.2,
        width: 290,
        measure: (text, size) => text.length * size,
        role: 'prose',
      },
      '- クリーンでシンプル、かつ説明可能なコーディングのベストプラクティスに従ってください。',
      'ja',
    );
    expect(tightBullet.fits).toBe(true);
  });

  it('detects a top-left floatInset around an inline badge image and keeps left alignment', () => {
    const lines = [
      makeLine('A Unit represents a cohesive, self-contained', 93, 515, 206, 10),
      makeLine('element derived from an Intent, specifically', 36, 528, 263, 10),
      makeLine('designed to deliver measurable value across', 36, 540, 263, 10),
      makeLine('independent functional blocks in Scrum.', 36, 552, 263, 10),
    ];
    const layout = layoutPage(
      lines,
      { images: [{ x: 30, y: 489, width: 68, height: 41 }] },
      { width: 612, height: 792, index: 0 },
    );
    expect(layout.blocks).toHaveLength(1);
    const block = layout.blocks[0]!;
    expect(block.align).toBe('left');
    expect(block.floatInset).toBeDefined();
    expect(block.floatInset!.width).toBeCloseTo(56, 0);
    expect(block.floatInset!.height).toBeCloseTo(13, 0);

    const placed = placePage({
      layout,
      translationOf: () =>
        'ユニットとは、Intentから派生した、測定可能な価値を提供するために特別に設計された自己完結型の作業要素を指します。',
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 792,
      pageWidth: 612,
    });
    const entry = placed[0]!;
    expect(entry.paint).toBe(true);
    expect(entry.fit?.indentedLines).toBeGreaterThanOrEqual(1);
    expect(entry.fit?.indentWidth).toBeCloseTo(56, 0);
    const firstLine = entry.fit!.lines[0]!;
    expect(measure(firstLine, entry.fit!.fontSize)).toBeLessThanOrEqual(
      wrapBudget(entry.fit!.width - entry.fit!.indentWidth!) + 1e-6,
    );
  });

  it('does not set floatInset or right-align an ordinary first-line-indented justified paragraph', () => {
    const lines = [
      makeLine('The second paragraph begins with an indent', 60, 200, 239, 10),
      makeLine('and wraps cleanly back to the left margin', 36, 212, 263, 10),
      makeLine('while keeping its justified right edge.', 36, 224, 263, 10),
    ];
    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 0 });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0]!.align).toBe('left');
    expect(layout.blocks[0]!.floatInset).toBeUndefined();
  });

  it('handles a two-line floated-icon paragraph and multi-row tall icons without misaligning', () => {
    // 2-line paragraph beside a badge (like Page 3 Bolt): must stay left-aligned, not right-aligned.
    const twoLine = layoutPage(
      [
        makeLine('A Bolt is the smallest iteration in AI-DLC,', 64, 712, 235, 10),
        makeLine('designed for rapid implementation of a Unit.', 36, 725, 263, 10),
      ],
      { images: [{ x: 15, y: 671, width: 66, height: 67 }] },
      { width: 612, height: 792, index: 0 },
    );
    expect(twoLine.blocks).toHaveLength(1);
    expect(twoLine.blocks[0]!.align).toBe('left');
    expect(twoLine.blocks[0]!.floatInset).toBeDefined();

    // Tall icon spanning 2 opening lines before line 3 returns to the left margin.
    const tallIcon = layoutPage(
      [
        makeLine('First opening line beside the tall icon on the left', 96, 200, 203, 10),
        makeLine('second opening line also beside the same tall icon', 96, 212, 203, 10),
        makeLine('third line wraps underneath back to the left margin', 36, 224, 263, 10),
        makeLine('fourth line continues across the full left column.', 36, 236, 263, 10),
      ],
      { images: [{ x: 30, y: 192, width: 62, height: 30 }] },
      { width: 612, height: 792, index: 0 },
    );
    expect(tallIcon.blocks).toHaveLength(1);
    expect(tallIcon.blocks[0]!.floatInset?.height).toBeCloseTo(24, 0);

    // Non-overlapping image completely above the paragraph does not trigger floatInset.
    const nonOverlapping = layoutPage(
      [
        makeLine('Indented opening line far below an unrelated image', 60, 300, 239, 10),
        makeLine('second line at the normal left margin of the column', 36, 312, 263, 10),
        makeLine('third line at the normal left margin of the column.', 36, 324, 263, 10),
      ],
      { images: [{ x: 30, y: 100, width: 60, height: 40 }] },
      { width: 612, height: 792, index: 0 },
    );
    expect(nonOverlapping.blocks[0]!.floatInset).toBeUndefined();
  });

  it('keeps hanging-indented two-column list items left-aligned, whole, and fully covered on the right edge', () => {
    const lines = [
      // Upper band: staggered left/right hanging-indented list items, including a multi-piece justified row.
      makeLine('a.', 35.5, 363.8, 7.3, 10),
      makeLine(
        'AI analyzes metrics, logs, and traces to identify anomalies',
        53.5,
        363.8,
        245.3,
        10,
      ),
      makeLine('and predict potential SLA violations across services', 53.5, 376.1, 245.3, 10),
      makeLine(
        'while operators validate mitigations and monitor outcomes.',
        53.5,
        388.3,
        215.0,
        10,
      ),

      makeLine('a.', 312.0, 369.0, 7.3, 10),
      makeLine('AI', 330.0, 369.0, 8.3, 10),
      makeLine('elevates', 346.5, 369.0, 33.8, 10),
      makeLine('the', 388.5, 369.0, 13.6, 10),
      makeLine('codes', 410.2, 369.0, 23.7, 10),
      makeLine('into', 442.1, 369.0, 16.2, 10),
      makeLine('a', 466.4, 369.0, 4.8, 10),
      makeLine('higher-level', 479.4, 369.0, 48.1, 10),
      makeLine('modelling', 535.7, 369.0, 40.4, 10),
      makeLine('representation practiced as a group in real scenarios', 330.0, 381.2, 246.1, 10),
      makeLine('field offering called Unicorn Gym that packages this', 330.0, 393.4, 246.0, 10),
      makeLine(
        'approach for hyper-scaling adoption in large organizations.',
        330.0,
        405.6,
        239.4,
        10,
      ),

      // Lower band separated by a row gap: hanging list marker "b." at x=312..319.8 beside x=330..576.1.
      makeLine('V. BROWN-FIELD DEVELOPMENT', 36.0, 513.4, 218.3, 11, { bold: true }),
      makeLine(
        'Brown-field refers to making changes to an existing system',
        36.0,
        540.2,
        262.8,
        10,
      ),
      makeLine('in terms of adding new features or fixing technical debts', 36.0, 552.5, 262.8, 10),
      makeLine('including refactoring and fixing defects in production.', 36.0, 564.5, 262.8, 10),

      makeLine('b.', 312.0, 503.3, 7.8, 10),
      makeLine('By embedding the method in Developer Experience Tooling', 330.0, 503.3, 246.1, 10),
      makeLine('customers build orchestration tools across the lifecycle', 330.0, 540.2, 246.1, 10),
      makeLine('providing a unified experience for their developers', 330.0, 552.5, 246.1, 10),
      makeLine('without any need for significant adoption drives.', 330.0, 564.5, 210.0, 10),
    ];

    const layout = layoutPage(lines, { images: [] }, { width: 612, height: 792, index: 5 });

    const rightItemA = layout.blocks.find((block) => block.text.includes('higher-level modelling'));
    expect(rightItemA).toBeDefined();
    expect(rightItemA!.text.startsWith('a. AI elevates')).toBe(true);
    expect(rightItemA!.align).toBe('left');
    expect(rightItemA!.text).toContain('approach for hyper-scaling adoption');
    expect(layout.blocks.some((block) => block.text.trim() === 'a.')).toBe(false);

    const rightItemB = layout.blocks.find((block) =>
      block.text.includes('Developer Experience Tooling'),
    );
    expect(rightItemB).toBeDefined();
    expect(rightItemB!.text.startsWith('b. By embedding')).toBe(true);
    expect(rightItemB!.align).toBe('left');
    expect(layout.blocks.some((block) => block.text.trim() === 'b.')).toBe(false);

    const placed = placePage({
      layout,
      translationOf: () =>
        '実践による学習：ドキュメントや従来のトレーニングではなく、実務者が現在取り組んでいる複数のシナリオで実践します。',
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 792,
      pageWidth: 612,
    });
    for (const entry of placed) {
      if (!entry.paint || !entry.fit || !entry.drawn) continue;
      const paint = coverPaintLayout(
        entry.block,
        entry.fit.width,
        entry.drawn,
        DEFAULT_PAINT_SCALE,
        612,
      );
      const sourceRight = Math.max(...entry.block.lines.map((line) => line.box.x + line.box.width));
      expect(paint.x + paint.width).toBeGreaterThanOrEqual(sourceRight - 0.5);
    }
  });
});
