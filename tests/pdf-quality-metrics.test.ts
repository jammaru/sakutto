import { describe, expect, it } from 'vitest';
import {
  countsAsProse,
  entryGarbledTokens,
  garbledTokens,
  isMixedLanguage,
  isProseLike,
  normalizeText,
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

  it('detects ligature and soft-hyphen defects on raw source before normalization', () => {
    const raw = 'e\ufb03cient and soft\u00adhyphen';
    expect(normalizeText(raw)).toBe('efficient and softhyphen');
    // Once normalized the raw defect is unreachable; the entry metric must use the raw string.
    expect(garbledTokens(normalizeText(raw))).toEqual([]);
    expect(garbledTokens(raw)).toEqual(['\ufb03', '\u00ad']);
    expect(entryGarbledTokens(raw, '', false)).toEqual(['\ufb03', '\u00ad']);
    expect(entryGarbledTokens(raw, raw, true)).toEqual(['\ufb03', '\u00ad', '\ufb03', '\u00ad']);
    expect(entryGarbledTokens(raw, raw, false)).toHaveLength(2);
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

  it('reports the earliest per-page first block separately from the run-level arrival', () => {
    const entries = [entry('prose', 'A translated paragraph.', true)];
    const pages = [
      { ...page(entries), firstBlockMs: 12 },
      { ...page(entries), firstBlockMs: 5 },
      { ...page(entries), firstBlockMs: 8 },
    ];
    const summary = summarize(pages, 313, 917);
    expect(summary.firstTranslatedBlockMs).toBe(5);
    expect(summary.firstTranslatedBlockFromRunStartMs).toBe(313);
    expect(summarize([], 0, 0).firstTranslatedBlockMs).toBe(0);
  });

  it('falls back to roles for reports recorded before the prose flag existed', () => {
    const old = { role: 'prose' } as Pick<QualityEntry, 'role' | 'prose'>;
    expect(countsAsProse(old)).toBe(true);
    expect(countsAsProse({ role: 'code' })).toBe(false);
  });
});

describe('honest quality denominators', () => {
  it('does not flag a correctly spaced formula as garbled', () => {
    expect(garbledTokens('Q ∈ R d model × d k')).toEqual([]);
    expect(garbledTokens('MultiHead(Q, K, V ) = Concat(head)')).toEqual([]);
  });

  it('counts short headings as skipped prose but not code', () => {
    expect(isProseLike('References')).toBe(true);
    expect(isProseLike('Abstract')).toBe(true);
    expect(isProseLike('We win.')).toBe(true);
    expect(isProseLike('maxSegmentTokens')).toBe(false);
    expect(isProseLike('1 for block in page:')).toBe(false);
    expect(isProseLike('for block in page:')).toBe(false);
    expect(isProseLike('if is_equation(block):')).toBe(false);
    expect(isProseLike('Section 2 describes the runtime:')).toBe(true);
    expect(isProseLike('For each batch: we compute the loss and update')).toBe(true);
    expect(isProseLike('If the input is empty: we return zero')).toBe(true);
    expect(isProseLike('While the model trains: the logs are written')).toBe(true);
    expect(isProseLike('概要')).toBe(true);
    expect(isProseLike('参考文献')).toBe(true);
    expect(isProseLike('1. はじめに')).toBe(true);
    expect(isProseLike('図 1')).toBe(false);
  });

  it('does not call isolated identifiers a language switch', () => {
    expect(
      isMixedLanguage(
        '語語モデルである0.8-billion-parameterとtensor2tensor、sakutto@example.org。',
      ),
    ).toBe(false);
    expect(isMixedLanguage('これはまだ This is still English です。')).toBe(true);
  });
});
