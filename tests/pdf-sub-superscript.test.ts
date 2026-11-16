import { describe, expect, it } from 'vitest';
import { extractPage, type PdfPage } from '@/pdf/extract';
import { groupByBaseline } from '@/pdf/gaps';
import { groupLines, lineFrom, type TextLine } from '@/pdf/lines';
import { layoutPage, type LayoutBlock } from '@/pdf/layout';
import { placePage } from '@/pdf/place';
import { protectInlineMath, restoreInlineMath } from '@/pdf/protect';
import { openPdfBytes } from './support/open-fixture-pdf';
import { measure, piece } from './support/pdf-pieces';

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
    '1 0 0 1 165 620 Tm',
    '(4) Tj',
    '/F1 10 Tf',
    '1 0 0 1 169 620 Tm',
    '( was much higher than expected.) Tj',
    '/F1 10 Tf',
    '1 0 0 1 50 600 Tm',
    '(The volume grew to 10) Tj',
    '/F1 7 Tf',
    '1 0 0 1 143 600 Tm',
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
    expect(protectedText.slots).toEqual(['12']);
    const restored = restoreInlineMath('以前の研究 <i0> で報告されている。', protectedText.slots);
    expect(restored).toBe('以前の研究 12 で報告されている。');
  });

  it('restores a chemical formula digit through the translated overlay text', () => {
    const lines = groupLines([
      piece('Methane emissions (CH', 40, 200, 125),
      piece('4', 165, 204.5, 5, { size: 7, em: 7 }),
      piece(') were measured in the chamber.', 170, 200, 190),
    ]);
    const block = bestBlock(lines);
    const protectedText = protectInlineMath(block);
    expect(protectedText.slots).toEqual(['4']);
    expect(protectedText.text).toContain('CH<i0>');

    const restored = restoreInlineMath(
      'メタン排出量（CH<i0>）をチャンバーで測定した。',
      protectedText.slots,
    );
    if (restored === null) throw new Error('expected the formula placeholder to restore');
    expect(restored).toContain('CH4');

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
    expect(placed[0]?.translation).toContain('CH4');
    expect(placed[0]?.fit?.lines.join('')).toContain('CH4');
  });

  it('keeps both scripts through extraction, layout, and restoration', async () => {
    const document = await openPdfBytes(scriptPdf());
    try {
      const page = (await document.getPage(1)) as PdfPage;
      const extracted = await extractPage(page, 0, null);
      const layout = layoutPage(extracted.lines, extracted.figures, {
        width: extracted.width,
        height: extracted.height,
        index: 0,
      });
      const text = layout.blocks.map((block) => block.text).join(' ');
      expect(text).toMatch(/CH\s*4/u);
      expect(text).toMatch(/10\s*3/u);

      for (const block of layout.blocks) {
        const chemical = /CH\s*4/u.test(block.text);
        const power = /10\s*3/u.test(block.text);
        if (!chemical && !power) continue;
        const protectedText = protectInlineMath(block);
        expect(protectedText.slots.length).toBeGreaterThan(0);
        const restored = restoreInlineMath(protectedText.text, protectedText.slots);
        expect(restored).not.toBeNull();
        expect(restored).toContain(chemical ? '4' : '3');
      }
    } finally {
      await document.destroy();
    }
  });

  it('keeps Unicode script digits in a source block unchanged', () => {
    const text = 'CH₄ and 10³ and x² and H₂O';
    const block = bestBlock(groupLines([piece(text, 40, 200, measure(text, 10))]));
    expect(block.text).toBe(text);
    expect(protectInlineMath(block).slots).toEqual([]);
  });
});
