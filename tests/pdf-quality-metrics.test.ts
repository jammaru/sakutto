import { describe, expect, it } from 'vitest';
import {
  countsAsProse,
  isProseLike,
  summarize,
  type QualityEntry,
  type QualityPage,
} from '../scripts/bench/pdf-quality-metrics.ts';

const box = { x: 0, y: 0, width: 100, height: 10 };

function entry(role: string, source: string, prose: boolean): QualityEntry {
  return {
    source,
    translation: '',
    role,
    box,
    painted: false,
    overflow: false,
    delivered: false,
    placeholders: 0,
    untranslated: true,
    mixedLanguage: false,
    garbled: [],
    scale: 1,
    prose,
  };
}

function page(entries: QualityEntry[]): QualityPage {
  return {
    fixture: 'scan',
    textSource: 'simulated-ocr',
    page: 1,
    entries,
    overlapPairs: 0,
    overflow: 0,
    shrunk: 0,
    untranslatedProse: entries.filter((item) => countsAsProse(item) && item.untranslated).length,
    proseBlocks: entries.filter(countsAsProse).length,
    skippedProse: entries.filter(
      (item) => countsAsProse(item) && !/^(prose|heading|caption|cell)$/u.test(item.role),
    ).length,
    readingOrder: 1,
    twoColumn: true,
    firstBlockMs: 0,
    pageMs: 0,
  };
}

describe('PDF quality metrics', () => {
  it('recognises prose hidden in a skipped code block but not a source listing', () => {
    expect(
      isProseLike(
        'model. Section 2 describes the runtime, Section 3 the schedul‐ 3 emit(translate(block))',
      ),
    ).toBe(true);
    expect(
      isProseLike(
        '1 for block in page: 2 if is_equation(block): continue 3 emit(translate(block))',
      ),
    ).toBe(false);
    expect(isProseLike('MultiHead(Q, K, V ) = Concat(head1, ..., headh)W O')).toBe(false);
  });

  it('counts skipped prose in the untranslated prose denominator', () => {
    const entries = [
      entry('prose', 'First paragraph is translated.', true),
      entry('prose', 'Second paragraph is translated.', true),
      entry('code', 'Section 2 describes the runtime and the scheduler.', true),
    ];
    entries[0]!.untranslated = false;
    entries[1]!.untranslated = false;
    const summary = summarize([page(entries)], 0, 0);
    expect(summary.skippedProseBlocks).toBe(1);
    expect(summary.proseBlocks).toBe(3);
    expect(summary.untranslatedProseRate).toBeCloseTo(1 / 3);
  });

  it('falls back to roles for reports recorded before the prose flag existed', () => {
    const old = { role: 'prose' } as Pick<QualityEntry, 'role' | 'prose'>;
    expect(countsAsProse(old)).toBe(true);
    expect(countsAsProse({ role: 'code' })).toBe(false);
  });
});
