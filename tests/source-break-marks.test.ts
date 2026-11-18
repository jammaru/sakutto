import { describe, expect, it } from 'vitest';
import { classifyPlainTextBreak, preparePlainTextForModel } from '@/shared/plain-text-line-breaks';
import {
  rejoinSourceSegments,
  segmentSourceText,
  sourceBreakMarks,
  sourceBreakMarksFromSegments,
} from '@/shared/source-break-marks';

describe('source break marks', () => {
  it('keeps the source text identical through a segment round trip', () => {
    const samples = [
      '',
      'One line without a break.',
      'The cold morning began.\nHe opened the door.',
      'CRLF\r\nlines\r\nkeep\r\ntheir exact break.\r\n',
      'Old Mac CR only\rsplits on CR too\r',
      'Trailing newline\n',
      'Trailing CRLF\r\n',
      'Paragraph one.\n\nParagraph two.\n\n',
      '  \nLine with stray spaces. \n ',
      '\n\n\n',
      'A😀emoji line\nwith a surrogate pair.',
    ];
    for (const sample of samples) {
      const segments = segmentSourceText(sample);
      expect(rejoinSourceSegments(segments), JSON.stringify(sample)).toBe(sample);
    }
  });

  it('records the exact break characters per line', () => {
    expect(segmentSourceText('a\r\nb\nc')).toEqual([
      { text: 'a', lineBreak: '\r\n' },
      { text: 'b', lineBreak: '\n' },
      { text: 'c', lineBreak: '' },
    ]);
    expect(segmentSourceText('end\n')).toEqual([
      { text: 'end', lineBreak: '\n' },
      { text: '', lineBreak: '' },
    ]);
  });

  it('marks breaks between consecutive non-empty lines only', () => {
    const source = 'The cold morning air\nfilled the room.\n\nHe opened\nthe door.\n';
    const marks = sourceBreakMarks(source);
    expect(marks).toEqual([
      { lineIndex: 0, kind: 'mid-sentence' },
      { lineIndex: 3, kind: 'mid-sentence' },
    ]);
  });

  it('classifies marks with the same rule the translation uses', () => {
    const source = 'The cold morning began.\nThe cold morning air\nfilled the room.';
    const marks = sourceBreakMarks(source);
    expect(marks.map((mark) => mark.kind)).toEqual(['boundary', 'mid-sentence']);

    const prepared = preparePlainTextForModel(source);
    expect(prepared.breakMap.breaks.map((entry) => entry.kind)).toEqual([
      'boundary',
      'mid-sentence',
    ]);
    // The exposed classifier is the shared one, not a copy that can drift.
    expect(classifyPlainTextBreak('The cold morning air', 'filled the room.', 0)).toBe(
      'mid-sentence',
    );
    expect(classifyPlainTextBreak('The cold morning began.', 'The next one.', 0)).toBe('boundary');
  });

  it('adds no marks for blank-line paragraphs, trailing breaks, or empty input', () => {
    expect(sourceBreakMarks('One.\n\nTwo.')).toEqual([]);
    expect(sourceBreakMarks('Only one line.')).toEqual([]);
    expect(sourceBreakMarks('Trailing break.\n')).toEqual([]);
    expect(sourceBreakMarks('')).toEqual([]);
    expect(sourceBreakMarks('\n\n\n')).toEqual([]);
    expect(sourceBreakMarksFromSegments(segmentSourceText('  \n  '))).toEqual([]);
  });

  it('marks every consecutive pair of a long OCR-like paragraph', () => {
    const source = ['It was a cold morn-', 'ing, and she opened', 'the door slowly.'].join('\n');
    const marks = sourceBreakMarks(source);
    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.kind === 'mid-sentence')).toBe(true);
  });
});
