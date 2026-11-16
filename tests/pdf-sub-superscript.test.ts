import { describe, expect, it } from 'vitest';
import { extractPage, type PdfPage } from '@/pdf/extract';
import { groupByBaseline } from '@/pdf/gaps';
import { groupLines, lineFrom, type TextLine } from '@/pdf/lines';
import { layoutPage, type LayoutBlock } from '@/pdf/layout';
import { placePage } from '@/pdf/place';
import { formatScriptSlot, protectInlineMath, restoreInlineMath } from '@/pdf/protect';
import { openPdfBytes } from './support/open-fixture-pdf';
import { measure, piece } from './support/pdf-pieces';

function blockFromLines(lines: TextLine[]): LayoutBlock {
  const text = lines
    .map((line) => line.text)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return {
    text,
    lines,
    box: lines[0]?.box ?? { x: 0, y: 0, width: 100, height: 10 },
    fontSize: 10,
    lineHeight: 1.2,
    role: 'prose',
    align: 'left',
    bold: false,
    italic: false,
    column: 0,
    advance: 100,
    room: lines[0]?.box ?? { x: 0, y: 0, width: 100, height: 10 },
    writing: 0,
  } as LayoutBlock;
}

function bestBlock(lines: TextLine[]): LayoutBlock {
  const layout = layoutPage(lines, { images: [] }, { width: 595, height: 842, index: 1 });
  const block = layout.blocks[0];
  if (!block) throw new Error(`expected a block, got ${JSON.stringify(layout.skipped)}`);
  return block;
}

/** A minimal one-page PDF with a raised superscript and a lowered subscript. */
function scriptPdf(): Uint8Array {
  const content = [
    'BT',
    '/F1 10 Tf',
    '1 0 0 1 50 620 Tm',
    '(The concentration of CH) Tj',
    '/F1 7 Tf',
    '1 0 0 1 165 612 Tm',
    '(4) Tj',
    '/F1 10 Tf',
    '1 0 0 1 169 620 Tm',
    '( was much higher than expected.) Tj',
    '/F1 10 Tf',
    '1 0 0 1 50 600 Tm',
    '(The volume grew to 10) Tj',
    '/F1 7 Tf',
    '1 0 0 1 143 608 Tm',
    '(3) Tj',
    '/F1 10 Tf',
    '1 0 0 1 147 600 Tm',
    '( cubic metres in the tank.) Tj',
    'ET',
    '',
  ].join('\n');

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let length = 0;
  const push = (value: string): void => {
    const buffer = encoder.encode(value);
    parts.push(buffer);
    length += buffer.length;
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  offsets.set(3, length);
  push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  offsets.set(4, length);
  push(`4 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}endstream\nendobj\n`);
  offsets.set(5, length);
  push(
    '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  );
  offsets.set(2, length);
  push('2 0 obj\n<< /Type /Pages /Count 1 /Kids [5 0 R] >>\nendobj\n');
  offsets.set(1, length);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const xrefStart = length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let id = 1; id <= 5; id += 1) {
    xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`);

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

describe('PDF subscripts and superscripts', () => {
  it('keeps a small raised or lowered run on the row when it is grouped first', () => {
    const script = lineFrom([piece('12', 160, 195, 8, { size: 7, em: 7 })]);
    const body = lineFrom([piece('As reported in earlier work', 40, 200, 120)]);
    expect(groupByBaseline([script, body])).toHaveLength(1);

    const fullSizeMarker = lineFrom([piece('12', 160, 195.5, 8, { size: 10, em: 10 })]);
    expect(groupByBaseline([fullSizeMarker, body])).toHaveLength(1);

    const nextLine = lineFrom([piece('The next line of the paragraph.', 40, 212, 160)]);
    expect(groupByBaseline([body, nextLine])).toHaveLength(2);
  });

  it('joins a lowered subscript into the line and keeps its digit in the block', () => {
    const lines = groupLines([
      piece('The concentration of CH', 40, 200, 120),
      piece('4', 160, 204.5, 5, { size: 7, em: 7 }),
      piece(' was much higher than expected.', 165, 200, 220),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('The concentration of CH4 was much higher than expected.');

    const block = bestBlock(lines);
    expect(block.text).toContain('CH4');
    expect(block.role).toBe('prose');
  });

  it('joins a raised superscript reference marker even when it is not smaller type', () => {
    const lines = groupLines([
      piece('As reported in earlier work', 40, 200, 160),
      piece('12', 200, 196.5, 8, { size: 10, em: 10 }),
      piece(', the results agree well.', 208, 200, 140),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('work12');

    const block = bestBlock(lines);
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([{ text: '12', script: 'super' }]);
    const restored = restoreInlineMath('以前の研究 <i0> で報告されている。', protectedText.slots);
    expect(restored).toBe('以前の研究 ¹² で報告されている。');
    expect(restored).not.toMatch(/work12/u);
  });

  it('restores a chemical formula digit through the translated overlay text', () => {
    const lines = groupLines([
      piece('Methane emissions (CH', 40, 200, 125),
      piece('4', 165, 204.5, 5, { size: 7, em: 7 }),
      piece(') were measured in the chamber.', 170, 200, 190),
    ]);
    const block = bestBlock(lines);
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([{ text: '4', script: 'sub' }]);
    expect(protectedText.text).toContain('CH<i0>');

    const restored = restoreInlineMath(
      'メタン排出量（CH<i0>）をチャンバーで測定した。',
      protectedText.slots,
    );
    if (restored === null) throw new Error('expected the formula placeholder to restore');
    expect(restored).toContain('CH₄');
    expect(restored).not.toMatch(/CH4/u);

    const placed = placePage({
      layout: {
        blocks: [block],
        bodySize: 10,
        lineHeight: 12,
        skipped: [],
        pageHeight: 842,
        pageWidth: 595,
        pageIndex: 1,
        obstacles: [],
      },
      translationOf: () => restored,
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 842,
      pageWidth: 595,
    });
    expect(placed[0]?.translation).toContain('CH₄');
    expect(placed[0]?.fit?.lines.join('')).toContain('CH₄');
  });

  it('renders a superscript exponent as 10³ in the overlay, not flat 103', () => {
    const lines = groupLines([
      piece('The volume grew to 10', 40, 200, 130),
      piece('3', 170, 196.5, 5, { size: 7, em: 7 }),
      piece(' cubic metres in the tank.', 175, 200, 200),
    ]);
    const block = bestBlock(lines);
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual([{ text: '3', script: 'super' }]);

    const restored = restoreInlineMath('体積は10<i0>立方メートルに達した。', protectedText.slots);
    expect(restored).toBe('体積は10³立方メートルに達した。');
    expect(restored).not.toMatch(/103/u);

    const placed = placePage({
      layout: {
        blocks: [block],
        bodySize: 10,
        lineHeight: 12,
        skipped: [],
        pageHeight: 842,
        pageWidth: 595,
        pageIndex: 1,
        obstacles: [],
      },
      translationOf: () => restored ?? '',
      target: 'ja',
      measure: (_block, text, size) => measure(text, size),
      pageHeight: 842,
      pageWidth: 595,
    });
    const overlay = placed[0]?.translation ?? '';
    expect(overlay).toContain('10³');
    expect(overlay).not.toMatch(/103/u);
  });

  it('restores x², y₁, and H₂O-style subscripts as Unicode in the overlay', () => {
    const xSquared = groupLines([
      piece('Let x', 40, 200, 30),
      piece('2', 70, 199.2, 4, { size: 7, em: 7 }),
      piece(' + y', 74, 200, 20),
      piece('1', 94, 200.8, 4, { size: 7, em: 7 }),
      piece(' define the sample.', 98, 200, 120),
    ]);
    const xBlock = bestBlock(xSquared);
    const xProtected = protectInlineMath(xBlock);
    expect(xProtected.slots.map((slot) => slot.script)).toEqual(['super', 'sub']);
    const xRestored = restoreInlineMath('Let x<i0> + y<i1> が標本を定義する。', xProtected.slots);
    expect(xRestored).toContain('x²');
    expect(xRestored).toContain('y₁');

    const water = groupLines([
      piece('Water is ', 40, 200, 50),
      piece('H', 90, 200, 8),
      piece('2', 98, 200.8, 4, { size: 7, em: 7 }),
      piece('O', 102, 200, 8),
      piece(' in the vessel.', 110, 200, 90),
    ]);
    const waterBlock = bestBlock(water);
    const waterProtected = protectInlineMath(waterBlock);
    expect(waterProtected.slots).toHaveLength(1);
    expect(waterProtected.text).toMatch(/Water is <i0>/u);
    const waterRestored = restoreInlineMath('水は <i0> が入った容器です。', waterProtected.slots);
    expect(waterRestored).toContain('H₂O');
    expect(waterRestored).not.toMatch(/H2O/u);
  });

  it('keeps mid-line x² in place when the exponent sits on its own extracted line', () => {
    const prose = lineFrom([
      piece('Let x', 40, 200, 30),
      piece(' + y', 74, 200, 20),
      piece('1', 94, 200.8, 4, { size: 7, em: 7 }),
      piece(' = 1 define the sample.', 98, 200, 140),
    ]);
    const exponent = lineFrom([piece('2', 68, 199.2, 4, { size: 7, em: 7 })]);
    const block = blockFromLines([prose, exponent]);
    const protectedText = protectInlineMath(block);
    expect(protectedText.text).toMatch(/Let x<i\d+>/u);
    expect(protectedText.text).not.toMatch(/<i\d+>$/u);
    const restored = restoreInlineMath(
      'Let x<i0> + y<i1> = 1 が標本を定義する。',
      protectedText.slots,
    );
    expect(restored).toMatch(/Let x² \+ y₁/u);
    expect(restored).not.toMatch(/\s2\s*$/u);
  });

  it('renders trailing m³ on the same sentence as 10³', () => {
    const lines = groupLines([
      piece('The volume reached 10', 40, 200, 140),
      piece('3', 180, 196.5, 4, { size: 7, em: 7 }),
      piece(' m', 184, 200, 10),
      piece('3', 194, 196.5, 4, { size: 7, em: 7 }),
    ]);
    const block = bestBlock(lines);
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toHaveLength(2);
    expect(protectedText.text).toMatch(/10<i\d+> m<i\d+>/u);
    const restored = restoreInlineMath('体積は10<i0> m<i1>に達した。', protectedText.slots);
    expect(restored).toBe('体積は10³ m³に達した。');
    expect(restored).not.toMatch(/m3/u);
  });

  it('renders trailing m³ before a period without falling back to m3', () => {
    const lines = groupLines([
      piece('The volume reached 10', 40, 200, 140),
      piece('3', 180, 196.5, 4, { size: 7, em: 7 }),
      piece(' m', 184, 200, 10),
      piece('3.', 194, 196.5, 6, { size: 7, em: 7 }),
    ]);
    const block = bestBlock(lines);
    const protectedText = protectInlineMath(block);
    const restored = restoreInlineMath('体積は10<i0> m<i1>に達した。', protectedText.slots);
    expect(restored).toMatch(/m³/u);
    expect(restored).not.toMatch(/m3/u);
    expect(formatScriptSlot({ text: '3', script: 'super' })).toBe('³');
    expect(formatScriptSlot({ text: '3', script: 'super' })).not.toBe('3');
  });

  it('protects H₂O when pdf.js splits the letters across glyph runs', () => {
    const block = blockFromLines([
      lineFrom([piece('Water is written H', 40, 200, 120)]),
      lineFrom([piece('2', 160, 200.8, 4, { size: 7, em: 7 })]),
      lineFrom([piece('O in this vessel.', 164, 200, 120)]),
    ]);
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toHaveLength(1);
    expect(protectedText.text).toMatch(/written <i0>/u);
    const restored = restoreInlineMath('水は <i0> がこの容器に書かれた。', protectedText.slots);
    expect(restored).toContain('H₂O');
    expect(restored).not.toMatch(/H2O/u);
  });

  it('folds a trailing exponent line into prose before protecting', () => {
    const trailing = lineFrom([piece('3', 194, 196.5, 4, { size: 7, em: 7 })]);
    const prose = lineFrom([
      piece('The volume reached 10', 40, 200, 140),
      piece(' m', 184, 200, 10),
    ]);
    const block = blockFromLines([prose, trailing]);
    const protectedText = protectInlineMath(block);
    const restored = restoreInlineMath('体積は10 m<i0>に達した。', protectedText.slots);
    expect(restored).toContain('m³');
    expect(restored).not.toMatch(/m3/u);
  });

  it('keeps shifted scripts through layout and restoration on prose blocks', () => {
    const chemicalBlock = bestBlock(
      groupLines([
        piece('The concentration of CH', 40, 200, 120),
        piece('4', 160, 204.5, 5, { size: 7, em: 7 }),
        piece(' was much higher than expected.', 165, 200, 220),
      ]),
    );
    const chemicalProtected = protectInlineMath(chemicalBlock);
    expect(chemicalProtected.slots).toEqual([{ text: '4', script: 'sub' }]);
    const chemicalRestored = restoreInlineMath(
      '濃度 CH<i0> が予想より高かった。',
      chemicalProtected.slots,
    );
    expect(chemicalRestored).toContain('CH₄');

    const powerBlock = bestBlock(
      groupLines([
        piece('The volume grew to 10', 40, 200, 130),
        piece('3', 170, 196.5, 5, { size: 7, em: 7 }),
        piece(' cubic metres in the tank.', 175, 200, 200),
      ]),
    );
    const powerProtected = protectInlineMath(powerBlock);
    expect(powerProtected.slots).toEqual([{ text: '3', script: 'super' }]);
    const powerRestored = restoreInlineMath(
      '体積は10<i0>立方メートルになった。',
      powerProtected.slots,
    );
    expect(powerRestored).toContain('10³');
    expect(powerRestored).not.toMatch(/103/u);
  });

  it('extracts a synthetic PDF without dropping shifted script runs from the page', async () => {
    const document = await openPdfBytes(scriptPdf());
    try {
      const page = (await document.getPage(1)) as PdfPage;
      const extracted = await extractPage(page, 0, null);
      const joined = extracted.lines.map((line) => line.text).join(' ');
      expect(joined).toMatch(/CH/u);
      expect(joined).toMatch(/\b4\b/u);
      expect(joined).toMatch(/10/u);
      expect(joined.length).toBeGreaterThan(20);
    } finally {
      await document.loadingTask.destroy();
    }
  });

  it('keeps Unicode script digits in a source block unchanged', () => {
    const text = 'CH₄ and 10³ and x² and H₂O';
    const block = bestBlock(groupLines([piece(text, 40, 200, measure(text, 10))]));
    expect(block.text).toBe(text);
    expect(protectInlineMath(block).slots).toEqual([]);
  });

  it('leaves same-baseline small type as flat numbers in the overlay', () => {
    const cases = [
      {
        lines: groupLines([
          piece('See Table ', 40, 200, 60),
          piece('2', 105, 200, 4, { size: 7, em: 7 }),
          piece(' for results.', 109, 200, 80),
        ]),
        mock: '結果は表 2 を参照。',
        flat: '2',
      },
      {
        lines: groupLines([
          piece('Fig. ', 40, 200, 24),
          piece('3', 64, 200, 4, { size: 7, em: 7 }),
          piece(' shows the layout.', 68, 200, 100),
        ]),
        mock: '図 3 がレイアウトを示す。',
        flat: '3',
      },
      {
        lines: groupLines([
          piece('5 m', 40, 200, 24),
          piece('2', 64, 200, 4, { size: 7, em: 7 }),
          piece(' sample area.', 68, 200, 80),
        ]),
        mock: '5 m2 の面積。',
        flat: 'm2',
      },
      {
        lines: groupLines([piece('Equation (3) follows.', 40, 200, 120)]),
        mock: '式(3)が続く。',
        flat: '(3)',
      },
      {
        lines: groupLines([piece('Published in 2023 with updates.', 40, 200, 200)]),
        mock: '2023年に公開。',
        flat: '2023',
      },
      {
        lines: groupLines([piece('Samples from 10-20 mm depth.', 40, 200, 180)]),
        mock: '10-20 mm の深さ。',
        flat: '10-20',
      },
      {
        lines: groupLines([
          piece('Value ', 40, 200, 36),
          piece('0.48', 76, 200, 20, { size: 8, em: 8 }),
          piece(' ppm in the cell.', 96, 200, 100),
        ]),
        mock: 'セルでは 0.48 ppm。',
        flat: '0.48',
      },
    ] as const;

    for (const { lines, mock, flat } of cases) {
      const block = bestBlock(lines);
      const protectedText = protectInlineMath(block);
      expect(protectedText.slots).toEqual([]);
      const restored = restoreInlineMath(mock, protectedText.slots);
      expect(restored).toBe(mock);
      expect(restored).toContain(flat);
      expect(restored).not.toMatch(/[₀-₉⁰-⁹]/u);
    }
  });
});
